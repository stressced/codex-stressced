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
const LARGE_INLINE_REWRITE_COMMAND_BYTES: usize = 4096;
const EMBEDDED_SCRIPT_REWRITE_COMMAND_BYTES: usize = 1000;

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
    pub(crate) fn block_reason(command: &str, cwd: &Path) -> Option<String> {
        if let Some(reason) = command_usage_block_reason(command) {
            return Some(reason);
        }

        let mut indicators = command_indicators(command);
        let python_direct_source_write = command_invokes_python(command)
            && !script_write_source_targets(command, cwd).is_empty();
        if python_direct_source_write {
            indicators.push("Python direct source write");
            indicators.sort_unstable();
            indicators.dedup();
        }
        if indicators.is_empty() {
            return None;
        }

        let targets = existing_source_write_targets(command, cwd);
        if targets.is_empty() {
            return None;
        }

        let direct_rewrite = indicators.iter().any(|indicator| {
            matches!(
                *indicator,
                "Set-Content"
                    | "Out-File"
                    | "Add-Content"
                    | "shell redirection"
                    | "python inline script"
                    | "Python direct source write"
                    | "WriteAllText"
            )
        });
        let embedded_script = indicators.iter().any(|indicator| {
            matches!(
                *indicator,
                "PowerShell here-string" | "shell heredoc" | "python inline script"
            )
        });
        let large_inline_rewrite = command.len() >= LARGE_INLINE_REWRITE_COMMAND_BYTES;
        let embedded_rewrite =
            embedded_script && command.len() >= EMBEDDED_SCRIPT_REWRITE_COMMAND_BYTES;

        if direct_rewrite || large_inline_rewrite || embedded_rewrite {
            return Some(format_block_notice(&indicators, &targets));
        }

        None
    }

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

fn command_usage_block_reason(command: &str) -> Option<String> {
    if command.contains("@'") || command.contains("@\"") || command.contains("<<") {
        return None;
    }

    let tokens = command_usage_tokens(&command.to_ascii_lowercase());
    let mut issues = Vec::new();

    if tokens_contain_command(&tokens, |token| token == "head") {
        issues.push(
            "- Unix `head` is not available in this PowerShell workspace. Use `... | Select-Object -First N` instead.",
        );
    }

    if rg_tokens_contain(&tokens, |token| matches!(token, "-rn" | "-nr")) {
        issues.push(
            "- For ripgrep line numbers, use `rg -n \"pattern\" path`. Do not use `rg -rn`; `-r` is ripgrep replacement mode.",
        );
    }

    if rg_tokens_contain(&tokens, |token| {
        token == "--include" || token.starts_with("--include=")
    }) {
        issues.push(
            "- This ripgrep build does not accept `--include`. Use `-g \"glob\"` or search a narrower path instead.",
        );
    }

    if issues.is_empty() {
        return None;
    }

    let mut lines = Vec::new();
    lines.push(
        "CodexStressCed shell preflight block: command was not run because it uses a tool pattern that repeatedly fails in this Windows PowerShell workspace."
            .to_string(),
    );
    lines.extend(issues.into_iter().map(str::to_string));
    lines.push(
        "- Correct the command once and retry; do not switch to broad file rewrites or alternate quoting styles."
            .to_string(),
    );
    Some(lines.join("\n"))
}

fn command_usage_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if quote.is_some_and(|quote| ch == quote) {
            quote = None;
            continue;
        }
        if quote.is_some() {
            continue;
        }
        if matches!(ch, '"' | '\'') {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        if matches!(ch, '|' | ';' | '&') {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            let mut op = ch.to_string();
            if matches!(ch, '|' | '&') && chars.peek().is_some_and(|next| *next == ch) {
                op.push(ch);
                chars.next();
            }
            tokens.push(op);
            continue;
        }
        current.push(ch);
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn tokens_contain_command(tokens: &[String], predicate: impl Fn(&str) -> bool) -> bool {
    let mut expects_command = true;
    for token in tokens {
        if is_command_separator(token) {
            expects_command = true;
            continue;
        }
        if expects_command && token == "&" {
            continue;
        }
        if expects_command && predicate(token) {
            return true;
        }
        expects_command = false;
    }
    false
}

fn rg_tokens_contain(tokens: &[String], predicate: impl Fn(&str) -> bool) -> bool {
    let mut expects_command = true;
    for (index, token) in tokens.iter().enumerate() {
        if is_command_separator(token) {
            expects_command = true;
            continue;
        }
        if expects_command && token == "&" {
            continue;
        }
        if !expects_command || !matches!(token.as_str(), "rg" | "rg.exe") {
            expects_command = false;
            continue;
        }

        for token in &tokens[index + 1..] {
            if is_command_separator(token) {
                break;
            }
            if predicate(token) {
                return true;
            }
        }

        expects_command = false;
    }
    false
}

fn is_command_separator(token: &str) -> bool {
    matches!(token, "|" | ";" | "&&" | "||")
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
    if lower.contains("add-content") {
        indicators.push("Add-Content");
    }
    if lower.contains(" -replace ") || lower.contains("`n-replace ") {
        indicators.push("regex replace");
    }
    if command.contains("@\"") || command.contains("@'") {
        indicators.push("PowerShell here-string");
    }
    if command.contains("<<") {
        indicators.push("shell heredoc");
    }
    if lower.contains("python -c") || lower.contains("python3 -c") || lower.contains("py -c") {
        indicators.push("python inline script");
    }
    if lower.contains("writealltext") {
        indicators.push("WriteAllText");
    }
    if command.contains('>') {
        indicators.push("shell redirection");
    }
    indicators.sort_unstable();
    indicators.dedup();
    indicators
}

fn existing_source_write_targets(command: &str, cwd: &Path) -> Vec<PathBuf> {
    let mut targets = BTreeSet::new();
    let use_script_targets =
        command_invokes_python(command) || command.to_ascii_lowercase().contains("writealltext");
    for path in powershell_write_source_targets(command, cwd)
        .into_iter()
        .chain(shell_redirection_source_targets(command, cwd))
        .chain(
            use_script_targets
                .then(|| script_write_source_targets(command, cwd))
                .unwrap_or_default(),
        )
    {
        if matches!(fs::metadata(&path), Ok(metadata) if metadata.is_file()) {
            targets.insert(normalize_existing_path(path));
        }
    }
    targets.into_iter().take(MAX_TARGETS_PER_COMMAND).collect()
}

fn command_invokes_python(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let tokens = shell_like_tokens(&lower);
    tokens
        .iter()
        .any(|token| matches!(token.as_str(), "python" | "python3" | "py"))
        || lower.contains("| python")
        || lower.contains("| python3")
        || lower.contains("| py")
}

fn powershell_write_source_targets(command: &str, cwd: &Path) -> Vec<PathBuf> {
    let mut targets = BTreeSet::new();
    for segment in command.split('|') {
        let tokens = shell_like_tokens(segment);
        for (index, token) in tokens.iter().enumerate() {
            let lower = token.to_ascii_lowercase();
            let path_flags: &[&str] = match lower.as_str() {
                "set-content" | "add-content" => &["-literalpath", "-path"],
                "out-file" => &["-literalpath", "-filepath", "-path"],
                _ => continue,
            };

            let mut found_flag_target = false;
            for pair in tokens[index + 1..].windows(2) {
                if path_flags.contains(&pair[0].to_ascii_lowercase().as_str()) {
                    if let Some(path) = candidate_path(Some(&pair[1]), cwd) {
                        targets.insert(normalize_existing_path(path));
                        found_flag_target = true;
                    }
                }
            }

            if !found_flag_target {
                for candidate in &tokens[index + 1..] {
                    if candidate.starts_with('-') {
                        continue;
                    }
                    if let Some(path) = candidate_path(Some(candidate), cwd) {
                        targets.insert(normalize_existing_path(path));
                        break;
                    }
                }
            }
        }
    }
    targets.into_iter().take(MAX_TARGETS_PER_COMMAND).collect()
}

fn shell_like_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in value.chars() {
        if quote.is_some_and(|quote| ch == quote) {
            quote = None;
            continue;
        }
        if quote.is_none() && matches!(ch, '"' | '\'') {
            quote = Some(ch);
            continue;
        }
        if quote.is_none() && ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn shell_redirection_source_targets(command: &str, cwd: &Path) -> Vec<PathBuf> {
    let mut targets = BTreeSet::new();
    let chars = command.char_indices().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if ch != '>' {
            index += 1;
            continue;
        }

        let previous = command[..byte_index].chars().next_back();
        if previous == Some('=') {
            index += 1;
            continue;
        }

        let mut cursor = index + 1;
        while cursor < chars.len() && chars[cursor].1 == '>' {
            cursor += 1;
        }
        if cursor < chars.len() && chars[cursor].1 == '=' {
            index = cursor + 1;
            continue;
        }
        while cursor < chars.len() && chars[cursor].1.is_whitespace() {
            cursor += 1;
        }
        if cursor >= chars.len() {
            break;
        }

        let quote = matches!(chars[cursor].1, '"' | '\'').then_some(chars[cursor].1);
        if quote.is_some() {
            cursor += 1;
        }
        let start = cursor;
        if start >= chars.len() {
            break;
        }
        while cursor < chars.len() {
            let current = chars[cursor].1;
            if quote.is_some_and(|quote| current == quote)
                || (quote.is_none()
                    && (current.is_whitespace() || matches!(current, '|' | '<' | '>')))
            {
                break;
            }
            cursor += 1;
        }

        let end = chars.get(cursor).map_or(command.len(), |(index, _)| *index);
        if let Some(path) = candidate_path(command.get(chars[start].0..end), cwd)
            && matches!(fs::metadata(&path), Ok(metadata) if metadata.is_file())
        {
            targets.insert(normalize_existing_path(path));
        }
        index = cursor + 1;
    }

    targets.into_iter().take(MAX_TARGETS_PER_COMMAND).collect()
}

fn script_write_source_targets(command: &str, cwd: &Path) -> Vec<PathBuf> {
    let mut targets = BTreeSet::new();
    if let Ok(open_write) = Regex::new(
        r#"open\(\s*[rRuUbBfF]*['"]([^'"\r\n]+)['"]\s*,\s*[rRuUbBfF]*['"][^'"\r\n]*[wa][^'"\r\n]*['"]"#,
    ) {
        for captures in open_write.captures_iter(command) {
            if let Some(path) = candidate_path(captures.get(1).map(|match_| match_.as_str()), cwd) {
                targets.insert(normalize_existing_path(path));
            }
        }
    }
    if let Ok(pathlib_write) = Regex::new(
        r#"(?:Path|pathlib\.Path)\(\s*[rRuUbBfF]*['"]([^'"\r\n]+)['"]\s*\)\.write_(?:text|bytes)\s*\("#,
    ) {
        for captures in pathlib_write.captures_iter(command) {
            if let Some(path) = candidate_path(captures.get(1).map(|match_| match_.as_str()), cwd) {
                targets.insert(normalize_existing_path(path));
            }
        }
    }
    if let Ok(write_all_text) = Regex::new(r#"WriteAllText\(\s*['"]([^'"\r\n]+)['"]"#) {
        for captures in write_all_text.captures_iter(command) {
            if let Some(path) = candidate_path(captures.get(1).map(|match_| match_.as_str()), cwd) {
                targets.insert(normalize_existing_path(path));
            }
        }
    }
    targets.into_iter().take(MAX_TARGETS_PER_COMMAND).collect()
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
            | "md"
            | "markdown"
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

fn format_block_notice(indicators: &[&str], targets: &[PathBuf]) -> String {
    let mut lines = Vec::new();
    lines.push(
        "CodexStressCed file safety block: refused a broad shell rewrite of existing source-like file(s)."
            .to_string(),
    );
    lines.push(format!(
        "- Detected risky shell edit pattern(s): {}.",
        indicators.join(", ")
    ));
    lines.push(
        "- Python is allowed for reading, analysis, calculations, and generating snippets; do not use it as a direct writer for existing source files."
            .to_string(),
    );
    lines.push(
        "- For existing source edits, use `safe_edit_replace_exact`, `safe_edit_insert_before`, `safe_edit_insert_after`, or `$env:APPLY_PATCH` with a targeted patch."
            .to_string(),
    );
    lines.push(
        "- Large `safe_edit_create_file` remains acceptable for brand-new files; inspect existing files and edit only the required block."
            .to_string(),
    );
    lines.push("- Existing target(s):".to_string());
    for target in targets {
        lines.push(format!("  - {}", target.display()));
    }
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

    #[test]
    fn blocks_unix_head_with_powershell_hint() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(
            r#"rg "LoopbackControlRuntime" tests -n | head -20"#,
            temp.path(),
        )
        .expect("block reason");

        assert!(reason.contains("shell preflight block"));
        assert!(reason.contains("Select-Object -First N"));
    }

    #[test]
    fn blocks_unix_head_without_pipe_spacing() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(
            r#"rg "LoopbackControlRuntime" tests -n|head -20"#,
            temp.path(),
        )
        .expect("block reason");

        assert!(reason.contains("Select-Object -First N"));
    }

    #[test]
    fn blocks_rg_rn_with_line_number_hint() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(
            r#"rg "ControlCommandAuthorizationPolicy::authorize" src/ -rn | Select-Object -First 5"#,
            temp.path(),
        )
        .expect("block reason");

        assert!(reason.contains("rg -n"));
        assert!(reason.contains("replacement mode"));
    }

    #[test]
    fn blocks_rg_include_with_glob_hint() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(
            r#"rg "QueryState" --include "*.cpp" tests"#,
            temp.path(),
        )
        .expect("block reason");

        assert!(reason.contains("does not accept `--include`"));
        assert!(reason.contains("-g \"glob\""));
    }

    #[test]
    fn blocks_rg_include_equals_with_glob_hint() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(
            r#"rg "QueryState" --include="*.cpp" tests"#,
            temp.path(),
        )
        .expect("block reason");

        assert!(reason.contains("does not accept `--include`"));
        assert!(reason.contains("-g \"glob\""));
    }

    #[test]
    fn allows_power_shell_first_limit_and_rg_line_numbers() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(
            r#"rg -n "LoopbackControlRuntime" tests | Select-Object -First 20"#,
            temp.path(),
        );

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_rg_search_for_head_literal() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(r#"rg "head" src tests"#, temp.path());

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_write_output_exact_head_literal() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(r#"Write-Output "head""#, temp.path());

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_quoted_rg_rn_instruction_that_is_not_a_command() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(
            r#"Write-Output "Do not run rg pattern path -rn""#,
            temp.path(),
        );

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_quoted_head_text_that_is_not_a_command() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(
            r#"Write-Output "Use rg -n pattern path | head -20 only in Bash docs""#,
            temp.path(),
        );

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_here_string_text_that_mentions_head() {
        let temp = tempdir().expect("tempdir");

        let reason = StresscedEditGuard::block_reason(
            r#"@'
Use `rg -n pattern path | head -20` only in Bash docs.
'@ | Set-Content -LiteralPath 'notes.md' -Encoding utf8"#,
            temp.path(),
        );

        assert_eq!(reason, None);
    }

    #[test]
    fn blocks_shell_rewrite_of_existing_source_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        let source = cwd.join("timeres.c");
        fs::write(&source, "int main(void) { return 0; }\n").expect("write source");

        let reason = StresscedEditGuard::block_reason(
            r#"@"
int main(void) { return 1; }
"@ | Set-Content -LiteralPath "timeres.c" -Encoding utf8"#,
            cwd,
        )
        .expect("block reason");

        assert!(reason.contains("CodexStressCed file safety block"));
        assert!(reason.contains("Set-Content"));
        assert!(reason.contains(&normalize_existing_path(source).display().to_string()));
    }

    #[test]
    fn allows_shell_write_to_new_source_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();

        let reason = StresscedEditGuard::block_reason(
            r#"Set-Content -LiteralPath "new_file.c" -Value "int main(void) { return 0; }""#,
            cwd,
        );

        assert_eq!(reason, None);
    }

    #[test]
    fn blocks_out_file_rewrite_of_existing_markdown_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        let dispatch = cwd.join("DISPATCH.md");
        fs::write(&dispatch, "# Dispatch\n\nOriginal body.\n").expect("write markdown");

        let reason = StresscedEditGuard::block_reason(
            r#"$content = Get-Content "DISPATCH.md" -Encoding utf8; $content | Out-File "DISPATCH.md" -Encoding utf8 -NoNewline"#,
            cwd,
        )
        .expect("block reason");

        assert!(reason.contains("Out-File"));
        assert!(reason.contains(&normalize_existing_path(dispatch).display().to_string()));
    }

    #[test]
    fn blocks_set_content_rewrite_of_existing_markdown_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        let current = cwd.join("CURRENT.md");
        fs::write(&current, "# Current\n\nOriginal body.\n").expect("write markdown");

        let reason = StresscedEditGuard::block_reason(
            r#"@'
# Current

Rewritten body.
'@ | Set-Content -LiteralPath 'CURRENT.md' -Encoding utf8"#,
            cwd,
        )
        .expect("block reason");

        assert!(reason.contains("Set-Content"));
        assert!(reason.contains(&normalize_existing_path(current).display().to_string()));
    }

    #[test]
    fn allows_new_doc_with_existing_source_path_in_content() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        fs::create_dir_all(cwd.join("docs")).expect("create docs");
        fs::create_dir_all(cwd.join("tests")).expect("create tests");
        fs::write(
            cwd.join("tests")
                .join("local_control_runtime_smoke_harness_test.cpp"),
            "int main(void) { return 0; }\n",
        )
        .expect("write source");

        let command = r#"@'
The existing local baseline is `tests\local_control_runtime_smoke_harness_test.cpp`.
'@ | Set-Content -LiteralPath 'docs\CONTROL_TRANSPORT_DESIGN.md' -Encoding utf8"#;

        let reason = StresscedEditGuard::block_reason(command, cwd);

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_shell_write_to_new_markdown_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();

        let reason = StresscedEditGuard::block_reason(
            r##""# New Notes" | Out-File "NOTES.md" -Encoding utf8"##,
            cwd,
        );

        assert_eq!(reason, None);
    }

    #[test]
    fn blocks_inline_python_rewrite_of_existing_source_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        let source = cwd.join("local_control_runtime_smoke_harness_test.cpp");
        fs::write(&source, "int main(void) { return 0; }\n").expect("write source");
        let payload = "int value = 1;\\n".repeat(120);
        let command = format!(
            "python -c \"open('local_control_runtime_smoke_harness_test.cpp','w').write('{payload}')\""
        );

        let reason = StresscedEditGuard::block_reason(&command, cwd).expect("block reason");

        assert!(reason.contains("python inline script"));
        assert!(reason.contains(&normalize_existing_path(source).display().to_string()));
    }

    #[test]
    fn blocks_here_string_python_raw_path_rewrite_of_existing_source_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        let source = cwd.join("memory_store.cpp");
        fs::write(&source, "int old_value = 0;\n").expect("write source");
        let command = r#"@'
from pathlib import Path
path = r"memory_store.cpp"
with open(r"memory_store.cpp", "w", encoding="utf-8") as handle:
    handle.write("int new_value = 1;\n")
'@ | python"#;

        let reason = StresscedEditGuard::block_reason(command, cwd).expect("block reason");

        assert!(reason.contains("Python direct source write"));
        assert!(reason.contains(&normalize_existing_path(source).display().to_string()));
    }

    #[test]
    fn blocks_pathlib_write_text_of_existing_source_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        let source = cwd.join("memory_store.cpp");
        fs::write(&source, "int old_value = 0;\n").expect("write source");
        let command =
            r#"python -c "from pathlib import Path; Path(r'memory_store.cpp').write_text('x')""#;

        let reason = StresscedEditGuard::block_reason(command, cwd).expect("block reason");

        assert!(reason.contains("Python direct source write"));
        assert!(reason.contains(&normalize_existing_path(source).display().to_string()));
    }

    #[test]
    fn blocks_python_rewrite_of_existing_markdown_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        let dispatch = cwd.join("DISPATCH.md");
        fs::write(&dispatch, "# Dispatch\n\nOriginal body.\n").expect("write markdown");
        let command =
            r#"python -c "open(r'DISPATCH.md', 'w', encoding='utf-8').write('# Dispatch\n')""#;

        let reason = StresscedEditGuard::block_reason(command, cwd).expect("block reason");

        assert!(reason.contains("Python direct source write"));
        assert!(reason.contains(&normalize_existing_path(dispatch).display().to_string()));
    }

    #[test]
    fn allows_python_read_of_existing_source_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        fs::write(cwd.join("memory_store.cpp"), "int value = 0;\n").expect("write source");
        let command =
            r#"python -c "print(open(r'memory_store.cpp', 'r', encoding='utf-8').read())""#;

        let reason = StresscedEditGuard::block_reason(command, cwd);

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_python_read_of_existing_markdown_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        fs::write(cwd.join("DISPATCH.md"), "# Dispatch\n").expect("write markdown");
        let command = r#"python -c "print(open(r'DISPATCH.md', 'r', encoding='utf-8').read())""#;

        let reason = StresscedEditGuard::block_reason(command, cwd);

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_python_write_to_new_source_file() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        let command = r#"python -c "open(r'new_memory_store.cpp', 'w').write('int value = 0;\n')""#;

        let reason = StresscedEditGuard::block_reason(command, cwd);

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_new_doc_with_python_write_example_for_existing_source_path() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        fs::create_dir_all(cwd.join("docs")).expect("create docs");
        fs::create_dir_all(cwd.join("src")).expect("create src");
        fs::write(cwd.join("src").join("memory_store.cpp"), "int value = 0;\n")
            .expect("write source");

        let command = r#"@'
Example not executed:
python -c "open(r'src\memory_store.cpp', 'w').write('x')"
'@ | Set-Content -LiteralPath 'docs\PYTHON_NOTES.md' -Encoding utf8"#;

        let reason = StresscedEditGuard::block_reason(command, cwd);

        assert_eq!(reason, None);
    }

    #[test]
    fn allows_read_command_with_greater_than_pattern() {
        let temp = tempdir().expect("tempdir");
        let cwd = temp.path();
        fs::write(cwd.join("timeres.c"), "if (value > 0) { return 1; }\n").expect("write source");

        let reason = StresscedEditGuard::block_reason(
            r#"Select-String -Pattern "value > 0" "timeres.c""#,
            cwd,
        );

        assert_eq!(reason, None);
    }
}
