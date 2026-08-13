use harness_protocol::{DomainEvent, Item, ItemStatus, ItemType, MessageRole, TurnStatus, Usage};
use serde_json::Value;

#[derive(Debug, Default)]
pub(crate) struct AntigravityFrameResult {
    pub(crate) events: Vec<DomainEvent>,
    pub(crate) conversation_id: Option<String>,
    pub(crate) terminal: Option<TurnStatus>,
}

#[derive(Debug)]
pub struct AntigravityEventMapper {
    turn_id: String,
    thread_id: String,
    message_id: String,
    message_text: String,
    message_started: bool,
    terminal: Option<TurnStatus>,
}

impl AntigravityEventMapper {
    pub fn new(turn_id: &str, thread_id: &str) -> Self {
        Self {
            turn_id: turn_id.into(),
            thread_id: thread_id.into(),
            message_id: format!("{turn_id}-message"),
            message_text: String::new(),
            message_started: false,
            terminal: None,
        }
    }

    pub(crate) fn translate(&mut self, frame: &Value, now: f64) -> AntigravityFrameResult {
        if self.terminal.is_some() {
            return AntigravityFrameResult::default();
        }
        match string(frame, "event") {
            Some("init") => AntigravityFrameResult {
                conversation_id: string(frame, "conversation_id").map(str::to_owned),
                ..AntigravityFrameResult::default()
            },
            Some("step_update")
                if frame
                    .pointer("/step_update/step_type")
                    .and_then(Value::as_str)
                    == Some("agent_response") =>
            {
                self.push_delta(frame, now)
            }
            Some("result") => self.finish(frame, now),
            _ => AntigravityFrameResult::default(),
        }
    }

    fn push_delta(&mut self, frame: &Value, now: f64) -> AntigravityFrameResult {
        let Some(delta) = frame
            .pointer("/step_update/text_delta")
            .and_then(Value::as_str)
            .filter(|delta| !delta.is_empty())
        else {
            return AntigravityFrameResult::default();
        };
        let mut events = Vec::with_capacity(2);
        if !self.message_started {
            self.message_started = true;
            events.push(DomainEvent::ItemStarted {
                item: message_item(
                    &self.message_id,
                    &self.turn_id,
                    ItemStatus::Started,
                    String::new(),
                    now,
                ),
            });
        }
        self.message_text.push_str(delta);
        events.push(DomainEvent::ItemDelta {
            turn_id: self.turn_id.clone(),
            item_id: self.message_id.clone(),
            text_delta: delta.into(),
        });
        AntigravityFrameResult {
            events,
            ..AntigravityFrameResult::default()
        }
    }

    fn finish(&mut self, frame: &Value, now: f64) -> AntigravityFrameResult {
        let Some(result) = frame.get("result").filter(|result| result.is_object()) else {
            return AntigravityFrameResult::default();
        };
        let mut events = Vec::new();
        let text = string(result, "response").unwrap_or(&self.message_text);
        if self.message_started || !text.trim().is_empty() {
            events.push(DomainEvent::ItemCompleted {
                item: message_item(
                    &self.message_id,
                    &self.turn_id,
                    ItemStatus::Completed,
                    text.trim_end().into(),
                    now,
                ),
            });
        }
        if let Some(usage) = result.get("usage").filter(|usage| usage.is_object()) {
            events.push(DomainEvent::UsageUpdated {
                usage: Usage {
                    input_tokens: number(usage, "input_tokens"),
                    cached_input_tokens: number(usage, "cache_read_tokens"),
                    output_tokens: number(usage, "output_tokens"),
                    reasoning_tokens: number(usage, "thinking_tokens"),
                    total_tokens: number(usage, "total_tokens"),
                    cost_usd: None,
                    context_window: None,
                },
            });
        }
        let terminal = if string(result, "status") == Some("SUCCESS") {
            TurnStatus::Completed
        } else {
            events.push(DomainEvent::ThreadError {
                thread_id: self.thread_id.clone(),
                message: format!(
                    "Antigravity finished with status {}",
                    string(result, "status").unwrap_or("unknown")
                ),
            });
            TurnStatus::Failed
        };
        self.terminal = Some(terminal);
        AntigravityFrameResult {
            events,
            conversation_id: string(result, "conversation_id").map(str::to_owned),
            terminal: Some(terminal),
        }
    }
}

fn message_item(id: &str, turn_id: &str, status: ItemStatus, text: String, now: f64) -> Item {
    Item {
        id: id.into(),
        turn_id: turn_id.into(),
        item_type: ItemType::Message,
        status,
        role: Some(MessageRole::Assistant),
        text: Some(text),
        command: None,
        exit_code: None,
        duration_ms: None,
        path: None,
        lines_added: None,
        lines_removed: None,
        created_at: now,
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_captured_stream_to_message_usage_and_completion() {
        let mut mapper = AntigravityEventMapper::new("turn-1", "thread-1");
        let mut events = Vec::new();
        let mut conversation_id = None;
        let mut terminal = None;
        for line in include_str!("../fixtures/stream.jsonl").lines() {
            let frame = serde_json::from_str(line).unwrap();
            let result = mapper.translate(&frame, 10.0);
            events.extend(result.events);
            conversation_id = result.conversation_id.or(conversation_id);
            terminal = result.terminal.or(terminal);
        }
        assert_eq!(terminal, Some(TurnStatus::Completed));
        assert_eq!(
            conversation_id.as_deref(),
            Some("9f1827a7-3506-4a85-add9-63182b9917a4")
        );
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemDelta { text_delta, .. } if text_delta == "MOND"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.text.as_deref() == Some("MONDLICHT")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::UsageUpdated { usage }
                if usage.input_tokens == 26_368.0 && usage.total_tokens == 26_374.0
        )));
    }

    #[test]
    fn reports_failed_results_once() {
        let mut mapper = AntigravityEventMapper::new("turn-1", "thread-1");
        let frame = serde_json::json!({
            "event": "result",
            "result": { "status": "FAILED", "response": "" }
        });
        let result = mapper.translate(&frame, 1.0);
        assert_eq!(result.terminal, Some(TurnStatus::Failed));
        assert!(matches!(
            result.events.as_slice(),
            [DomainEvent::ThreadError { .. }]
        ));
        assert!(mapper.translate(&frame, 2.0).events.is_empty());
    }
}
