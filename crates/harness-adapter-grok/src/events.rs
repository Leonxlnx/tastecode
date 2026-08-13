use harness_protocol::{DomainEvent, Item, ItemStatus, ItemType, MessageRole, TurnStatus, Usage};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Default)]
pub(crate) struct GrokFrameResult {
    pub(crate) events: Vec<DomainEvent>,
    pub(crate) session_id: Option<String>,
    pub(crate) terminal: Option<TurnStatus>,
}

#[derive(Debug)]
pub struct GrokEventMapper {
    turn_id: String,
    thread_id: String,
    message: StreamedItem,
    reasoning: StreamedItem,
    tools: HashMap<String, ToolItem>,
    next_tool: u64,
    terminal: Option<TurnStatus>,
}

#[derive(Debug)]
struct StreamedItem {
    id: String,
    text: String,
    started: bool,
    completed: bool,
}

#[derive(Debug)]
struct ToolItem {
    id: String,
    item_type: ItemType,
    label: String,
    path: Option<String>,
}

impl GrokEventMapper {
    pub fn new(turn_id: &str, thread_id: &str) -> Self {
        Self {
            turn_id: turn_id.into(),
            thread_id: thread_id.into(),
            message: StreamedItem::new(format!("{turn_id}-message")),
            reasoning: StreamedItem::new(format!("{turn_id}-reasoning")),
            tools: HashMap::new(),
            next_tool: 0,
            terminal: None,
        }
    }

    pub(crate) fn translate(&mut self, frame: &Value, now: f64) -> GrokFrameResult {
        if self.terminal.is_some() {
            return GrokFrameResult::default();
        }
        match string(frame, "type") {
            Some("thought") => self.stream_delta(frame, ItemType::Reasoning, now),
            Some("text") => self.stream_delta(frame, ItemType::Message, now),
            Some("tool_call") => self.start_tool(frame, now),
            Some("tool_call_update") => self.complete_tool(frame, now),
            Some("end") => self.finish(frame, now),
            _ => GrokFrameResult::default(),
        }
    }

    fn stream_delta(&mut self, frame: &Value, item_type: ItemType, now: f64) -> GrokFrameResult {
        let Some(delta) = string(frame, "data").filter(|delta| !delta.is_empty()) else {
            return GrokFrameResult::default();
        };
        let stream = if item_type == ItemType::Message {
            &mut self.message
        } else {
            &mut self.reasoning
        };
        let mut events = Vec::with_capacity(2);
        if !stream.started {
            stream.started = true;
            events.push(DomainEvent::ItemStarted {
                item: streamed_item(
                    &stream.id,
                    &self.turn_id,
                    item_type,
                    ItemStatus::Started,
                    String::new(),
                    now,
                ),
            });
        }
        stream.text.push_str(delta);
        events.push(DomainEvent::ItemDelta {
            turn_id: self.turn_id.clone(),
            item_id: stream.id.clone(),
            text_delta: delta.into(),
        });
        GrokFrameResult {
            events,
            ..GrokFrameResult::default()
        }
    }

    fn start_tool(&mut self, frame: &Value, now: f64) -> GrokFrameResult {
        let Some(call_id) = string(frame, "toolCallId").filter(|id| !id.is_empty()) else {
            return GrokFrameResult::default();
        };
        let name = string(frame, "toolName")
            .or_else(|| string(frame, "title"))
            .unwrap_or("tool");
        let item_type = match name {
            "write" | "search_replace" => ItemType::FileChange,
            "run_terminal_command" => ItemType::Command,
            _ => ItemType::ToolCall,
        };
        self.next_tool = self.next_tool.saturating_add(1);
        let entry = ToolItem {
            id: format!("{}-tool-{}", self.turn_id, self.next_tool),
            item_type,
            label: string(frame, "title").unwrap_or(name).into(),
            path: frame
                .pointer("/rawInput/file_path")
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        let command = frame
            .pointer("/rawInput/command")
            .and_then(Value::as_str)
            .unwrap_or(&entry.label);
        let item = tool_item(&entry, &self.turn_id, ItemStatus::Started, command, now);
        self.tools.insert(call_id.into(), entry);
        GrokFrameResult {
            events: vec![DomainEvent::ItemStarted { item }],
            ..GrokFrameResult::default()
        }
    }

    fn complete_tool(&mut self, frame: &Value, now: f64) -> GrokFrameResult {
        let Some(call_id) = string(frame, "toolCallId") else {
            return GrokFrameResult::default();
        };
        let Some(status) = string(frame, "status").filter(|status| !status.is_empty()) else {
            return GrokFrameResult::default();
        };
        let Some(entry) = self.tools.remove(call_id) else {
            return GrokFrameResult::default();
        };
        let status = if status == "failed" {
            ItemStatus::Failed
        } else {
            ItemStatus::Completed
        };
        let item = tool_item(&entry, &self.turn_id, status, &entry.label, now);
        GrokFrameResult {
            events: vec![DomainEvent::ItemCompleted { item }],
            ..GrokFrameResult::default()
        }
    }

    fn finish(&mut self, frame: &Value, now: f64) -> GrokFrameResult {
        let mut events = Vec::new();
        complete_stream(
            &mut self.reasoning,
            &self.turn_id,
            ItemType::Reasoning,
            now,
            &mut events,
        );
        complete_stream(
            &mut self.message,
            &self.turn_id,
            ItemType::Message,
            now,
            &mut events,
        );
        if let Some(usage) = frame.get("usage").filter(|usage| usage.is_object()) {
            events.push(DomainEvent::UsageUpdated {
                usage: Usage {
                    input_tokens: number(usage, "input_tokens"),
                    cached_input_tokens: number(usage, "cache_read_input_tokens"),
                    output_tokens: number(usage, "output_tokens"),
                    reasoning_tokens: number(usage, "reasoning_tokens"),
                    total_tokens: number(usage, "total_tokens"),
                    cost_usd: None,
                    context_window: None,
                },
            });
        }
        let terminal = if string(frame, "stopReason") == Some("end_turn") {
            TurnStatus::Completed
        } else {
            events.push(DomainEvent::ThreadError {
                thread_id: self.thread_id.clone(),
                message: format!(
                    "Grok finished with stop reason {}",
                    string(frame, "stopReason").unwrap_or("unknown")
                ),
            });
            TurnStatus::Failed
        };
        self.terminal = Some(terminal);
        GrokFrameResult {
            events,
            session_id: string(frame, "sessionId").map(str::to_owned),
            terminal: Some(terminal),
        }
    }
}

impl StreamedItem {
    fn new(id: String) -> Self {
        Self {
            id,
            text: String::new(),
            started: false,
            completed: false,
        }
    }
}

fn complete_stream(
    stream: &mut StreamedItem,
    turn_id: &str,
    item_type: ItemType,
    now: f64,
    events: &mut Vec<DomainEvent>,
) {
    if !stream.started || stream.completed {
        return;
    }
    stream.completed = true;
    events.push(DomainEvent::ItemCompleted {
        item: streamed_item(
            &stream.id,
            turn_id,
            item_type,
            ItemStatus::Completed,
            stream.text.trim_end().into(),
            now,
        ),
    });
}

fn streamed_item(
    id: &str,
    turn_id: &str,
    item_type: ItemType,
    status: ItemStatus,
    text: String,
    now: f64,
) -> Item {
    Item {
        id: id.into(),
        turn_id: turn_id.into(),
        item_type,
        status,
        role: (item_type == ItemType::Message).then_some(MessageRole::Assistant),
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

fn tool_item(entry: &ToolItem, turn_id: &str, status: ItemStatus, command: &str, now: f64) -> Item {
    Item {
        id: entry.id.clone(),
        turn_id: turn_id.into(),
        item_type: entry.item_type,
        status,
        role: None,
        text: (entry.item_type == ItemType::ToolCall).then(|| entry.label.clone()),
        command: (entry.item_type == ItemType::Command).then(|| command.into()),
        exit_code: None,
        duration_ms: None,
        path: (entry.item_type == ItemType::FileChange)
            .then(|| entry.path.clone())
            .flatten(),
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
    fn maps_the_captured_stream_without_vendor_fields() {
        let mut mapper = GrokEventMapper::new("turn-1", "thread-1");
        let mut events = Vec::new();
        let mut terminal = None;
        let mut session_id = None;
        for line in include_str!("../fixtures/stream.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let frame = serde_json::from_str(line).unwrap();
            let result = mapper.translate(&frame, 10.0);
            events.extend(result.events);
            terminal = result.terminal.or(terminal);
            session_id = result.session_id.or(session_id);
        }
        assert_eq!(terminal, Some(TurnStatus::Completed));
        assert_eq!(
            session_id.as_deref(),
            Some("019fd9b0-1c9b-7dd3-85a2-2b7b628382d3")
        );
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemDelta { text_delta, .. } if text_delta == "The user wants"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemStarted { item }
                if item.item_type == ItemType::FileChange
                    && item.path.as_deref() == Some("C:\\repo\\hello.txt")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Message && item.text.as_deref() == Some("done")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::UsageUpdated { usage }
                if usage.input_tokens == 22_116.0 && usage.reasoning_tokens == 83.0
        )));
    }

    #[test]
    fn reports_non_terminal_stop_reasons_once() {
        let mut mapper = GrokEventMapper::new("turn-1", "thread-1");
        let frame = serde_json::json!({ "type": "end", "stopReason": "max_tokens" });
        let first = mapper.translate(&frame, 1.0);
        assert_eq!(first.terminal, Some(TurnStatus::Failed));
        assert!(matches!(
            first.events.as_slice(),
            [DomainEvent::ThreadError { .. }]
        ));
        assert!(mapper.translate(&frame, 2.0).events.is_empty());
    }
}
