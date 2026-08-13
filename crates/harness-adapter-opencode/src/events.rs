use harness_protocol::{DomainEvent, Item, ItemStatus, ItemType, MessageRole, TurnStatus, Usage};
use serde_json::Value;

struct OpenItem {
    item: Item,
    text: Option<String>,
    completed: bool,
}

pub struct OpenCodeEventMapper {
    turn_id: String,
    open: Vec<OpenItem>,
}

impl OpenCodeEventMapper {
    pub fn new(turn_id: impl Into<String>) -> Self {
        Self {
            turn_id: turn_id.into(),
            open: Vec::new(),
        }
    }

    pub fn translate(&mut self, event: &Value, created_at: f64) -> Vec<DomainEvent> {
        match string(event, "type") {
            Some("message.part.updated") => {
                let Some(part) = event.get("properties").and_then(|value| value.get("part")) else {
                    return Vec::new();
                };
                let delta = event
                    .get("properties")
                    .and_then(|value| string(value, "delta"));
                self.part(part, delta, created_at)
            }
            Some("message.updated") => self.message_updated(event),
            Some("session.diff") => self.diff(event, created_at),
            _ => Vec::new(),
        }
    }

    pub fn finish(&mut self, status: TurnStatus) -> Vec<DomainEvent> {
        self.open
            .iter_mut()
            .filter(|entry| !entry.completed)
            .map(|entry| {
                entry.completed = true;
                let mut item = entry.item.clone();
                item.status = if status == TurnStatus::Failed {
                    ItemStatus::Failed
                } else {
                    ItemStatus::Completed
                };
                if let Some(text) = &entry.text {
                    item.text = Some(text.clone());
                }
                DomainEvent::ItemCompleted { item }
            })
            .collect()
    }

    fn part(&mut self, part: &Value, delta: Option<&str>, created_at: f64) -> Vec<DomainEvent> {
        match string(part, "type") {
            Some("text" | "reasoning") => self.text_part(part, delta, created_at),
            Some("tool") => self.tool_part(part, created_at),
            Some("step-finish") => usage_event(part).into_iter().collect(),
            _ => Vec::new(),
        }
    }

    fn text_part(
        &mut self,
        part: &Value,
        delta: Option<&str>,
        created_at: f64,
    ) -> Vec<DomainEvent> {
        let Some(part_id) = string(part, "id") else {
            return Vec::new();
        };
        let id = format!("{}-{part_id}", self.turn_id);
        let item_type = if string(part, "type") == Some("text") {
            ItemType::Message
        } else {
            ItemType::Reasoning
        };
        let mut events = Vec::new();
        let index = if let Some(index) = self.open.iter().position(|entry| entry.item.id == id) {
            index
        } else {
            let item = Item {
                id,
                turn_id: self.turn_id.clone(),
                item_type,
                status: ItemStatus::Started,
                role: (item_type == ItemType::Message).then_some(MessageRole::Assistant),
                text: Some(String::new()),
                command: None,
                exit_code: None,
                duration_ms: None,
                path: None,
                lines_added: None,
                lines_removed: None,
                created_at: part
                    .get("time")
                    .and_then(|time| number(time, "start"))
                    .unwrap_or(created_at),
            };
            events.push(DomainEvent::ItemStarted { item: item.clone() });
            self.open.push(OpenItem {
                item,
                text: Some(String::new()),
                completed: false,
            });
            self.open.len() - 1
        };

        let entry = &mut self.open[index];
        let previous = entry.text.as_deref().unwrap_or_default();
        let full_text = string(part, "text").unwrap_or_default();
        let next = delta.map(str::to_owned).unwrap_or_else(|| {
            full_text
                .strip_prefix(previous)
                .unwrap_or(full_text)
                .to_owned()
        });
        if !next.is_empty() {
            if delta.is_some() {
                entry.text.get_or_insert_default().push_str(&next);
            } else {
                entry.text = Some(full_text.into());
            }
            events.push(DomainEvent::ItemDelta {
                turn_id: self.turn_id.clone(),
                item_id: entry.item.id.clone(),
                text_delta: next,
            });
        }
        let ended = part
            .get("time")
            .and_then(|time| number(time, "end"))
            .is_some_and(|end| end != 0.0);
        if ended && !entry.completed {
            entry.completed = true;
            let mut item = entry.item.clone();
            item.status = ItemStatus::Completed;
            item.text = entry.text.clone();
            events.push(DomainEvent::ItemCompleted { item });
        }
        events
    }

    fn tool_part(&mut self, part: &Value, created_at: f64) -> Vec<DomainEvent> {
        let (Some(part_id), Some(name), Some(state)) =
            (string(part, "id"), string(part, "tool"), part.get("state"))
        else {
            return Vec::new();
        };
        let id = format!("{}-{part_id}", self.turn_id);
        let kind = tool_kind(name);
        let input = state.get("input");
        let title = string(state, "title").unwrap_or_default();
        let command = input
            .and_then(|input| string(input, "command"))
            .or_else(|| input.and_then(|input| string(input, "cmd")))
            .filter(|value| !value.is_empty())
            .or_else(|| (!title.is_empty()).then_some(title))
            .unwrap_or(name);
        let path = input
            .and_then(|input| string(input, "filePath"))
            .or_else(|| input.and_then(|input| string(input, "path")))
            .filter(|value| !value.is_empty());
        let item = Item {
            id: id.clone(),
            turn_id: self.turn_id.clone(),
            item_type: kind,
            status: ItemStatus::Started,
            role: None,
            text: (kind == ItemType::ToolCall)
                .then(|| if title.is_empty() { name } else { title }.to_owned()),
            command: (kind == ItemType::Command).then(|| command.into()),
            exit_code: None,
            duration_ms: None,
            path: (kind == ItemType::FileChange)
                .then(|| path.map(str::to_owned))
                .flatten(),
            lines_added: None,
            lines_removed: None,
            created_at: state
                .get("time")
                .and_then(|time| number(time, "start"))
                .unwrap_or(created_at),
        };
        let mut events = Vec::new();
        let index = if let Some(index) = self.open.iter().position(|entry| entry.item.id == id) {
            index
        } else {
            events.push(DomainEvent::ItemStarted { item: item.clone() });
            self.open.push(OpenItem {
                item: item.clone(),
                text: None,
                completed: false,
            });
            self.open.len() - 1
        };
        let status = string(state, "status");
        if matches!(status, Some("completed" | "error")) && !self.open[index].completed {
            self.open[index].completed = true;
            let mut completed = item;
            completed.status = if status == Some("error") {
                ItemStatus::Failed
            } else {
                ItemStatus::Completed
            };
            if kind == ItemType::ToolCall {
                completed.text = Some(if status == Some("error") {
                    string(state, "error").unwrap_or_default().into()
                } else {
                    format!(
                        "{}\n{}",
                        string(state, "title").unwrap_or_default(),
                        string(state, "output").unwrap_or_default()
                    )
                });
            }
            if let Some(time) = state.get("time")
                && let (Some(start), Some(end)) = (number(time, "start"), number(time, "end"))
                && end != 0.0
            {
                completed.duration_ms = Some(end - start);
            }
            events.push(DomainEvent::ItemCompleted { item: completed });
        }
        events
    }

    fn message_updated(&self, event: &Value) -> Vec<DomainEvent> {
        let Some(info) = event.get("properties").and_then(|value| value.get("info")) else {
            return Vec::new();
        };
        let completed = info
            .get("time")
            .and_then(|time| number(time, "completed"))
            .is_some_and(|completed| completed != 0.0);
        if string(info, "role") == Some("assistant") && completed {
            usage_event(info).into_iter().collect()
        } else {
            Vec::new()
        }
    }

    fn diff(&self, event: &Value, created_at: f64) -> Vec<DomainEvent> {
        event
            .get("properties")
            .and_then(|value| value.get("diff"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, diff)| {
                Some(DomainEvent::ItemCompleted {
                    item: Item {
                        id: format!("{}-diff-{index}", self.turn_id),
                        turn_id: self.turn_id.clone(),
                        item_type: ItemType::FileChange,
                        status: ItemStatus::Completed,
                        role: None,
                        text: None,
                        command: None,
                        exit_code: None,
                        duration_ms: None,
                        path: Some(string(diff, "file")?.into()),
                        lines_added: integer(diff, "additions"),
                        lines_removed: integer(diff, "deletions"),
                        created_at,
                    },
                })
            })
            .collect()
    }
}

pub fn event_session_id(event: &Value) -> Option<&str> {
    let properties = event.get("properties")?;
    string(properties, "sessionID")
        .or_else(|| {
            properties
                .get("part")
                .and_then(|part| string(part, "sessionID"))
        })
        .or_else(|| {
            properties
                .get("info")
                .and_then(|info| string(info, "sessionID"))
        })
}

fn usage_event(value: &Value) -> Option<DomainEvent> {
    let tokens = value.get("tokens")?;
    let input_tokens = number(tokens, "input").unwrap_or(0.0);
    let output_tokens = number(tokens, "output").unwrap_or(0.0);
    let reasoning_tokens = number(tokens, "reasoning").unwrap_or(0.0);
    let cached_input_tokens = tokens
        .get("cache")
        .and_then(|cache| number(cache, "read"))
        .unwrap_or(0.0);
    Some(DomainEvent::UsageUpdated {
        usage: Usage {
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_tokens,
            total_tokens: input_tokens + output_tokens + reasoning_tokens,
            cost_usd: number(value, "cost"),
            context_window: None,
        },
    })
}

fn tool_kind(name: &str) -> ItemType {
    match name.to_ascii_lowercase().as_str() {
        "bash" | "shell" | "command" => ItemType::Command,
        "edit" | "write" | "patch" | "multiedit" => ItemType::FileChange,
        _ => ItemType::ToolCall,
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn integer(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AT: f64 = 1_000.0;

    #[test]
    fn maps_the_captured_stream_without_vendor_fields() {
        let captured: Vec<Value> =
            serde_json::from_str(include_str!("fixtures/events.json")).unwrap();
        let mut mapper = OpenCodeEventMapper::new("turn-1");
        let events = captured
            .iter()
            .flat_map(|event| mapper.translate(event, AT))
            .collect::<Vec<_>>();

        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemDelta { text_delta, .. }
                if text_delta == "Checking the repository."
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemStarted { item }
                if item.item_type == ItemType::Command
                    && item.command.as_deref() == Some("git status --short")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Command
                    && item.duration_ms == Some(50.0)
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::UsageUpdated { usage }
                if usage.input_tokens == 10.0
                    && usage.cached_input_tokens == 3.0
                    && usage.output_tokens == 5.0
                    && usage.reasoning_tokens == 2.0
                    && usage.total_tokens == 17.0
                    && usage.cost_usd == Some(0.01)
        )));
        assert_eq!(event_session_id(&captured[0]), Some("session-1"));
    }

    #[test]
    fn derives_snapshot_deltas_and_finishes_open_items_once() {
        let mut mapper = OpenCodeEventMapper::new("turn-1");
        let first = mapper.translate(
            &json!({
                "type": "message.part.updated",
                "properties": { "part": { "id": "text", "type": "text", "text": "Hello" } }
            }),
            AT,
        );
        let second = mapper.translate(
            &json!({
                "type": "message.part.updated",
                "properties": { "part": { "id": "text", "type": "text", "text": "Hello world" } }
            }),
            AT,
        );
        assert!(matches!(
            &first[1],
            DomainEvent::ItemDelta { text_delta, .. } if text_delta == "Hello"
        ));
        assert!(matches!(
            &second[0],
            DomainEvent::ItemDelta { text_delta, .. } if text_delta == " world"
        ));
        let finished = mapper.finish(TurnStatus::Failed);
        assert!(matches!(
            &finished[0],
            DomainEvent::ItemCompleted { item }
                if item.status == ItemStatus::Failed
                    && item.text.as_deref() == Some("Hello world")
        ));
        assert!(mapper.finish(TurnStatus::Failed).is_empty());
    }

    #[test]
    fn maps_diffs_and_tolerates_unknown_partial_events() {
        let mut mapper = OpenCodeEventMapper::new("turn-1");
        let events = mapper.translate(
            &json!({
                "type": "session.diff",
                "properties": {
                    "diff": [{ "file": "src/app.rs", "additions": 4, "deletions": 2 }]
                }
            }),
            AT,
        );
        assert!(matches!(
            &events[0],
            DomainEvent::ItemCompleted { item }
                if item.path.as_deref() == Some("src/app.rs")
                    && item.lines_added == Some(4)
                    && item.lines_removed == Some(2)
        ));
        for event in [json!({}), json!({ "type": "future" })] {
            assert!(mapper.translate(&event, AT).is_empty());
        }
    }
}
