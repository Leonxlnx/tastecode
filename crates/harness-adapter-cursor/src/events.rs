use harness_protocol::{DomainEvent, Item, ItemStatus, ItemType, MessageRole, TurnStatus};
use serde_json::Value;

/// Stateful mapper for the stream-json envelopes captured from Cursor Agent.
/// The CLI has no published event schema, so every field lookup is tolerant.
pub struct CursorEventMapper {
    turn_id: String,
    message_id: String,
    message_started: bool,
    message: String,
    tools: Vec<(String, Item)>,
    finalized: bool,
}

impl CursorEventMapper {
    pub fn new(turn_id: impl Into<String>) -> Self {
        let turn_id = turn_id.into();
        Self {
            message_id: format!("{turn_id}-message"),
            turn_id,
            message_started: false,
            message: String::new(),
            tools: Vec::new(),
            finalized: false,
        }
    }

    pub fn translate(&mut self, event: &Value, created_at: f64) -> Vec<DomainEvent> {
        if self.finalized {
            return Vec::new();
        }
        match string(event, "type") {
            Some("assistant") => self.assistant(event, created_at),
            Some("tool_call") => self.tool(event, created_at),
            Some("result") => self.result(event, created_at),
            _ => Vec::new(),
        }
    }

    pub fn finish(&mut self, created_at: f64) -> Vec<DomainEvent> {
        if self.finalized {
            return Vec::new();
        }
        self.finalized = true;
        let mut events = Vec::new();
        if self.message_started {
            events.push(DomainEvent::ItemCompleted {
                item: self.message_item(ItemStatus::Failed, created_at, None),
            });
        }
        events.extend(self.tools.drain(..).map(|(_, mut item)| {
            item.status = ItemStatus::Failed;
            DomainEvent::ItemCompleted { item }
        }));
        events
    }

    fn assistant(&mut self, event: &Value, created_at: f64) -> Vec<DomainEvent> {
        let delta = event
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|part| string(part, "type") == Some("text"))
            .filter_map(|part| string(part, "text"))
            .collect::<String>();
        if delta.is_empty() {
            return Vec::new();
        }

        let mut events = Vec::with_capacity(2);
        if !self.message_started {
            self.message_started = true;
            events.push(DomainEvent::ItemStarted {
                item: self.message_item(ItemStatus::Started, created_at, None),
            });
        }
        self.message.push_str(&delta);
        events.push(DomainEvent::ItemDelta {
            turn_id: self.turn_id.clone(),
            item_id: self.message_id.clone(),
            text_delta: delta,
        });
        events
    }

    fn tool(&mut self, event: &Value, created_at: f64) -> Vec<DomainEvent> {
        let Some(call_id) = string(event, "call_id") else {
            return Vec::new();
        };
        let Some((name, call)) = event
            .get("tool_call")
            .and_then(Value::as_object)
            .and_then(|calls| calls.iter().next())
        else {
            return Vec::new();
        };
        let id = format!("{}-{call_id}", self.turn_id);
        let args = call.get("args").and_then(Value::as_object);
        match string(event, "subtype") {
            Some("started") => {
                let item = tool_item(id.clone(), &self.turn_id, name, args, created_at);
                if let Some((_, existing)) = self
                    .tools
                    .iter_mut()
                    .find(|(existing_id, _)| existing_id == &id)
                {
                    *existing = item.clone();
                } else {
                    self.tools.push((id, item.clone()));
                }
                vec![DomainEvent::ItemStarted { item }]
            }
            Some("completed") => {
                let mut item = self
                    .tools
                    .iter()
                    .position(|(existing_id, _)| existing_id == &id)
                    .map(|index| self.tools.remove(index).1)
                    .unwrap_or_else(|| tool_item(id, &self.turn_id, name, args, created_at));
                item.status = ItemStatus::Completed;
                vec![DomainEvent::ItemCompleted { item }]
            }
            _ => Vec::new(),
        }
    }

    fn result(&mut self, event: &Value, created_at: f64) -> Vec<DomainEvent> {
        self.finalized = true;
        let failed = boolean(event, "is_error");
        let mut events = Vec::new();
        if self.message_started {
            events.push(DomainEvent::ItemCompleted {
                item: self.message_item(
                    if failed {
                        ItemStatus::Failed
                    } else {
                        ItemStatus::Completed
                    },
                    created_at,
                    event.get("duration_ms").and_then(Value::as_f64),
                ),
            });
        }
        events.extend(self.tools.drain(..).map(|(_, mut item)| {
            item.status = ItemStatus::Failed;
            DomainEvent::ItemCompleted { item }
        }));
        events.push(DomainEvent::TurnCompleted {
            turn_id: self.turn_id.clone(),
            status: if failed {
                TurnStatus::Failed
            } else {
                TurnStatus::Completed
            },
        });
        events
    }

    fn message_item(&self, status: ItemStatus, created_at: f64, duration_ms: Option<f64>) -> Item {
        Item {
            id: self.message_id.clone(),
            turn_id: self.turn_id.clone(),
            item_type: ItemType::Message,
            status,
            role: Some(MessageRole::Assistant),
            text: Some(self.message.clone()),
            command: None,
            exit_code: None,
            duration_ms,
            path: None,
            lines_added: None,
            lines_removed: None,
            created_at,
        }
    }
}

fn tool_item(
    id: String,
    turn_id: &str,
    name: &str,
    args: Option<&serde_json::Map<String, Value>>,
    created_at: f64,
) -> Item {
    let lowered = name.to_ascii_lowercase();
    let (item_type, text, command, path) = if ["shell", "terminal", "command"]
        .iter()
        .any(|part| lowered.contains(part))
    {
        (
            ItemType::Command,
            None,
            Some(argument(args, "command").unwrap_or(name).into()),
            None,
        )
    } else if ["write", "edit", "delete", "move"]
        .iter()
        .any(|part| lowered.contains(part))
    {
        (
            ItemType::FileChange,
            None,
            None,
            Some(
                argument(args, "path")
                    .or_else(|| argument(args, "file_path"))
                    .or_else(|| argument(args, "filePath"))
                    .unwrap_or(name)
                    .into(),
            ),
        )
    } else {
        (ItemType::ToolCall, Some(name.into()), None, None)
    };
    Item {
        id,
        turn_id: turn_id.into(),
        item_type,
        status: ItemStatus::Started,
        role: None,
        text,
        command,
        exit_code: None,
        duration_ms: None,
        path,
        lines_added: None,
        lines_removed: None,
        created_at,
    }
}

fn argument<'a>(args: Option<&'a serde_json::Map<String, Value>>, key: &str) -> Option<&'a str> {
    args.and_then(|args| args.get(key)).and_then(Value::as_str)
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn boolean(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AT: f64 = 1_000.0;

    #[test]
    fn maps_the_captured_stream_without_vendor_fields() {
        let mut mapper = CursorEventMapper::new("turn-1");
        let events = include_str!("fixtures/stream.jsonl")
            .lines()
            .flat_map(|line| {
                let value = serde_json::from_str(line).unwrap();
                mapper.translate(&value, AT)
            })
            .collect::<Vec<_>>();

        assert!(matches!(
            &events[0],
            DomainEvent::ItemStarted { item }
                if item.item_type == ItemType::Message && item.text.as_deref() == Some("")
        ));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemDelta { text_delta, .. } if text_delta == "I'll update "
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemStarted { item }
                if item.item_type == ItemType::FileChange
                    && item.path.as_deref() == Some("README.md")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Message
                    && item.text.as_deref() == Some("I'll update README.")
                    && item.duration_ms == Some(25.0)
        )));
        assert_eq!(
            events.last(),
            Some(&DomainEvent::TurnCompleted {
                turn_id: "turn-1".into(),
                status: TurnStatus::Completed,
            })
        );
    }

    #[test]
    fn fails_open_items_when_the_stream_ends_without_a_result() {
        let mut mapper = CursorEventMapper::new("turn-1");
        let _ = mapper.translate(
            &json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": "partial" }] }
            }),
            AT,
        );
        let _ = mapper.translate(
            &json!({
                "type": "tool_call",
                "subtype": "started",
                "call_id": "tool-1",
                "tool_call": { "shellToolCall": { "args": { "command": "cargo test" } } }
            }),
            AT,
        );

        let events = mapper.finish(AT + 1.0);
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item } if item.status == ItemStatus::Failed
        )));
        assert!(mapper.finish(AT + 2.0).is_empty());
    }

    #[test]
    fn ignores_unknown_and_partial_envelopes() {
        let mut mapper = CursorEventMapper::new("turn-1");
        for value in [
            json!({}),
            json!({ "type": "future" }),
            json!({ "type": "assistant", "message": { "content": "wrong" } }),
            json!({ "type": "tool_call", "call_id": "missing-tool" }),
        ] {
            assert!(mapper.translate(&value, AT).is_empty());
        }
    }
}
