use harness_protocol::{
    DomainEvent, Item, ItemStatus, ItemType, MessageRole, PlanStep, PlanStepStatus, TurnStatus,
};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum TextKind {
    Message,
    Reasoning,
}

#[derive(Clone, Debug, Default)]
struct ToolState {
    kind: Option<String>,
    title: Option<String>,
    output: Option<String>,
}

pub struct AcpEventMapper {
    turn_id: String,
    open: HashMap<TextKind, Item>,
    tools: HashMap<String, ToolState>,
    counter: u64,
    anonymous_sequence: u64,
}

impl AcpEventMapper {
    pub fn new(turn_id: impl Into<String>) -> Self {
        Self {
            turn_id: turn_id.into(),
            open: HashMap::new(),
            tools: HashMap::new(),
            counter: 0,
            anonymous_sequence: 0,
        }
    }

    pub fn note(&mut self, tool_call_id: &str, kind: Option<&str>, title: Option<&str>) {
        let known = self.tools.entry(tool_call_id.into()).or_default();
        if let Some(kind) = kind {
            known.kind = Some(kind.into());
        }
        if let Some(title) = title {
            known.title = Some(title.into());
        }
    }

    pub fn reset(&mut self) {
        self.open.clear();
        self.tools.clear();
    }

    pub fn finish(&mut self, status: TurnStatus) -> Vec<DomainEvent> {
        let mut events = Vec::new();
        if let Some(event) = self.complete(TextKind::Message, status) {
            events.push(event);
        }
        if let Some(event) = self.complete(TextKind::Reasoning, status) {
            events.push(event);
        }
        self.tools.clear();
        events
    }

    pub fn translate(&mut self, update: &Value, created_at: f64) -> Vec<DomainEvent> {
        match string(update, "sessionUpdate") {
            Some("agent_message_chunk") => {
                self.chunk(TextKind::Message, text_of(update), created_at)
            }
            Some("agent_thought_chunk") => {
                self.chunk(TextKind::Reasoning, text_of(update), created_at)
            }
            Some("tool_call" | "tool_call_update") => self.tool_call(update, created_at),
            Some("plan") => vec![DomainEvent::PlanUpdated {
                turn_id: self.turn_id.clone(),
                steps: plan_steps(update),
            }],
            _ => Vec::new(),
        }
    }

    fn chunk(&mut self, kind: TextKind, text: &str, created_at: f64) -> Vec<DomainEvent> {
        if text.is_empty() {
            return Vec::new();
        }
        if let Some(existing) = self.open.get_mut(&kind) {
            existing.text.get_or_insert_default().push_str(text);
            return vec![DomainEvent::ItemDelta {
                turn_id: self.turn_id.clone(),
                item_id: existing.id.clone(),
                text_delta: text.into(),
            }];
        }
        self.counter = self.counter.saturating_add(1);
        let label = match kind {
            TextKind::Message => "message",
            TextKind::Reasoning => "reasoning",
        };
        let item = Item {
            id: format!("{}-{label}-{}", self.turn_id, self.counter),
            turn_id: self.turn_id.clone(),
            item_type: match kind {
                TextKind::Message => ItemType::Message,
                TextKind::Reasoning => ItemType::Reasoning,
            },
            status: ItemStatus::Started,
            role: (kind == TextKind::Message).then_some(MessageRole::Assistant),
            text: Some(text.into()),
            command: None,
            exit_code: None,
            duration_ms: None,
            path: None,
            lines_added: None,
            lines_removed: None,
            created_at,
        };
        self.open.insert(kind, item.clone());
        vec![DomainEvent::ItemStarted { item }]
    }

    fn complete(&mut self, kind: TextKind, status: TurnStatus) -> Option<DomainEvent> {
        let mut item = self.open.remove(&kind)?;
        item.status = if status == TurnStatus::Failed {
            ItemStatus::Failed
        } else {
            ItemStatus::Completed
        };
        Some(DomainEvent::ItemCompleted { item })
    }

    fn tool_call(&mut self, update: &Value, created_at: f64) -> Vec<DomainEvent> {
        let explicit_id = string(update, "toolCallId");
        let id = explicit_id.map(str::to_owned).unwrap_or_else(|| {
            format!(
                "{}-tool-anonymous-{}",
                self.turn_id, self.anonymous_sequence
            )
        });
        let known = self.tools.get(&id).cloned().unwrap_or_default();
        let kind = string(update, "kind").map(str::to_owned).or(known.kind);
        let title = string(update, "title").map(str::to_owned).or(known.title);
        let chunk = output_of(update);
        let output = if chunk.is_empty() {
            known.output
        } else {
            Some(format!("{}{chunk}", known.output.unwrap_or_default()))
        };
        self.tools.insert(
            id.clone(),
            ToolState {
                kind: kind.clone(),
                title: title.clone(),
                output: output.clone(),
            },
        );

        let item_type = match kind.as_deref() {
            Some("execute") => ItemType::Command,
            Some("edit" | "delete" | "move") => ItemType::FileChange,
            Some("think") => ItemType::Reasoning,
            _ => ItemType::ToolCall,
        };
        let status = string(update, "status");
        let finished = matches!(status, Some("completed" | "failed"));
        let completed_message = self.complete(TextKind::Message, TurnStatus::Completed);
        let mut item = Item {
            id: id.clone(),
            turn_id: self.turn_id.clone(),
            item_type,
            status: if status == Some("failed") {
                ItemStatus::Failed
            } else if finished {
                ItemStatus::Completed
            } else {
                ItemStatus::Started
            },
            role: None,
            text: None,
            command: None,
            exit_code: None,
            duration_ms: None,
            path: None,
            lines_added: None,
            lines_removed: None,
            created_at,
        };
        match item_type {
            ItemType::Command => item.command = Some(title.unwrap_or_else(|| "command".into())),
            ItemType::FileChange => {
                item.path = Some(
                    location_path(update)
                        .or_else(|| path_from_content(update))
                        .or(title)
                        .unwrap_or_default(),
                );
            }
            _ => item.text = Some(title.unwrap_or_else(|| "tool".into())),
        }
        if let Some(output) = output.filter(|output| !output.is_empty()) {
            item.text = Some(match item.text {
                Some(text) if !text.is_empty() => format!("{text}\n{output}"),
                _ => output,
            });
        }
        if finished && explicit_id.is_none() {
            self.tools.remove(&id);
            self.anonymous_sequence = self.anonymous_sequence.saturating_add(1);
        }

        let mut events = Vec::new();
        if let Some(event) = completed_message {
            events.push(event);
        }
        events.push(if finished {
            DomainEvent::ItemCompleted { item }
        } else {
            DomainEvent::ItemStarted { item }
        });
        if let Some(diff) = diff_of(update) {
            events.push(DomainEvent::DiffUpdated {
                turn_id: self.turn_id.clone(),
                diff,
            });
        }
        events
    }
}

fn text_of(update: &Value) -> &str {
    update
        .get("content")
        .filter(|content| !content.is_array())
        .and_then(|content| string(content, "text"))
        .unwrap_or_default()
}

fn output_of(update: &Value) -> String {
    update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| string(part, "type") == Some("content"))
        .filter_map(|part| part.get("content"))
        .filter_map(|content| string(content, "text"))
        .collect::<String>()
        .trim()
        .to_owned()
}

fn location_path(update: &Value) -> Option<String> {
    update
        .get("locations")
        .and_then(Value::as_array)
        .and_then(|locations| locations.first())
        .and_then(|location| string(location, "path"))
        .map(str::to_owned)
}

fn path_from_content(update: &Value) -> Option<String> {
    update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|part| string(part, "type") == Some("diff"))
        .and_then(|part| string(part, "path"))
        .map(str::to_owned)
}

fn diff_of(update: &Value) -> Option<String> {
    let parts = update
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter(|part| string(part, "type") == Some("diff"))
        .map(|part| {
            let path = string(part, "path").unwrap_or("file");
            let before = part
                .get("oldText")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let after = string(part, "newText").unwrap_or_default();
            format!(
                "--- a/{path}\n+++ b/{path}\n{}{}",
                signed_body(before, '-'),
                signed_body(after, '+')
            )
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn signed_body(text: &str, sign: char) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut body = text
        .split('\n')
        .map(|line| format!("{sign}{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    body.push('\n');
    body
}

fn plan_steps(update: &Value) -> Vec<PlanStep> {
    update
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|entry| PlanStep {
            text: string(entry, "content").unwrap_or_default().into(),
            status: match string(entry, "status") {
                Some("completed") => PlanStepStatus::Done,
                Some("in_progress") => PlanStepStatus::Running,
                _ => PlanStepStatus::Pending,
            },
        })
        .collect()
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AT: f64 = 1_000.0;

    fn chunk(kind: &str, text: &str) -> Value {
        json!({
            "sessionUpdate": kind,
            "content": { "type": "text", "text": text }
        })
    }

    #[test]
    fn folds_text_chunks_and_keeps_reasoning_separate() {
        let mut mapper = AcpEventMapper::new("turn-1");
        let first = mapper.translate(&chunk("agent_message_chunk", "hello"), AT);
        let second = mapper.translate(&chunk("agent_message_chunk", " world"), AT);
        let thought = mapper.translate(&chunk("agent_thought_chunk", "reasoning"), AT);
        let message_id = match &first[0] {
            DomainEvent::ItemStarted { item } => item.id.clone(),
            event => panic!("unexpected event: {event:?}"),
        };
        assert!(matches!(
            &second[0],
            DomainEvent::ItemDelta { item_id, text_delta, .. }
                if item_id == &message_id && text_delta == " world"
        ));
        assert!(matches!(
            &thought[0],
            DomainEvent::ItemStarted { item } if item.item_type == ItemType::Reasoning
        ));
        let completed = mapper.finish(TurnStatus::Completed);
        assert!(completed.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.id == message_id && item.text.as_deref() == Some("hello world")
        )));
    }

    #[test]
    fn preserves_a_permissioned_commands_identity_until_completion() {
        let mut mapper = AcpEventMapper::new("turn-1");
        mapper.note("command-1", Some("execute"), Some("cargo test"));
        let events = mapper.translate(
            &json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "command-1",
                "status": "completed",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": "passed" }
                }]
            }),
            AT,
        );
        assert!(matches!(
            &events[0],
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Command
                    && item.command.as_deref() == Some("cargo test")
                    && item.text.as_deref() == Some("passed")
        ));
    }

    #[test]
    fn completes_prose_before_a_tool_and_accumulates_its_output() {
        let mut mapper = AcpEventMapper::new("turn-1");
        mapper.translate(&chunk("agent_message_chunk", "before"), AT);
        let started = mapper.translate(
            &json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "command-1",
                "kind": "execute",
                "title": "build",
                "status": "in_progress",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": "step one\n" }
                }]
            }),
            AT,
        );
        assert!(matches!(
            &started[0],
            DomainEvent::ItemCompleted { item } if item.text.as_deref() == Some("before")
        ));
        mapper.translate(
            &json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "command-1",
                "status": "in_progress",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": "step two\n" }
                }]
            }),
            AT,
        );
        let completed = mapper.translate(
            &json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "command-1",
                "status": "completed",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": "done" }
                }]
            }),
            AT,
        );
        assert!(completed.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.text.as_deref().is_some_and(|text|
                    text.contains("step one") && text.contains("step two") && text.contains("done"))
        )));
        assert!(matches!(
            &mapper.translate(&chunk("agent_message_chunk", "after"), AT)[0],
            DomainEvent::ItemStarted { .. }
        ));
    }

    #[test]
    fn maps_file_changes_diffs_and_plan_statuses() {
        let mut mapper = AcpEventMapper::new("turn-1");
        let events = mapper.translate(
            &json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "edit-1",
                "kind": "edit",
                "status": "completed",
                "content": [{
                    "type": "diff",
                    "path": "/repo/a.rs",
                    "oldText": "old",
                    "newText": "new"
                }]
            }),
            AT,
        );
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::FileChange
                    && item.path.as_deref() == Some("/repo/a.rs")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::DiffUpdated { diff, .. }
                if diff.contains("-old") && diff.contains("+new")
        )));
        let plan = mapper.translate(
            &json!({
                "sessionUpdate": "plan",
                "entries": [
                    { "content": "done", "status": "completed" },
                    { "content": "doing", "status": "in_progress" },
                    { "content": "later", "status": "pending" }
                ]
            }),
            AT,
        );
        assert!(matches!(
            &plan[0],
            DomainEvent::PlanUpdated { steps, .. }
                if steps.iter().map(|step| step.status).collect::<Vec<_>>()
                    == [PlanStepStatus::Done, PlanStepStatus::Running, PlanStepStatus::Pending]
        ));
    }

    #[test]
    fn folds_idless_frames_then_advances_for_the_next_call() {
        let mut mapper = AcpEventMapper::new("turn-1");
        let first = mapper.translate(
            &json!({
                "sessionUpdate": "tool_call",
                "kind": "execute",
                "title": "first",
                "status": "in_progress"
            }),
            AT,
        );
        let first_id = match &first[0] {
            DomainEvent::ItemStarted { item } => item.id.clone(),
            event => panic!("unexpected event: {event:?}"),
        };
        let completed = mapper.translate(
            &json!({
                "sessionUpdate": "tool_call_update",
                "status": "completed"
            }),
            AT,
        );
        assert!(matches!(
            &completed[0],
            DomainEvent::ItemCompleted { item } if item.id == first_id
        ));
        let next = mapper.translate(
            &json!({
                "sessionUpdate": "tool_call",
                "kind": "execute",
                "title": "second",
                "status": "in_progress"
            }),
            AT,
        );
        assert!(matches!(
            &next[0],
            DomainEvent::ItemStarted { item } if item.id != first_id
        ));
    }

    #[test]
    fn ignores_unknown_and_empty_updates() {
        let mut mapper = AcpEventMapper::new("turn-1");
        assert!(
            mapper
                .translate(&chunk("agent_message_chunk", ""), AT)
                .is_empty()
        );
        assert!(
            mapper
                .translate(&json!({ "sessionUpdate": "something_new" }), AT)
                .is_empty()
        );
        assert!(mapper.translate(&json!({}), AT).is_empty());
    }
}
