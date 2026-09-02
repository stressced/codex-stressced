#![cfg(feature = "stressced")]

#[test]
fn context_status_snapshots() {
    let script =
        codex_utils_cargo_bin::find_resource!("../ui/codex-stressced-ui/test/snapshots.mjs")
            .expect("UI snapshot script");
    let output = std::process::Command::new("node")
        .arg(script)
        .output()
        .expect("Node.js is required for Stressced UI tests");
    assert!(
        output.status.success(),
        "Run npm ci in codex-rs/ui/codex-stressced-ui first: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    insta::assert_snapshot!(
        String::from_utf8(output.stdout)
            .unwrap()
            .replace("\r\n", "\n")
    );
}
