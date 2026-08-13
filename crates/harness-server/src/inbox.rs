use harness_protocol::{DomainEvent, ThreadInboxStatus, TurnStatus};
use harness_store::{Result, Store};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(crate) struct InboxProjections {
    threads: HashMap<String, InboxProjection>,
}

impl InboxProjections {
    pub(crate) fn status(
        &mut self,
        store: &Store,
        thread_id: &str,
        unread: bool,
    ) -> Result<ThreadInboxStatus> {
        let projection = self.threads.entry(thread_id.into()).or_default();
        for entry in store.history(thread_id, projection.seq)? {
            projection.seq = entry.seq;
            match entry.event {
                DomainEvent::ApprovalRequested { request } => {
                    projection.approvals.insert(request.id);
                }
                DomainEvent::ApprovalResolved { id } => {
                    projection.approvals.remove(&id);
                }
                DomainEvent::UserInputRequested { request } => {
                    projection.inputs.insert(request.id);
                }
                DomainEvent::UserInputResolved { id } => {
                    projection.inputs.remove(&id);
                }
                DomainEvent::ThreadError { .. } => projection.last_failed = true,
                DomainEvent::TurnCompleted { status, .. } => {
                    projection.last_failed = status == TurnStatus::Failed;
                }
                _ => {}
            }
        }
        if !projection.approvals.is_empty() {
            return Ok(ThreadInboxStatus::Approval);
        }
        if !projection.inputs.is_empty() {
            return Ok(ThreadInboxStatus::Input);
        }
        if projection.last_failed {
            return Ok(ThreadInboxStatus::Failed);
        }
        Ok(if unread {
            ThreadInboxStatus::Ready
        } else {
            ThreadInboxStatus::Idle
        })
    }

    pub(crate) fn remove(&mut self, thread_id: &str) {
        self.threads.remove(thread_id);
    }
}

#[derive(Default)]
struct InboxProjection {
    seq: u64,
    approvals: HashSet<String>,
    inputs: HashSet<String>,
    last_failed: bool,
}
