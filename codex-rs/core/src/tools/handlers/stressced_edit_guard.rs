use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use chrono::Utc;
use regex_lite::Regex;

const MAX_SNAPSHOT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TARGETS_PER_COMMAND: usize = 8;
const LARGE_CHANGE_RATIO: f64 = 0.35;
const LARGE_CHANGE_MIN_BYTES: usize = 512;

pub(crate) struct StresscedEditGuard {
    command_indicators: Vec<&'static str>,
    backup_root: PathBuf,
    snapshots: Vec<FileSnapshot>,
}

struct FileSnapshot {
    path: PathBuf,
    before: Vec<u8>,
}

struct FileChangeNotice {
    path: PathBuf,
    backup_path: Option<PathBuf>,
    backup_error: Option<String>,
    changed_bytes: usize,
    changed_ratio: f64,
    before_len: usize,
    after_len: usize,
    before_lines: usize,
    after_lines: usize,
}

impl StresscedEditGuard {
    pub(crate) fn capture(command: &str, cwd: &Path, codex_home: &Path, call_id: &str) -> Self {
        let command_indicators = command_indicators(command);
        if command_indicators.is_empty() {
            return Self::empty();
        }

        let mut snapshots = Vec::new();
        for path in extract_source_paths(command, cwd)
            .into_iter()
            .take(MAX_TARGETS_PER_COMMAND)
        {
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if !metadata.is_file() || metadata.len() > MAX_SNAPSHOT_BYTES {
                continue;
            }
            let Ok(before) = fs::read(&path) else {
                continue;
            };
            snapshots.push(FileSnapshot { path, before });
        }

        let timestamp = Utc::now().format("%Y%m%d-%H%M%S%.3f");
        let backup_root = codex_home
            .join("stressced-file-backups")
            .join(format!("{timestamp}-{}", sanitize_path_fragment(call_id)));

        Self {
            command_indicators,
            backup_root,
            snapshots,
        }
    }

    fn empty() -> Self {
        Self {
            command_indicators: Vec::new(),
            backup_root: PathBuf::new(),
            snapshots: Vec::new(),
        }
    }

    pub(crate) fn finish(self) -> Option<String> {
        if self.snapshots.is_empty() {
            return None;
        }

        let mut notices = Vec::new();
        for snapshot in self.snapshots {
            let Ok(after) = fs::read(&snapshot.path) else {
                continue;
            };
            if after == snapshot.before {
                continue;
            }

            let (backup_path, backup_error) =
                write_backup(&self.backup_root, &snapshot.path, &snapshot.before);
            let changed_bytes = changed_byte_count(&snapshot.before, &after);
            let before_len = snapshot.before.len();
            let after_len = after.len();
            let denominator = before_len.max(after_len).max(1);
            let changed_ratio = changed_bytes as f64 / denominator as f64;
            notices.push(FileChangeNotice {
                path: snapshot.path,
                backup_path,
                backup_error,
                changed_bytes,
                changed_ratio,
                before_len,
                after_len,
                before_lines: count_lines(&snapshot.before),
                after_lines: count_lines(&after),
            });
        }

        if notices.is_empty() {
            return None;
        }

        Some(format_notice(&self.command_indicators, &notices))
    }
}

fn command_indicators(command: &str) -> Vec<&'static str> {
    let lower = command.to_ascii_lowercase();
    let mut indicators = Vec::new();
    if lower.contains("set-content") {
        indicators.push("Set-Content");
    }
    if lower.contains("out-file") {
        indicators.push("Out-File");
    }
    if lower.contains(" -replace ") || lower.contains("`n-replace ") {
        indicators.push("regex replace");
    }
    if command.contains("@\"") || command.contains("@'") {
        indicators.push("PowerShell here-string");
    }
    if command.contains('>') {
        indicators.push("shell redirection");
    }
    indicators.sort_unstable();
    indicators.dedup();
    indicators
}

fn extract_source_paths(command: &str, cwd: &Path) -> Vec<PathBuf> {
    let mut paths = BTreeSet::new();
    if let Ok(quoted) = Regex::new(r#"['"]([^'"\r\n]+)['"]"#) {
        for captures in quoted.captures_iter(command) {
            if let Some(path) = candidate_path(captures.get(1).map(|m| m.as_str()), cwd) {
                paths.insert(normalize_existing_path(path));
            }
        }
    }

    if let Ok(absolute) = Regex::new(r#"[A-Za-z]:[\\/][^\s'"|<>]+"#) {
        for captures in absolute.captures_iter(command) {
            if let Some(path) = candidate_path(captures.get(0).map(|m| m.as_str()), cwd) {
                paths.insert(normalize_existing_path(path));
            }
        }
    }

    for token in command.split(is_token_boundary) {
        if let Some(path) = candidate_path(Some(token), cwd) {
            paths.insert(normalize_existing_path(path));
        }
    }

    paths.into_iter().collect()
}

fn is_token_boundary(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '|' | ';' | ',' | '(' | ')' | '[' | ']' | '{' | '}')
}

fn candidate_path(raw: Option<&str>, cwd: &Path) -> Option<PathBuf> {
    let raw = raw?;
    let trimmed = raw.trim().trim_matches(|ch| {
        matches!(
            ch,
            '"' | '\'' | '`' | ',' | ';' | ')' | '(' | '[' | ']' | '{' | '}'
        )
    });
    if trimmed.is_empty()
        || trimmed.contains('$')
        || trimmed.contains('*')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
    {
        return None;
    }

    let path = PathBuf::from(trimmed);
    if !is_source_like_path(&path) {
        return None;
    }

    if path.is_absolute() {
        Some(path)
    } else {
        Some(cwd.join(path))
    }
}

fn is_source_like_path(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "c" | "cc"
            | "cpp"
            | "cxx"
            | "h"
            | "hh"
            | "hpp"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "json"
            | "toml"
            | "yaml"
            | "yml"
            | "rc"
            | "manifest"
            | "cs"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "swift"
            | "css"
            | "html"
            | "xml"
            | "ps1"
    )
}

fn normalize_existing_path(path: PathBuf) -> PathBuf {
    fs::canonicalize(&path).unwrap_or(path)
}

fn write_backup(
    backup_root: &Path,
    original_path: &Path,
    contents: &[u8],
) -> (Option<PathBuf>, Option<String>) {
    if let Err(err) = fs::create_dir_all(backup_root) {
        return (
            None,
            Some(format!(
                "failed to create backup directory {}: {err}",
                backup_root.display()
            )),
        );
    }

    let backup_path = backup_root.join(format!(
        "{}.bak",
        sanitize_path_fragment(&original_path.to_string_lossy())
    ));
    match fs::write(&backup_path, contents) {
        Ok(()) => (Some(backup_path), None),
        Err(err) => (
            None,
            Some(format!(
                "failed to write backup {}: {err}",
                backup_path.display()
            )),
        ),
    }
}

fn changed_byte_count(before: &[u8], after: &[u8]) -> usize {
    let prefix = before
        .iter()
        .zip(after.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let before_tail = &before[prefix..];
    let after_tail = &after[prefix..];
    let suffix = before_tail
        .iter()
        .rev()
        .zip(after_tail.iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    before_tail
        .len()
        .saturating_sub(suffix)
        .max(after_tail.len().saturating_sub(suffix))
}

fn count_lines(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    bytes.iter().filter(|byte| **byte == b'\n').count() + 1
}

fn format_notice(indicators: &[&str], notices: &[FileChangeNotice]) -> String {
    let mut lines = Vec::new();
    lines.push("CodexStressCed file safety notice:".to_string());
    lines.push(format!(
        "- Detected risky shell edit pattern(s): {}.",
        indicators.join(", ")
    ));
    lines.push("- Backups were saved before the command changed source-like files.".to_string());

    for notice in notices {
        let large_change = notice.changed_ratio >= LARGE_CHANGE_RATIO
            && notice.changed_bytes >= LARGE_CHANGE_MIN_BYTES;
        let large_marker = if large_change { " LARGE CHANGE" } else { "" };
        lines.push(format!(
            "- {}:{} changed {} bytes ({:.0}% of file), size {} -> {} bytes, lines {} -> {}.",
            notice.path.display(),
            large_marker,
            notice.changed_bytes,
            notice.changed_ratio * 100.0,
            notice.before_len,
            notice.after_len,
            notice.before_lines,
            notice.after_lines
        ));
        if let Some(backup_path) = &notice.backup_path {
            lines.push(format!("  Backup: {}", backup_path.display()));
        }
        if let Some(error) = &notice.backup_error {
            lines.push(format!("  Backup warning: {error}"));
        }
    }

    lines.push(
        "- If this was not intentional, stop broad rewrites and switch to a targeted patch or restore from the backup."
            .to_string(),
    );
    lines.join("\n")
}

fn sanitize_path_fragment(value: &str) -> String {
    let mut sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();

    if sanitized.len() > 180 {
        let keep_from = sanitized.len() - 180;
        sanitized = sanitized[keep_from..].to_string();
    }
    sanitized.trim_matches('_').to_string()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn extracts_relative_source_target_from_set_content() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        let path = cwd.join("timeres.c");
        fs::write(&path, "int main(void) { return 0; }\n").expect("write source");

        let paths = extract_source_paths(
            r#"$c = "hello"; Set-Content -Path "timeres.c" -Value $c"#,
            cwd,
        );

        assert_eq!(paths, vec![normalize_existing_path(path)]);
    }

    #[test]
    fn captures_backup_and_reports_large_rewrite() {
        let temp = tempdir().expect("tempdir");
        let codex_home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).expect("create project");
        let source = cwd.join("timeres.c");
        let before = (0..100)
            .map(|index| format!("int value_{index} = {index};\n"))
            .collect::<String>();
        fs::write(&source, before).expect("write source");

        let guard = StresscedEditGuard::capture(
            r#"@"
new content
"@ | Set-Content -Path "timeres.c" -NoNewline"#,
            &cwd,
            &codex_home,
            "call-1",
        );
        let after = (0..100)
            .map(|index| format!("char text_{index}[] = \"rewritten\";\n"))
            .collect::<String>();
        fs::write(&source, after).expect("rewrite source");

        let notice = guard.finish().expect("notice");

        assert!(notice.contains("CodexStressCed file safety notice"));
        assert!(notice.contains("LARGE CHANGE"));
        assert!(notice.contains("Backup:"));
        let backups = fs::read_dir(codex_home.join("stressced-file-backups"))
            .expect("read backups")
            .count();
        assert_eq!(backups, 1);
    }
}
