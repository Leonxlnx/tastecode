//! Event-derived native read models.
//!
//! The streamed delta path mutates one existing item string in place. It does
//! not scan the transcript, clone the item list, or rebuild sidebar data.

use harness_protocol::{
    ApprovalRequest, ApprovalReview, ApprovalReviewStatus, DomainEvent, Item, ItemStatus, PlanStep,
    SequencedDomainEvent, Thread, ThreadHistoryResult, Turn, TurnStatus, Usage, UserInputRequest,
};
use std::collections::HashMap;

const OPTIMISTIC_ITEM_PREFIX: &str = "optimistic:";
const OPTIMISTIC_TURN_PREFIX: &str = "local-turn:";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChangeSet {
    pub transcript: bool,
    pub streamed_text: bool,
    pub controls: bool,
}

impl ChangeSet {
    const TRANSCRIPT: Self = Self {
        transcript: true,
        streamed_text: false,
        controls: false,
    };
    const STREAMED_TEXT: Self = Self {
        transcript: true,
        streamed_text: true,
        controls: false,
    };
    const CONTROLS: Self = Self {
        transcript: false,
        streamed_text: false,
        controls: true,
    };
    const ALL: Self = Self {
        transcript: true,
        streamed_text: false,
        controls: true,
    };
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied(ChangeSet),
    Duplicate,
    NeedsHistory { after_seq: u64 },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum HistoryError {
    #[error("history is not strictly ordered: expected sequence {expected}, received {received}")]
    Sequence { expected: u64, received: u64 },
    #[error("event references missing turn {0}")]
    MissingTurn(String),
    #[error("delta references missing item {item_id} in turn {turn_id}")]
    MissingItem { turn_id: String, item_id: String },
}

#[derive(Clone, Debug)]
pub struct TurnState {
    pub turn: Turn,
    pub items: Vec<Item>,
    item_index: HashMap<String, usize>,
}

impl TurnState {
    fn new(turn: Turn) -> Self {
        Self {
            turn,
            items: Vec::new(),
            item_index: HashMap::new(),
        }
    }

    fn item_mut(&mut self, id: &str) -> Option<&mut Item> {
        let index = self.item_index.get(id).copied()?;
        self.items.get_mut(index)
    }
}

#[derive(Default)]
pub struct ThreadState {
    pub thread: Option<Thread>,
    pub turns: Vec<TurnState>,
    turn_index: HashMap<String, usize>,
    pub running: bool,
    pub plan: Option<(String, Vec<PlanStep>)>,
    pub usage: Option<Usage>,
    pub diff: Option<(String, String)>,
    pub approvals: Vec<ApprovalRequest>,
    pub user_inputs: Vec<UserInputRequest>,
    pub reviews: Vec<ApprovalReview>,
    review_index: HashMap<String, usize>,
    pub errors: Vec<String>,
    timeline: Vec<(usize, usize)>,
    item_rows: HashMap<String, HashMap<String, usize>>,
    last_seq: u64,
}

impl ThreadState {
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    pub fn replace_history(&mut self, history: ThreadHistoryResult) -> Result<(), HistoryError> {
        *self = Self::default();
        self.running = history.running;
        self.merge_history(history.events)
    }

    pub fn merge_history(&mut self, events: Vec<SequencedDomainEvent>) -> Result<(), HistoryError> {
        for entry in events {
            if entry.seq <= self.last_seq {
                continue;
            }
            let expected = self.last_seq.saturating_add(1);
            if self.last_seq != 0 && entry.seq != expected {
                return Err(HistoryError::Sequence {
                    expected,
                    received: entry.seq,
                });
            }
            self.apply_event(entry.event)?;
            self.last_seq = entry.seq;
        }
        Ok(())
    }

    pub fn apply_live(&mut self, seq: Option<u64>, event: DomainEvent) -> ApplyOutcome {
        if let Some(seq) = seq {
            if seq <= self.last_seq {
                return ApplyOutcome::Duplicate;
            }
            if self.last_seq != 0 && seq != self.last_seq + 1 {
                return ApplyOutcome::NeedsHistory {
                    after_seq: self.last_seq,
                };
            }
            match self.apply_event(event) {
                Ok(changes) => {
                    self.last_seq = seq;
                    ApplyOutcome::Applied(changes)
                }
                Err(_) => ApplyOutcome::NeedsHistory {
                    after_seq: self.last_seq,
                },
            }
        } else {
            match self.apply_event(event) {
                Ok(changes) => ApplyOutcome::Applied(changes),
                Err(_) => ApplyOutcome::NeedsHistory {
                    after_seq: self.last_seq,
                },
            }
        }
    }

    pub fn active_turn(&self) -> Option<&TurnState> {
        self.turns
            .iter()
            .rev()
            .find(|turn| turn.turn.status == TurnStatus::Running)
    }

    pub fn turn(&self, id: &str) -> Option<&TurnState> {
        self.turn_index
            .get(id)
            .and_then(|index| self.turns.get(*index))
    }

    pub fn timeline_len(&self) -> usize {
        self.timeline.len()
    }

    pub fn item_at_row(&self, row: usize) -> Option<&Item> {
        let (turn_index, item_index) = self.timeline.get(row).copied()?;
        self.turns.get(turn_index)?.items.get(item_index)
    }

    pub fn row_for_item(&self, turn_id: &str, item_id: &str) -> Option<usize> {
        self.item_rows.get(turn_id)?.get(item_id).copied()
    }

    pub fn first_row_for_turn(&self, turn_id: &str) -> Option<usize> {
        let turn_index = self.turn_index.get(turn_id).copied()?;
        self.timeline
            .iter()
            .position(|(candidate, _)| *candidate == turn_index)
    }

    fn apply_event(&mut self, event: DomainEvent) -> Result<ChangeSet, HistoryError> {
        let changes = match event {
            DomainEvent::ThreadStarted { thread } => {
                self.thread = Some(thread);
                ChangeSet::CONTROLS
            }
            DomainEvent::TurnStarted { turn } => {
                self.running = true;
                self.plan = None;
                self.diff = None;
                self.upsert_started_turn(turn);
                ChangeSet::ALL
            }
            DomainEvent::ItemStarted { item } => {
                self.upsert_item(item)?;
                ChangeSet::TRANSCRIPT
            }
            DomainEvent::ItemDelta {
                turn_id,
                item_id,
                text_delta,
            } => {
                let item = self
                    .turn_mut(&turn_id)?
                    .item_mut(&item_id)
                    .ok_or(HistoryError::MissingItem { turn_id, item_id })?;
                item.text
                    .get_or_insert_with(String::new)
                    .push_str(&text_delta);
                ChangeSet::STREAMED_TEXT
            }
            DomainEvent::ItemCompleted { item } => {
                self.upsert_item(item)?;
                ChangeSet::TRANSCRIPT
            }
            DomainEvent::TurnCompleted { turn_id, status } => {
                let turn = self.turn_mut(&turn_id)?;
                turn.turn.status = status;
                self.running = self
                    .turns
                    .iter()
                    .any(|turn| turn.turn.status == TurnStatus::Running);
                self.approvals.clear();
                ChangeSet::ALL
            }
            DomainEvent::ThreadError { message, .. } => {
                self.running = false;
                self.approvals.clear();
                self.user_inputs.clear();
                self.errors.push(message);
                ChangeSet::ALL
            }
            DomainEvent::PlanUpdated { turn_id, steps } => {
                self.plan = Some((turn_id, steps));
                ChangeSet::TRANSCRIPT
            }
            DomainEvent::UsageUpdated { usage } => {
                self.usage = Some(usage);
                ChangeSet::CONTROLS
            }
            DomainEvent::DiffUpdated { turn_id, diff } => {
                self.diff = Some((turn_id, diff));
                ChangeSet::CONTROLS
            }
            DomainEvent::ApprovalRequested { request } => {
                upsert_by_id(&mut self.approvals, request, |request| &request.id);
                ChangeSet::ALL
            }
            DomainEvent::ApprovalResolved { id } => {
                self.approvals.retain(|request| request.id != id);
                ChangeSet::ALL
            }
            DomainEvent::UserInputRequested { request } => {
                upsert_by_id(&mut self.user_inputs, request, |request| &request.id);
                ChangeSet::ALL
            }
            DomainEvent::UserInputResolved { id } => {
                self.user_inputs.retain(|request| request.id != id);
                ChangeSet::ALL
            }
            DomainEvent::ApprovalReviewStarted { review }
            | DomainEvent::ApprovalReviewCompleted { review } => {
                self.upsert_review(review);
                ChangeSet::TRANSCRIPT
            }
        };
        Ok(changes)
    }

    fn upsert_started_turn(&mut self, turn: Turn) {
        if let Some(index) = self.turn_index.get(&turn.id).copied() {
            self.turns[index].turn = turn;
        } else if !turn.id.starts_with(OPTIMISTIC_TURN_PREFIX)
            && let Some(index) = self.turns.iter().rposition(|candidate| {
                candidate.turn.status == TurnStatus::Running
                    && candidate.turn.id.starts_with(OPTIMISTIC_TURN_PREFIX)
            })
        {
            let optimistic_id = self.turns[index].turn.id.clone();
            let created_at = self.turns[index].turn.created_at;
            let canonical_id = turn.id.clone();
            self.turn_index.remove(&optimistic_id);
            self.turns[index].turn = Turn { created_at, ..turn };
            for item in &mut self.turns[index].items {
                item.turn_id.clone_from(&canonical_id);
            }
            self.turn_index.insert(canonical_id.clone(), index);
            if let Some(rows) = self.item_rows.remove(&optimistic_id) {
                self.item_rows.insert(canonical_id, rows);
            }
        } else {
            self.turn_index.insert(turn.id.clone(), self.turns.len());
            self.turns.push(TurnState::new(turn));
        }
    }

    fn turn_mut(&mut self, id: &str) -> Result<&mut TurnState, HistoryError> {
        let index = self
            .turn_index
            .get(id)
            .copied()
            .ok_or_else(|| HistoryError::MissingTurn(id.into()))?;
        Ok(&mut self.turns[index])
    }

    fn upsert_item(&mut self, item: Item) -> Result<(), HistoryError> {
        let turn_index = self
            .turn_index
            .get(&item.turn_id)
            .copied()
            .ok_or_else(|| HistoryError::MissingTurn(item.turn_id.clone()))?;
        let turn_id = item.turn_id.clone();
        let item_id = item.id.clone();
        let turn = &mut self.turns[turn_index];
        if let Some(item_index) = turn.item_index.get(&item.id).copied() {
            turn.items[item_index] = item;
        } else if item.role == Some(harness_protocol::MessageRole::User)
            && let Some(item_index) = turn.items.iter().rposition(|candidate| {
                candidate.id.starts_with(OPTIMISTIC_ITEM_PREFIX)
                    && (item.text.is_none() || candidate.text == item.text)
            })
        {
            let optimistic_id = turn.items[item_index].id.clone();
            let optimistic_text = turn.items[item_index].text.clone();
            let row = self
                .item_rows
                .get_mut(&turn_id)
                .and_then(|rows| rows.remove(&optimistic_id));
            turn.item_index.remove(&optimistic_id);
            turn.items[item_index] = Item {
                text: item.text.or(optimistic_text),
                ..item
            };
            turn.item_index.insert(item_id.clone(), item_index);
            if let Some(row) = row {
                self.item_rows
                    .entry(turn_id)
                    .or_default()
                    .insert(item_id, row);
            }
        } else {
            let item_index = turn.items.len();
            turn.item_index.insert(item.id.clone(), item_index);
            turn.items.push(item);
            self.item_rows
                .entry(turn_id)
                .or_default()
                .insert(item_id, self.timeline.len());
            self.timeline.push((turn_index, item_index));
        }
        Ok(())
    }

    pub fn discard_optimistic_turn(&mut self, turn_id: &str) -> bool {
        let Some(index) = self.turn_index.get(turn_id).copied() else {
            return false;
        };
        if !self.turns[index]
            .turn
            .id
            .starts_with(OPTIMISTIC_TURN_PREFIX)
        {
            return false;
        }
        self.turns.remove(index);
        self.rebuild_lookup_tables();
        self.running = self
            .turns
            .iter()
            .any(|turn| turn.turn.status == TurnStatus::Running);
        true
    }

    fn rebuild_lookup_tables(&mut self) {
        self.turn_index.clear();
        self.timeline.clear();
        self.item_rows.clear();
        for (turn_index, turn) in self.turns.iter_mut().enumerate() {
            self.turn_index.insert(turn.turn.id.clone(), turn_index);
            turn.item_index.clear();
            for (item_index, item) in turn.items.iter().enumerate() {
                turn.item_index.insert(item.id.clone(), item_index);
                self.item_rows
                    .entry(turn.turn.id.clone())
                    .or_default()
                    .insert(item.id.clone(), self.timeline.len());
                self.timeline.push((turn_index, item_index));
            }
        }
    }

    fn upsert_review(&mut self, review: ApprovalReview) {
        if let Some(index) = self.review_index.get(&review.id).copied() {
            self.reviews[index] = review;
        } else {
            self.review_index
                .insert(review.id.clone(), self.reviews.len());
            self.reviews.push(review);
        }
    }

    pub fn incomplete_items(&self) -> impl Iterator<Item = &Item> {
        self.turns
            .iter()
            .flat_map(|turn| turn.items.iter())
            .filter(|item| item.status == ItemStatus::Started)
    }

    pub fn pending_reviews(&self) -> impl Iterator<Item = &ApprovalReview> {
        self.reviews
            .iter()
            .filter(|review| review.status == ApprovalReviewStatus::InProgress)
    }
}

fn upsert_by_id<T, F>(values: &mut Vec<T>, next: T, id: F)
where
    F: Fn(&T) -> &str,
{
    if let Some(index) = values.iter().position(|value| id(value) == id(&next)) {
        values[index] = next;
    } else {
        values.push(next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_protocol::{ItemType, MessageRole};
    use serde_json::json;

    fn event(value: serde_json::Value) -> DomainEvent {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn history_builds_ordered_turns_and_mutates_the_stream_tail() {
        let mut state = ThreadState::default();
        state
            .replace_history(ThreadHistoryResult {
                running: true,
                events: vec![
                    SequencedDomainEvent {
                        seq: 1,
                        event: event(json!({
                            "type": "turn.started",
                            "turn": {
                                "id": "turn-1",
                                "threadId": "thread-1",
                                "status": "running",
                                "createdAt": 1
                            }
                        })),
                    },
                    SequencedDomainEvent {
                        seq: 2,
                        event: event(json!({
                            "type": "item.started",
                            "item": {
                                "id": "item-1",
                                "turnId": "turn-1",
                                "type": "message",
                                "status": "started",
                                "role": "assistant",
                                "text": "Hel",
                                "createdAt": 2
                            }
                        })),
                    },
                ],
            })
            .unwrap();

        let original_items_ptr = state.turns[0].items.as_ptr();
        let outcome = state.apply_live(
            Some(3),
            event(json!({
                "type": "item.delta",
                "turnId": "turn-1",
                "itemId": "item-1",
                "textDelta": "lo"
            })),
        );

        assert_eq!(outcome, ApplyOutcome::Applied(ChangeSet::STREAMED_TEXT));
        assert_eq!(state.turns[0].items.as_ptr(), original_items_ptr);
        assert_eq!(state.turns[0].items[0].text.as_deref(), Some("Hello"));
        assert_eq!(state.turns[0].items[0].item_type, ItemType::Message);
        assert_eq!(state.turns[0].items[0].role, Some(MessageRole::Assistant));
    }

    #[test]
    fn canonical_events_replace_the_optimistic_turn_and_user_message() {
        let mut state = ThreadState::default();
        state.apply_live(
            None,
            event(json!({
                "type": "turn.started",
                "turn": {
                    "id": "local-turn:1",
                    "threadId": "thread-1",
                    "status": "running",
                    "createdAt": 10
                }
            })),
        );
        state.apply_live(
            None,
            event(json!({
                "type": "item.completed",
                "item": {
                    "id": "optimistic:1",
                    "turnId": "local-turn:1",
                    "type": "message",
                    "status": "completed",
                    "role": "user",
                    "text": "Resume this chat",
                    "createdAt": 10
                }
            })),
        );

        state.apply_live(
            Some(1),
            event(json!({
                "type": "turn.started",
                "turn": {
                    "id": "server-turn",
                    "threadId": "thread-1",
                    "status": "running",
                    "createdAt": 20
                }
            })),
        );
        state.apply_live(
            Some(2),
            event(json!({
                "type": "item.started",
                "item": {
                    "id": "server-item",
                    "turnId": "server-turn",
                    "type": "message",
                    "status": "started",
                    "role": "user",
                    "text": "Resume this chat",
                    "createdAt": 20
                }
            })),
        );

        assert_eq!(state.turns.len(), 1);
        assert_eq!(state.turns[0].turn.id, "server-turn");
        assert_eq!(state.turns[0].turn.created_at, 10.0);
        assert_eq!(state.timeline_len(), 1);
        assert_eq!(state.item_at_row(0).unwrap().id, "server-item");
        assert_eq!(state.item_at_row(0).unwrap().turn_id, "server-turn");
    }

    #[test]
    fn failed_optimistic_turn_is_removed_without_disturbing_history() {
        let mut state = ThreadState::default();
        for domain_event in [
            event(json!({
                "type": "turn.started",
                "turn": {
                    "id": "turn-1",
                    "threadId": "thread-1",
                    "status": "running",
                    "createdAt": 1
                }
            })),
            event(json!({
                "type": "item.completed",
                "item": {
                    "id": "item-1",
                    "turnId": "turn-1",
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "text": "Earlier answer",
                    "createdAt": 2
                }
            })),
            event(json!({
                "type": "turn.completed",
                "turnId": "turn-1",
                "status": "completed"
            })),
            event(json!({
                "type": "turn.started",
                "turn": {
                    "id": "local-turn:2",
                    "threadId": "thread-1",
                    "status": "running",
                    "createdAt": 3
                }
            })),
            event(json!({
                "type": "item.completed",
                "item": {
                    "id": "optimistic:2",
                    "turnId": "local-turn:2",
                    "type": "message",
                    "status": "completed",
                    "role": "user",
                    "text": "Try this",
                    "createdAt": 3
                }
            })),
        ] {
            state.apply_live(None, domain_event);
        }

        assert!(state.discard_optimistic_turn("local-turn:2"));
        assert!(!state.running);
        assert_eq!(state.turns.len(), 1);
        assert_eq!(state.timeline_len(), 1);
        assert_eq!(
            state.item_at_row(0).unwrap().text.as_deref(),
            Some("Earlier answer")
        );
    }

    #[test]
    fn turn_lookup_returns_the_first_rendered_row() {
        let mut state = ThreadState::default();
        state
            .replace_history(ThreadHistoryResult {
                running: false,
                events: vec![
                    SequencedDomainEvent {
                        seq: 1,
                        event: event(json!({
                            "type": "turn.started",
                            "turn": {
                                "id": "turn-1",
                                "threadId": "thread-1",
                                "status": "running",
                                "createdAt": 1
                            }
                        })),
                    },
                    SequencedDomainEvent {
                        seq: 2,
                        event: event(json!({
                            "type": "item.started",
                            "item": {
                                "id": "item-1",
                                "turnId": "turn-1",
                                "type": "message",
                                "status": "completed",
                                "role": "user",
                                "text": "First",
                                "createdAt": 2
                            }
                        })),
                    },
                    SequencedDomainEvent {
                        seq: 3,
                        event: event(json!({
                            "type": "turn.started",
                            "turn": {
                                "id": "turn-2",
                                "threadId": "thread-1",
                                "status": "running",
                                "createdAt": 3
                            }
                        })),
                    },
                    SequencedDomainEvent {
                        seq: 4,
                        event: event(json!({
                            "type": "item.started",
                            "item": {
                                "id": "item-2",
                                "turnId": "turn-2",
                                "type": "message",
                                "status": "completed",
                                "role": "assistant",
                                "text": "Second",
                                "createdAt": 4
                            }
                        })),
                    },
                ],
            })
            .unwrap();

        assert_eq!(state.first_row_for_turn("turn-1"), Some(0));
        assert_eq!(state.first_row_for_turn("turn-2"), Some(1));
        assert_eq!(state.first_row_for_turn("missing"), None);
    }

    #[test]
    fn duplicate_live_event_is_ignored_and_gap_requests_history() {
        let mut state = ThreadState {
            last_seq: 8,
            ..ThreadState::default()
        };

        assert_eq!(
            state.apply_live(
                Some(8),
                event(json!({ "type": "approval.resolved", "id": "a" }))
            ),
            ApplyOutcome::Duplicate
        );
        assert_eq!(
            state.apply_live(
                Some(10),
                event(json!({ "type": "approval.resolved", "id": "a" }))
            ),
            ApplyOutcome::NeedsHistory { after_seq: 8 }
        );
    }

    #[test]
    fn missing_delta_parent_requests_reconciliation() {
        let mut state = ThreadState::default();
        assert_eq!(
            state.apply_live(
                Some(1),
                event(json!({
                    "type": "item.delta",
                    "turnId": "missing-turn",
                    "itemId": "missing-item",
                    "textDelta": "x"
                }))
            ),
            ApplyOutcome::NeedsHistory { after_seq: 0 }
        );
    }

    #[test]
    fn structured_requests_queue_and_follow_turn_lifecycle_rules() {
        let mut state = ThreadState::default();
        let events = [
            json!({
                "type": "turn.started",
                "turn": {
                    "id": "turn-1",
                    "threadId": "thread-1",
                    "status": "running",
                    "createdAt": 1
                }
            }),
            json!({
                "type": "approval.requested",
                "request": {
                    "id": "approval-1",
                    "kind": "command",
                    "command": "pnpm test",
                    "createdAt": 2
                }
            }),
            json!({
                "type": "approval.requested",
                "request": {
                    "id": "approval-2",
                    "kind": "file_change",
                    "path": "/workspace/src/app.ts",
                    "createdAt": 3
                }
            }),
            json!({
                "type": "user_input.requested",
                "request": {
                    "id": "input-1",
                    "turnId": "turn-1",
                    "questions": [{
                        "id": "tone",
                        "header": "Tone",
                        "question": "How should it feel?",
                        "allowOther": true,
                        "secret": false,
                        "options": null
                    }],
                    "autoResolutionMs": null,
                    "createdAt": 4
                }
            }),
        ];
        for (index, value) in events.into_iter().enumerate() {
            assert!(matches!(
                state.apply_live(Some(index as u64 + 1), event(value)),
                ApplyOutcome::Applied(_)
            ));
        }

        assert_eq!(state.approvals.len(), 2);
        assert_eq!(state.user_inputs.len(), 1);
        assert!(matches!(
            state.apply_live(
                Some(5),
                event(json!({
                    "type": "turn.completed",
                    "turnId": "turn-1",
                    "status": "completed"
                }))
            ),
            ApplyOutcome::Applied(_)
        ));
        assert!(state.approvals.is_empty());
        assert_eq!(state.user_inputs.len(), 1);

        assert!(matches!(
            state.apply_live(
                Some(6),
                event(json!({
                    "type": "thread.error",
                    "threadId": "thread-1",
                    "message": "failed"
                }))
            ),
            ApplyOutcome::Applied(_)
        ));
        assert!(state.user_inputs.is_empty());
    }

    #[test]
    fn a_new_turn_clears_the_previous_plan_and_diff() {
        let mut state = ThreadState::default();
        for (seq, value) in [
            json!({
                "type": "turn.started",
                "turn": {
                    "id": "turn-1",
                    "threadId": "thread-1",
                    "status": "running",
                    "createdAt": 1
                }
            }),
            json!({
                "type": "plan.updated",
                "turnId": "turn-1",
                "steps": [{ "text": "Build it", "status": "running" }]
            }),
            json!({
                "type": "diff.updated",
                "turnId": "turn-1",
                "diff": "diff --git a/a b/a"
            }),
            json!({
                "type": "turn.completed",
                "turnId": "turn-1",
                "status": "completed"
            }),
        ]
        .into_iter()
        .enumerate()
        {
            assert!(matches!(
                state.apply_live(Some(seq as u64 + 1), event(value)),
                ApplyOutcome::Applied(_)
            ));
        }
        assert!(state.plan.is_some());
        assert!(state.diff.is_some());

        state.apply_live(
            Some(5),
            event(json!({
                "type": "turn.started",
                "turn": {
                    "id": "turn-2",
                    "threadId": "thread-1",
                    "status": "running",
                    "createdAt": 2
                }
            })),
        );
        assert!(state.plan.is_none());
        assert!(state.diff.is_none());
    }
}
