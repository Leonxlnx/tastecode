use harness_protocol::{Item, ItemStatus, ItemType, MessageRole};
use harness_state::{ThreadState, TurnState};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) enum RowPresentation {
    #[default]
    Normal,
    Suppressed,
    ActivityLead {
        turn_id: String,
    },
    FinalAnswer {
        turn_id: String,
        show_completion_rail: bool,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct TurnPresentation {
    pub(super) activity_rows: Vec<usize>,
    pub(super) visible_activity_rows: Vec<usize>,
    pub(super) first_response_row: Option<usize>,
    pub(super) final_answer_row: Option<usize>,
    pub(super) elapsed_ms: f64,
    pub(super) complete: bool,
}

#[derive(Default)]
pub(super) struct TranscriptPresentation {
    rows: Vec<RowPresentation>,
    turns: HashMap<String, TurnPresentation>,
}

impl TranscriptPresentation {
    pub(super) fn clear(&mut self) {
        self.rows.clear();
        self.turns.clear();
    }

    pub(super) fn rebuild(&mut self, state: &ThreadState) -> Vec<usize> {
        let previous_rows = std::mem::take(&mut self.rows);
        let previous_turns = std::mem::take(&mut self.turns);
        self.rows = vec![RowPresentation::Normal; state.timeline_len()];

        for turn in &state.turns {
            self.rebuild_turn(state, turn);
        }

        changed_rows(&previous_rows, &self.rows, &previous_turns, &self.turns)
    }

    pub(super) fn refresh_turns(
        &mut self,
        state: &ThreadState,
        turn_ids: &HashSet<String>,
    ) -> Vec<usize> {
        self.rows
            .resize(state.timeline_len(), RowPresentation::Normal);
        let mut changed = BTreeSet::new();

        for turn_id in turn_ids {
            if let Some(previous) = self.turns.remove(turn_id) {
                changed.extend(previous.activity_rows);
                changed.extend(previous.first_response_row);
                changed.extend(previous.final_answer_row);
            }
            let Some(turn) = state.turn(turn_id) else {
                continue;
            };
            let rows = turn
                .items
                .iter()
                .filter_map(|item| state.row_for_item(turn_id, &item.id))
                .collect::<Vec<_>>();
            for row in &rows {
                self.rows[*row] = RowPresentation::Normal;
            }
            self.rebuild_turn(state, turn);
            changed.extend(rows);
        }

        changed.into_iter().collect()
    }

    fn rebuild_turn(&mut self, state: &ThreadState, turn: &TurnState) {
        let mut activity_rows = Vec::new();
        let mut first_response_row = None;
        let mut earliest = f64::INFINITY;
        let mut latest = f64::NEG_INFINITY;
        let mut has_running_activity = false;

        for item in &turn.items {
            let Some(row) = state.row_for_item(&turn.turn.id, &item.id) else {
                continue;
            };
            earliest = earliest.min(item.created_at);
            latest = latest.max(item.created_at);
            if !is_user_message(item) {
                first_response_row.get_or_insert(row);
            }
            if is_activity(item) {
                activity_rows.push(row);
                has_running_activity |= item.status == ItemStatus::Started;
            } else if is_completed_assistant_message(item) {
                activity_rows.push(row);
            }
        }

        let final_answer_row = activity_rows
            .iter()
            .rev()
            .copied()
            .find(|row| state.item_at_row(*row).is_some_and(is_assistant_message));
        let activity_rows = final_answer_row.map_or_else(
            || activity_rows.clone(),
            |final_row| {
                activity_rows
                    .iter()
                    .copied()
                    .filter(|row| *row != final_row)
                    .collect()
            },
        );
        let visible_activity_rows = activity_rows
            .iter()
            .copied()
            .filter(|row| state.item_at_row(*row).is_some_and(is_visible_worked_item))
            .collect::<Vec<_>>();
        let complete = final_answer_row.is_some() && !has_running_activity;

        if complete {
            if let Some(first_activity_row) = activity_rows.first().copied() {
                for row in &activity_rows {
                    self.rows[*row] = RowPresentation::Suppressed;
                }
                self.rows[first_activity_row] = RowPresentation::ActivityLead {
                    turn_id: turn.turn.id.clone(),
                };
            }
            if let Some(final_answer_row) = final_answer_row {
                self.rows[final_answer_row] = RowPresentation::FinalAnswer {
                    turn_id: turn.turn.id.clone(),
                    show_completion_rail: activity_rows.is_empty(),
                };
            }
        }

        self.turns.insert(
            turn.turn.id.clone(),
            TurnPresentation {
                activity_rows,
                visible_activity_rows,
                first_response_row,
                final_answer_row,
                elapsed_ms: if earliest.is_finite() && latest.is_finite() {
                    (latest - earliest).max(0.0)
                } else {
                    0.0
                },
                complete,
            },
        );
    }

    pub(super) fn row(&self, row: usize) -> RowPresentation {
        self.rows.get(row).cloned().unwrap_or_default()
    }

    pub(super) fn turn(&self, turn_id: &str) -> Option<&TurnPresentation> {
        self.turns.get(turn_id)
    }
}

fn changed_rows(
    previous_rows: &[RowPresentation],
    rows: &[RowPresentation],
    previous_turns: &HashMap<String, TurnPresentation>,
    turns: &HashMap<String, TurnPresentation>,
) -> Vec<usize> {
    let mut changed = previous_rows
        .iter()
        .zip(rows)
        .enumerate()
        .filter_map(|(row, (previous, next))| (previous != next).then_some(row))
        .collect::<BTreeSet<_>>();

    for (turn_id, turn) in turns {
        if previous_turns.get(turn_id) == Some(turn) {
            continue;
        }
        if let Some(previous) = previous_turns.get(turn_id) {
            changed.extend(previous.activity_rows.iter().copied());
            changed.extend(previous.final_answer_row);
        }
        changed.extend(turn.activity_rows.iter().copied());
        changed.extend(turn.final_answer_row);
    }

    changed
        .into_iter()
        .filter(|row| *row < rows.len())
        .collect()
}

pub(super) fn is_activity(item: &Item) -> bool {
    item.item_type != ItemType::Message && item.item_type != ItemType::Error
}

pub(super) fn is_assistant_message(item: &Item) -> bool {
    item.item_type == ItemType::Message && item.role == Some(MessageRole::Assistant)
}

fn is_completed_assistant_message(item: &Item) -> bool {
    is_assistant_message(item) && item.status == ItemStatus::Completed
}

fn is_user_message(item: &Item) -> bool {
    item.item_type == ItemType::Message && item.role == Some(MessageRole::User)
}

fn is_visible_worked_item(item: &Item) -> bool {
    item.item_type == ItemType::FileChange
        || (is_completed_assistant_message(item)
            && item
                .text
                .as_ref()
                .is_some_and(|text| !text.trim().is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_protocol::{DomainEvent, SequencedDomainEvent, ThreadHistoryResult};
    use serde_json::json;
    use std::hint::black_box;
    use std::time::Instant;

    fn state(events: Vec<serde_json::Value>) -> ThreadState {
        let mut state = ThreadState::default();
        state
            .replace_history(ThreadHistoryResult {
                running: false,
                events: events
                    .into_iter()
                    .enumerate()
                    .map(|(index, event)| SequencedDomainEvent {
                        seq: index as u64 + 1,
                        event: serde_json::from_value::<DomainEvent>(event).unwrap(),
                    })
                    .collect(),
            })
            .unwrap();
        state
    }

    fn turn_started() -> serde_json::Value {
        json!({
            "type": "turn.started",
            "turn": {
                "id": "turn-1",
                "threadId": "thread-1",
                "status": "running",
                "createdAt": 1000
            }
        })
    }

    fn item(
        id: &str,
        item_type: &str,
        role: Option<&str>,
        status: &str,
        text: &str,
        created_at: f64,
    ) -> serde_json::Value {
        let mut value = json!({
            "id": id,
            "turnId": "turn-1",
            "type": item_type,
            "status": status,
            "text": text,
            "createdAt": created_at
        });
        if let Some(role) = role {
            value["role"] = json!(role);
        }
        json!({ "type": "item.completed", "item": value })
    }

    #[test]
    fn completed_turn_compacts_work_and_keeps_last_assistant_message_as_answer() {
        let state = state(vec![
            turn_started(),
            item(
                "user",
                "message",
                Some("user"),
                "completed",
                "Prompt",
                1100.0,
            ),
            item(
                "thought",
                "message",
                Some("assistant"),
                "completed",
                "I will inspect it.",
                1200.0,
            ),
            item("command", "command", None, "completed", "done", 1300.0),
            item("file", "file_change", None, "completed", "", 1400.0),
            item(
                "answer",
                "message",
                Some("assistant"),
                "completed",
                "Finished.",
                2500.0,
            ),
        ]);
        let mut presentation = TranscriptPresentation::default();
        presentation.rebuild(&state);

        assert!(matches!(
            presentation.row(1),
            RowPresentation::ActivityLead { .. }
        ));
        assert_eq!(presentation.row(2), RowPresentation::Suppressed);
        assert_eq!(presentation.row(3), RowPresentation::Suppressed);
        assert!(matches!(
            presentation.row(4),
            RowPresentation::FinalAnswer {
                show_completion_rail: false,
                ..
            }
        ));
        let turn = presentation.turn("turn-1").unwrap();
        assert_eq!(turn.visible_activity_rows, vec![1, 3]);
        assert_eq!(turn.elapsed_ms, 1400.0);
        assert!(turn.complete);
    }

    #[test]
    fn running_activity_prevents_compaction() {
        let mut started = item("command", "command", None, "started", "running", 1200.0);
        started["type"] = json!("item.started");
        let state = state(vec![
            turn_started(),
            item(
                "user",
                "message",
                Some("user"),
                "completed",
                "Prompt",
                1100.0,
            ),
            started,
            item(
                "answer",
                "message",
                Some("assistant"),
                "completed",
                "Partial answer.",
                1300.0,
            ),
        ]);
        let mut presentation = TranscriptPresentation::default();
        presentation.rebuild(&state);

        assert_eq!(presentation.row(1), RowPresentation::Normal);
        assert_eq!(presentation.row(2), RowPresentation::Normal);
        assert!(!presentation.turn("turn-1").unwrap().complete);
    }

    #[test]
    fn answer_without_visible_work_gets_an_empty_completion_rail() {
        let state = state(vec![
            turn_started(),
            item(
                "user",
                "message",
                Some("user"),
                "completed",
                "Prompt",
                1100.0,
            ),
            item(
                "answer",
                "message",
                Some("assistant"),
                "completed",
                "Finished.",
                2100.0,
            ),
        ]);
        let mut presentation = TranscriptPresentation::default();
        presentation.rebuild(&state);

        assert!(matches!(
            presentation.row(1),
            RowPresentation::FinalAnswer {
                show_completion_rail: true,
                ..
            }
        ));
    }

    #[test]
    fn incremental_refresh_matches_full_rebuild_when_a_turn_finishes() {
        let mut command_started = item("command", "command", None, "started", "cargo test", 1200.0);
        command_started["type"] = json!("item.started");
        let mut state = state(vec![
            turn_started(),
            item(
                "user",
                "message",
                Some("user"),
                "completed",
                "Prompt",
                1100.0,
            ),
            command_started,
            item(
                "answer",
                "message",
                Some("assistant"),
                "completed",
                "Finished.",
                2100.0,
            ),
        ]);
        let mut incremental = TranscriptPresentation::default();
        incremental.rebuild(&state);

        state.apply_live(
            Some(5),
            serde_json::from_value(item(
                "command",
                "command",
                None,
                "completed",
                "cargo test",
                2200.0,
            ))
            .unwrap(),
        );
        state.apply_live(
            Some(6),
            serde_json::from_value(json!({
                "type": "turn.completed",
                "turnId": "turn-1",
                "status": "completed"
            }))
            .unwrap(),
        );
        let changed = incremental.refresh_turns(&state, &HashSet::from(["turn-1".to_owned()]));

        let mut rebuilt = TranscriptPresentation::default();
        rebuilt.rebuild(&state);
        assert!(!changed.is_empty());
        assert_eq!(incremental.rows, rebuilt.rows);
        assert_eq!(incremental.turns, rebuilt.turns);
    }

    #[test]
    #[ignore = "performance benchmark"]
    fn benchmark_long_thread_presentation_refresh() {
        const SAMPLES: usize = 11;
        const ITERATIONS: usize = 100;
        for turn_count in [100_usize, 1_000] {
            let state = long_thread_state(turn_count);
            let mut presentation = TranscriptPresentation::default();
            presentation.rebuild(&state);
            let changed_turn = HashSet::from([format!("turn-{}", turn_count - 1)]);
            for _ in 0..2 {
                for _ in 0..ITERATIONS {
                    black_box(presentation.refresh_turns(&state, &changed_turn));
                }
            }
            let mut samples = Vec::with_capacity(SAMPLES);
            for _ in 0..SAMPLES {
                let started = Instant::now();
                for _ in 0..ITERATIONS {
                    black_box(presentation.refresh_turns(&state, &changed_turn));
                }
                samples.push(started.elapsed());
            }
            samples.sort_unstable();
            let median = samples[SAMPLES / 2];
            let p95 = samples[((SAMPLES as f64 * 0.95).ceil() as usize - 1).min(SAMPLES - 1)];
            println!(
                "presentation_refresh turns={turn_count} iterations={ITERATIONS} median_ns={} p95_ns={} median_ns_per_refresh={:.2} p95_ns_per_refresh={:.2}",
                median.as_nanos(),
                p95.as_nanos(),
                median.as_nanos() as f64 / ITERATIONS as f64,
                p95.as_nanos() as f64 / ITERATIONS as f64,
            );
        }
    }

    fn long_thread_state(turn_count: usize) -> ThreadState {
        let mut events = Vec::with_capacity(turn_count * 5);
        for index in 0..turn_count {
            let turn_id = format!("turn-{index}");
            events.push(json!({
                "type": "turn.started",
                "turn": {
                    "id": turn_id,
                    "threadId": "thread-performance",
                    "status": "running",
                    "createdAt": index as f64 * 10.0
                }
            }));
            events.push(long_thread_item(
                &format!("user-{index}"),
                &turn_id,
                "message",
                Some("user"),
                "Prompt",
                index as f64 * 10.0 + 1.0,
            ));
            events.push(long_thread_item(
                &format!("command-{index}"),
                &turn_id,
                "command",
                None,
                "cargo test",
                index as f64 * 10.0 + 2.0,
            ));
            events.push(long_thread_item(
                &format!("answer-{index}"),
                &turn_id,
                "message",
                Some("assistant"),
                "Finished.",
                index as f64 * 10.0 + 3.0,
            ));
            events.push(json!({
                "type": "turn.completed",
                "turnId": turn_id,
                "status": "completed"
            }));
        }
        state(events)
    }

    fn long_thread_item(
        id: &str,
        turn_id: &str,
        item_type: &str,
        role: Option<&str>,
        text: &str,
        created_at: f64,
    ) -> serde_json::Value {
        let mut item = json!({
            "id": id,
            "turnId": turn_id,
            "type": item_type,
            "status": "completed",
            "text": text,
            "createdAt": created_at
        });
        if let Some(role) = role {
            item["role"] = json!(role);
        }
        json!({ "type": "item.completed", "item": item })
    }
}
