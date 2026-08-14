use harness_protocol::{Item, ItemStatus, ItemType, MessageRole};
use serde_json::Value;
use uuid::Uuid;

mod mcp;
mod notification;
mod runtime;
mod skills;
mod voice;

pub use harness_agent::{AgentHandlers as CodexHandlers, StartOptions, TurnOptions};
pub use mcp::{CODEX_MCP_CAPABILITIES, map_startup_status};
pub use notification::{NotificationMappingError, map_domain_notification};
pub use runtime::{
    CODEX_CAPABILITIES, CodexAdapter, CodexAdapterError, CodexLaunchOptions, CodexRuntime,
};
pub use skills::CODEX_SKILL_CAPABILITIES;
pub use voice::{MAX_VOICE_BYTES, MAX_VOICE_DURATION_MS, VOICE_SAMPLE_RATE};

/// Context supplied by the Codex lifecycle notification around a thread item.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ItemContext<'a> {
    pub turn_id: &'a str,
    pub status: ItemStatus,
    pub created_at: f64,
}

/// Translate a Codex `ThreadItem` into the provider-neutral TasteCode model.
///
/// The app-server union changes independently of TasteCode. Unknown and partial
/// variants therefore remain visible as `unknown` items instead of being
/// dropped or terminating the provider session.
pub fn map_thread_item(raw: &Value, context: ItemContext<'_>) -> Item {
    let wire_type = raw.get("type").and_then(Value::as_str).unwrap_or("unknown");
    let mut item = base_item(raw, context);

    match wire_type {
        "userMessage" => {
            item.item_type = ItemType::Message;
            item.role = Some(MessageRole::User);
            item.text = Some(user_input_text(raw.get("content")));
        }
        "agentMessage" => {
            item.item_type = ItemType::Message;
            item.role = Some(MessageRole::Assistant);
            item.text = string_field(raw, "text");
        }
        "reasoning" => {
            item.item_type = ItemType::Reasoning;
            let mut parts = string_array(raw.get("summary"));
            parts.extend(string_array(raw.get("content")));
            item.text = Some(parts.join("\n\n"));
        }
        "plan" => {
            item.item_type = ItemType::Plan;
            item.text = string_field(raw, "text");
        }
        "commandExecution" => {
            item.item_type = ItemType::Command;
            item.command = string_field(raw, "command");
            item.text = nullable_string_field(raw, "aggregatedOutput");
            item.exit_code = raw
                .get("exitCode")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok());
            item.duration_ms = raw.get("durationMs").and_then(Value::as_f64);
        }
        "fileChange" => {
            item.item_type = ItemType::FileChange;
            let changes = raw
                .get("changes")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            item.path = changes
                .first()
                .and_then(|change| string_field(change, "path"));
            item.text = Some(format!("{} file(s) changed", changes.len()));
        }
        "mcpToolCall" => {
            item.item_type = ItemType::ToolCall;
            let server = raw
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let tool = raw.get("tool").and_then(Value::as_str).unwrap_or_default();
            item.text = Some(format!("{server}.{tool}"));
            item.duration_ms = raw.get("durationMs").and_then(Value::as_f64);
        }
        "dynamicToolCall" => {
            item.item_type = ItemType::ToolCall;
            item.text = string_field(raw, "tool");
        }
        "webSearch" => {
            item.item_type = ItemType::ToolCall;
            item.text = Some("web search".into());
        }
        _ => {
            item.item_type = ItemType::Unknown;
            item.text = Some(format!("[{wire_type}]"));
        }
    }

    item
}

fn base_item(raw: &Value, context: ItemContext<'_>) -> Item {
    Item {
        id: raw
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        turn_id: context.turn_id.to_owned(),
        item_type: ItemType::Unknown,
        status: context.status,
        role: None,
        text: None,
        command: None,
        exit_code: None,
        duration_ms: None,
        path: None,
        lines_added: None,
        lines_removed: None,
        created_at: context.created_at,
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn nullable_string_field(value: &Value, field: &str) -> Option<String> {
    match value.get(field) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn user_input_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context(status: ItemStatus) -> ItemContext<'static> {
        ItemContext {
            turn_id: "turn-1",
            status,
            created_at: 1_785_627_335_059.0,
        }
    }

    #[test]
    fn maps_message_and_reasoning_items_from_captured_shapes() {
        let user = map_thread_item(
            &json!({
                "type": "userMessage",
                "id": "user-1",
                "content": [
                    { "type": "text", "text": "Build " },
                    { "type": "localImage", "path": "/tmp/reference.png" },
                    { "type": "text", "text": "this." }
                ]
            }),
            context(ItemStatus::Started),
        );
        assert_eq!(user.item_type, ItemType::Message);
        assert_eq!(user.role, Some(MessageRole::User));
        assert_eq!(user.text.as_deref(), Some("Build this."));

        let assistant = map_thread_item(
            &json!({ "type": "agentMessage", "id": "agent-1", "text": "Done." }),
            context(ItemStatus::Completed),
        );
        assert_eq!(assistant.item_type, ItemType::Message);
        assert_eq!(assistant.role, Some(MessageRole::Assistant));
        assert_eq!(assistant.text.as_deref(), Some("Done."));

        let reasoning = map_thread_item(
            &json!({
                "type": "reasoning",
                "id": "reasoning-1",
                "summary": ["Inspect the contract"],
                "content": ["Keep the provider boundary private", "Preserve unknown items"]
            }),
            context(ItemStatus::Completed),
        );
        assert_eq!(reasoning.item_type, ItemType::Reasoning);
        assert_eq!(
            reasoning.text.as_deref(),
            Some(
                "Inspect the contract\n\nKeep the provider boundary private\n\nPreserve unknown items"
            )
        );
    }

    #[test]
    fn maps_command_file_and_tool_items_without_vendor_fields_leaking() {
        let command = map_thread_item(
            &json!({
                "type": "commandExecution",
                "id": "command-1",
                "command": "cargo test",
                "cwd": "/repo",
                "status": "completed",
                "aggregatedOutput": "ok\n",
                "exitCode": 0,
                "durationMs": 742
            }),
            context(ItemStatus::Completed),
        );
        assert_eq!(command.item_type, ItemType::Command);
        assert_eq!(command.command.as_deref(), Some("cargo test"));
        assert_eq!(command.text.as_deref(), Some("ok\n"));
        assert_eq!(command.exit_code, Some(0));
        assert_eq!(command.duration_ms, Some(742.0));

        let file_change = map_thread_item(
            &json!({
                "type": "fileChange",
                "id": "change-1",
                "changes": [
                    { "path": "src/app.rs", "kind": "update", "diff": "..." },
                    { "path": "src/main.rs", "kind": "update", "diff": "..." }
                ],
                "status": "completed"
            }),
            context(ItemStatus::Completed),
        );
        assert_eq!(file_change.item_type, ItemType::FileChange);
        assert_eq!(file_change.path.as_deref(), Some("src/app.rs"));
        assert_eq!(file_change.text.as_deref(), Some("2 file(s) changed"));

        let mcp = map_thread_item(
            &json!({
                "type": "mcpToolCall",
                "id": "mcp-1",
                "server": "github",
                "tool": "search",
                "durationMs": 120.5
            }),
            context(ItemStatus::Completed),
        );
        assert_eq!(mcp.item_type, ItemType::ToolCall);
        assert_eq!(mcp.text.as_deref(), Some("github.search"));
        assert_eq!(mcp.duration_ms, Some(120.5));

        let dynamic = map_thread_item(
            &json!({ "type": "dynamicToolCall", "id": "tool-1", "tool": "render" }),
            context(ItemStatus::Started),
        );
        assert_eq!(dynamic.item_type, ItemType::ToolCall);
        assert_eq!(dynamic.text.as_deref(), Some("render"));

        let search = map_thread_item(
            &json!({ "type": "webSearch", "id": "search-1", "query": "GPUI" }),
            context(ItemStatus::Started),
        );
        assert_eq!(search.item_type, ItemType::ToolCall);
        assert_eq!(search.text.as_deref(), Some("web search"));
    }

    #[test]
    fn maps_plan_and_lifecycle_context_exactly() {
        let item = map_thread_item(
            &json!({ "type": "plan", "id": "plan-1", "text": "Port the adapter" }),
            context(ItemStatus::Started),
        );
        assert_eq!(item.id, "plan-1");
        assert_eq!(item.turn_id, "turn-1");
        assert_eq!(item.item_type, ItemType::Plan);
        assert_eq!(item.status, ItemStatus::Started);
        assert_eq!(item.text.as_deref(), Some("Port the adapter"));
        assert_eq!(item.created_at, 1_785_627_335_059.0);
    }

    #[test]
    fn preserves_unknown_and_partial_items_instead_of_dropping_them() {
        let unknown = map_thread_item(
            &json!({ "type": "futureCapability", "id": "future-1", "payload": {} }),
            context(ItemStatus::Started),
        );
        assert_eq!(unknown.id, "future-1");
        assert_eq!(unknown.item_type, ItemType::Unknown);
        assert_eq!(unknown.text.as_deref(), Some("[futureCapability]"));

        let partial = map_thread_item(
            &json!({ "type": "commandExecution" }),
            context(ItemStatus::Started),
        );
        assert_eq!(partial.item_type, ItemType::Command);
        assert!(Uuid::parse_str(&partial.id).is_ok());
        assert_eq!(partial.command, None);

        let missing_type = map_thread_item(
            &json!({ "id": "missing-type" }),
            context(ItemStatus::Failed),
        );
        assert_eq!(missing_type.item_type, ItemType::Unknown);
        assert_eq!(missing_type.text.as_deref(), Some("[unknown]"));
    }
}
