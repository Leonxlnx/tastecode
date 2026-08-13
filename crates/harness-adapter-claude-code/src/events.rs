use harness_protocol::{DomainEvent, Item, ItemStatus, ItemType, MessageRole, TurnStatus, Usage};
use serde_json::Value;

const SHELL_TOOLS: &[&str] = &["Bash", "PowerShell"];
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "NotebookEdit"];

/// Map one Claude Code stream-json envelope captured from 2.1.220.
/// Every lookup is tolerant because this CLI surface has no published schema.
pub fn map_domain_events(event: &Value, turn_id: &str, created_at: f64) -> Vec<DomainEvent> {
    match string(event, "type") {
        Some("assistant") => assistant_events(event, turn_id, created_at),
        Some("user") => tool_result_events(event, turn_id, created_at),
        Some("result") => result_events(event, turn_id),
        _ => Vec::new(),
    }
}

pub fn map_usage(usage: Option<&Value>, cost_usd: Option<f64>) -> Option<Usage> {
    let usage = usage?.as_object()?;
    let input_tokens = number(usage.get("input_tokens"));
    let output_tokens = number(usage.get("output_tokens"));
    let cached_input_tokens = number(usage.get("cache_read_input_tokens"));
    let cache_creation_tokens = number(usage.get("cache_creation_input_tokens"));
    Some(Usage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_tokens: 0.0,
        total_tokens: input_tokens + output_tokens + cached_input_tokens + cache_creation_tokens,
        cost_usd,
        context_window: None,
    })
}

fn assistant_events(event: &Value, turn_id: &str, created_at: f64) -> Vec<DomainEvent> {
    let Some(content) = event
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let id_root = event
        .get("message")
        .and_then(|message| string(message, "id"))
        .or_else(|| string(event, "uuid"))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{created_at:.0}"));
    content
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            map_block(block, format!("{id_root}-{index}"), turn_id, created_at)
        })
        .map(|item| DomainEvent::ItemCompleted { item })
        .collect()
}

fn tool_result_events(event: &Value, turn_id: &str, created_at: f64) -> Vec<DomainEvent> {
    let Some(content) = event
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|block| string(block, "type") == Some("tool_result"))
        .filter_map(|block| {
            let text = flatten_content(block.get("content"));
            (!text.is_empty()).then(|| DomainEvent::ItemCompleted {
                item: Item {
                    id: format!(
                        "{}-result",
                        string(block, "tool_use_id")
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("{created_at:.0}"))
                    ),
                    turn_id: turn_id.into(),
                    item_type: if boolean(block, "is_error") {
                        ItemType::Error
                    } else {
                        ItemType::ToolCall
                    },
                    status: ItemStatus::Completed,
                    role: None,
                    text: Some(text),
                    command: None,
                    exit_code: None,
                    duration_ms: None,
                    path: None,
                    lines_added: None,
                    lines_removed: None,
                    created_at,
                },
            })
        })
        .collect()
}

fn result_events(event: &Value, turn_id: &str) -> Vec<DomainEvent> {
    let mut events = Vec::new();
    if let Some(usage) = map_usage(
        event.get("usage"),
        event.get("total_cost_usd").and_then(Value::as_f64),
    ) {
        events.push(DomainEvent::UsageUpdated { usage });
    }
    events.push(DomainEvent::TurnCompleted {
        turn_id: turn_id.into(),
        status: if boolean(event, "is_error") {
            TurnStatus::Failed
        } else {
            TurnStatus::Completed
        },
    });
    events
}

fn map_block(block: &Value, id: String, turn_id: &str, created_at: f64) -> Option<Item> {
    let item = |item_type, role, text, command, path| Item {
        id,
        turn_id: turn_id.into(),
        item_type,
        status: ItemStatus::Completed,
        role,
        text,
        command,
        exit_code: None,
        duration_ms: None,
        path,
        lines_added: None,
        lines_removed: None,
        created_at,
    };
    match string(block, "type")? {
        "text" => nonempty(block, "text").map(|text| {
            item(
                ItemType::Message,
                Some(MessageRole::Assistant),
                Some(text.into()),
                None,
                None,
            )
        }),
        "thinking" => nonempty(block, "thinking")
            .map(|text| item(ItemType::Reasoning, None, Some(text.into()), None, None)),
        "tool_use" => {
            let name = string(block, "name").unwrap_or("tool");
            let input = block.get("input");
            if SHELL_TOOLS.contains(&name) {
                Some(item(
                    ItemType::Command,
                    None,
                    None,
                    Some(
                        input
                            .and_then(|input| string(input, "command"))
                            .unwrap_or(name)
                            .into(),
                    ),
                    None,
                ))
            } else if EDIT_TOOLS.contains(&name) {
                Some(item(
                    ItemType::FileChange,
                    None,
                    None,
                    None,
                    Some(
                        input
                            .and_then(|input| string(input, "file_path"))
                            .unwrap_or_default()
                            .into(),
                    ),
                ))
            } else {
                Some(item(
                    ItemType::ToolCall,
                    None,
                    Some(name.into()),
                    None,
                    None,
                ))
            }
        }
        _ => None,
    }
}

fn flatten_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.as_str()),
                Value::Object(_) => string(part, "text"),
                _ => None,
            })
            .collect::<String>()
            .trim()
            .into(),
        _ => String::new(),
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn nonempty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    string(value, key).filter(|text| !text.is_empty())
}

fn boolean(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AT: f64 = 1_000.0;

    #[test]
    fn maps_captured_assistant_blocks_without_vendor_fields() {
        let events = map_domain_events(
            &json!({
                "type": "assistant",
                "message": {
                    "id": "msg_2",
                    "role": "assistant",
                    "model": "claude-fable-5",
                    "content": [
                        { "type": "thinking", "thinking": "Checking." },
                        { "type": "text", "text": "Found it." },
                        { "type": "tool_use", "id": "tu1", "name": "Bash", "input": { "command": "node -v" } },
                        { "type": "tool_use", "id": "tu2", "name": "Edit", "input": { "file_path": "src/app.ts" } },
                        { "type": "tool_use", "id": "tu3", "name": "WebSearch", "input": { "query": "docs" } }
                    ]
                }
            }),
            "turn-1",
            AT,
        );

        assert!(matches!(
            &events[0],
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Reasoning && item.text.as_deref() == Some("Checking.")
        ));
        assert!(matches!(
            &events[1],
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Message
                    && item.role == Some(MessageRole::Assistant)
                    && item.text.as_deref() == Some("Found it.")
        ));
        assert!(matches!(
            &events[2],
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Command
                    && item.command.as_deref() == Some("node -v")
        ));
        assert!(matches!(
            &events[3],
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::FileChange
                    && item.path.as_deref() == Some("src/app.ts")
        ));
        assert!(matches!(
            &events[4],
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::ToolCall
                    && item.text.as_deref() == Some("WebSearch")
        ));
    }

    #[test]
    fn maps_captured_tool_results_and_flattens_content_blocks() {
        let events = map_domain_events(
            &json!({
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "tu1",
                            "content": [{ "type": "text", "text": "not " }, "found"],
                            "is_error": true
                        },
                        { "type": "text", "text": "not rendered as a user message" }
                    ]
                }
            }),
            "turn-1",
            AT,
        );

        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            DomainEvent::ItemCompleted { item }
                if item.id == "tu1-result"
                    && item.item_type == ItemType::Error
                    && item.text.as_deref() == Some("not found")
        ));
    }

    #[test]
    fn maps_captured_result_usage_cost_and_failure() {
        let events = map_domain_events(
            &json!({
                "type": "result",
                "is_error": true,
                "duration_ms": 400,
                "total_cost_usd": 0.04,
                "usage": {
                    "input_tokens": 2,
                    "output_tokens": 4,
                    "cache_read_input_tokens": 24787,
                    "cache_creation_input_tokens": 9297
                }
            }),
            "turn-1",
            AT,
        );

        assert!(matches!(
            &events[0],
            DomainEvent::UsageUpdated { usage }
                if usage.cached_input_tokens == 24787.0
                    && usage.total_tokens == 34090.0
                    && usage.cost_usd == Some(0.04)
        ));
        assert_eq!(
            events[1],
            DomainEvent::TurnCompleted {
                turn_id: "turn-1".into(),
                status: TurnStatus::Failed,
            }
        );
    }

    #[test]
    fn ignores_unknown_and_partially_malformed_envelopes() {
        assert!(map_domain_events(&json!({ "type": "future" }), "turn-1", AT).is_empty());
        assert!(map_domain_events(&json!({}), "turn-1", AT).is_empty());
        assert!(
            map_domain_events(
                &json!({ "type": "assistant", "message": { "content": "wrong" } }),
                "turn-1",
                AT,
            )
            .is_empty()
        );
    }
}
