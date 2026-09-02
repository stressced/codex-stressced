use super::*;
use codex_protocol::protocol::ThreadSettingsAppliedEvent;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn compaction_checkpoints_latest_owned_settings_after_frozen_turn_context() {
    let (mut session, frozen_turn) = make_session_and_context().await;
    let rollout_path = attach_thread_persistence(&mut session).await;
    let next_cwd = session.get_config().await.cwd.join("after-settings-update");
    std::fs::create_dir_all(next_cwd.as_path()).unwrap();
    session
        .update_settings(SessionSettingsUpdate {
            cwd: Some(next_cwd.to_path_buf()),
            ..Default::default()
        })
        .await
        .unwrap();
    session
        .replace_compacted_history(
            Vec::new(),
            Some(frozen_turn.to_turn_context_item()),
            CompactedItem {
                message: "handoff".to_string(),
                replacement_history: Some(Vec::new()),
            },
        )
        .await;
    session.ensure_rollout_materialized().await;
    session.flush_rollout().await.unwrap();
    let history = RolloutRecorder::get_rollout_history(&rollout_path)
        .await
        .unwrap();
    assert_eq!(history.session_cwd(), Some(next_cwd.to_path_buf()));
    let items = history.get_rollout_items();
    let Some(RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(event))) = items.last() else {
        panic!("settings checkpoint must follow the frozen turn context");
    };
    assert_eq!(event.thread_id, Some(session.conversation_id));
}

#[tokio::test]
async fn resume_ignores_foreign_and_legacy_settings_snapshots() {
    let (session, _) = make_session_and_context().await;
    let EventMsg::ThreadSettingsApplied(mut event) =
        super::super::thread_settings::applied_event(&session).await
    else {
        panic!("expected settings snapshot");
    };
    let startup_cwd = event.thread_settings.cwd.join("startup").to_path_buf();
    let original = RolloutItem::SessionMeta(codex_protocol::protocol::SessionMetaLine {
        meta: codex_protocol::protocol::SessionMeta {
            id: session.conversation_id,
            cwd: startup_cwd.clone(),
            ..Default::default()
        },
        git: None,
    });
    let mut serialized = serde_json::to_value(&event).unwrap();
    serialized.as_object_mut().unwrap().remove("thread_id");
    let legacy: ThreadSettingsAppliedEvent = serde_json::from_value(serialized).unwrap();
    assert_eq!(legacy.thread_id, None);
    event.thread_id = Some(ThreadId::new());
    let history = InitialHistory::Resumed(ResumedHistory {
        conversation_id: session.conversation_id,
        history: vec![
            original,
            RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(event)),
            RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(legacy)),
        ],
        rollout_path: None,
    });
    assert_eq!(history.session_cwd(), Some(startup_cwd));
}

#[tokio::test]
async fn compaction_waits_for_settings_persistence() {
    let (session, _) = make_session_and_context().await;
    let session = Arc::new(session);
    let guard = super::super::thread_settings::acquire_persistence_lock(&session).await;
    let compact_session = Arc::clone(&session);
    let mut task = tokio::spawn(async move {
        compact_session
            .replace_compacted_history(
                Vec::new(),
                None,
                CompactedItem {
                    message: "handoff".to_string(),
                    replacement_history: Some(Vec::new()),
                },
            )
            .await;
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut task)
            .await
            .is_err()
    );
    drop(guard);
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
}
