//! Settings checkpoints shared by accepted updates and compaction.

use super::session::Session;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::ThreadSettingsAppliedEvent;
use codex_protocol::protocol::ThreadSettingsSnapshot;
use tokio::sync::SemaphorePermit;

pub(super) async fn acquire_persistence_lock(sess: &Session) -> SemaphorePermit<'_> {
    match sess.settings_persistence_lock.acquire().await {
        Ok(permit) => permit,
        Err(_) => unreachable!("the private settings persistence semaphore is never closed"),
    }
}

pub(super) async fn applied_event(sess: &Session) -> EventMsg {
    let snapshot = {
        let state = sess.state.lock().await;
        state.session_configuration.thread_config_snapshot()
    };
    EventMsg::ThreadSettingsApplied(ThreadSettingsAppliedEvent {
        thread_id: Some(sess.conversation_id),
        thread_settings: ThreadSettingsSnapshot {
            model: snapshot.model,
            model_provider_id: snapshot.model_provider_id,
            service_tier: snapshot.service_tier,
            approval_policy: snapshot.approval_policy,
            approvals_reviewer: snapshot.approvals_reviewer,
            permission_profile: snapshot.permission_profile,
            active_permission_profile: snapshot.active_permission_profile,
            cwd: snapshot.cwd,
            reasoning_effort: snapshot.reasoning_effort,
            reasoning_summary: snapshot.reasoning_summary,
            personality: snapshot.personality,
            collaboration_mode: snapshot.collaboration_mode,
        },
    })
}
