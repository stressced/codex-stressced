use super::*;
use codex_utils_output_truncation::TruncationPolicy;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn ctrl_c_stops_a_windows_pipe_process_and_retains_output() {
    let (session, _) = crate::session::tests::make_session_and_context().await;
    let session = Arc::new(session);
    let manager = &session.services.unified_exec_manager;
    let process_id = manager.allocate_process_id().await;
    let spawned = codex_utils_pty::spawn_pipe_process_no_stdin(
        "powershell.exe",
        &[
            "-NoProfile".to_string(),
            "-WindowStyle".to_string(),
            "Hidden".to_string(),
            "-Command".to_string(),
            "Write-Output ready; Start-Sleep -Seconds 60".to_string(),
        ],
        session.get_config().await.cwd.as_path(),
        &std::env::vars().collect(),
        /*arg0*/ &None,
    )
    .await
    .unwrap();
    let process = Arc::new(
        UnifiedExecProcess::from_spawned(
            spawned,
            codex_sandboxing::SandboxType::None,
            Box::new(super::super::super::process::NoopSpawnLifecycle),
        )
        .await
        .unwrap(),
    );
    let handles = process.output_handles();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let notified = handles.output_notify.notified();
            if !handles
                .output_buffer
                .lock()
                .await
                .snapshot_chunks()
                .is_empty()
            {
                break;
            }
            notified.await;
        }
    })
    .await
    .expect("child should print ready");
    manager.process_store.lock().await.processes.insert(
        process_id,
        ProcessEntry {
            process,
            call_id: "windows-interrupt".to_string(),
            process_id,
            hook_command: "sleep test".to_string(),
            tty: false,
            network_approval: None,
            session: Arc::downgrade(&session),
            last_used: Instant::now(),
        },
    );
    let ordinary = manager
        .write_stdin(WriteStdinRequest {
            process_id,
            input: "ordinary input",
            yield_time_ms: 1000,
            max_output_tokens: None,
            truncation_policy: TruncationPolicy::Tokens(1000),
        })
        .await;
    assert!(matches!(ordinary, Err(UnifiedExecError::StdinClosed)));
    let response = manager
        .write_stdin(WriteStdinRequest {
            process_id,
            input: "\u{3}",
            yield_time_ms: 3000,
            max_output_tokens: None,
            truncation_policy: TruncationPolicy::Tokens(1000),
        })
        .await
        .unwrap();
    assert_eq!(response.process_id, None);
    assert!(response.exit_code.is_some());
    assert!(String::from_utf8_lossy(&response.raw_output).contains("ready"));
}
