use crate::{ApiAdapterError, endpoint};
use harness_protocol::{ModelConnectionInput, ModelConnectionPreset, ModelTransport, Usage};
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Read as _};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApiToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ApiMessage {
    User {
        content: String,
    },
    Assistant {
        content: String,
        tool_calls: Vec<ApiToolCall>,
        transport_state: Option<Value>,
    },
    Tool {
        content: String,
        tool_call_id: String,
        is_error: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApiTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    ToolCalls,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ApiStreamEvent {
    Text(String),
    Reasoning(String),
    ToolCall(ApiToolCall),
    Usage(Usage),
    State(Value),
    Finish(FinishReason),
}

pub struct ApiRequest<'a> {
    pub model: &'a str,
    pub messages: &'a [ApiMessage],
    pub tools: &'a [ApiTool],
}

pub trait ApiTransport: Send + Sync {
    fn stream(
        &self,
        request: ApiRequest<'_>,
        cancelled: &AtomicBool,
        emit: &mut dyn FnMut(ApiStreamEvent),
    ) -> Result<(), ApiAdapterError>;
}

enum TransportKind {
    OpenAiResponses,
    AnthropicMessages,
    Compatible {
        stream_usage: bool,
        tool_stream: bool,
    },
}

struct HttpTransport {
    kind: TransportKind,
    client: Client,
    endpoint: url::Url,
    api_key: String,
}

pub fn create_transport(
    connection: &ModelConnectionInput,
    api_key: String,
) -> Result<Arc<dyn ApiTransport>, ApiAdapterError> {
    if api_key.trim().is_empty() {
        return Err(ApiAdapterError::InvalidConfiguration(
            "An API key is required".into(),
        ));
    }
    let (kind, path) = match connection.transport {
        ModelTransport::OpenaiResponses => (TransportKind::OpenAiResponses, "responses"),
        ModelTransport::AnthropicMessages => (TransportKind::AnthropicMessages, "messages"),
        ModelTransport::OpenaiCompatible => (
            TransportKind::Compatible {
                stream_usage: connection.preset != ModelConnectionPreset::Zai,
                tool_stream: connection.preset == ModelConnectionPreset::Zai,
            },
            "chat/completions",
        ),
    };
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| ApiAdapterError::Request("Direct API"))?;
    Ok(Arc::new(HttpTransport {
        kind,
        client,
        endpoint: endpoint(&connection.base_url, path)?,
        api_key,
    }))
}

impl ApiTransport for HttpTransport {
    fn stream(
        &self,
        request: ApiRequest<'_>,
        cancelled: &AtomicBool,
        emit: &mut dyn FnMut(ApiStreamEvent),
    ) -> Result<(), ApiAdapterError> {
        match self.kind {
            TransportKind::OpenAiResponses => self.openai(request, cancelled, emit),
            TransportKind::AnthropicMessages => self.anthropic(request, cancelled, emit),
            TransportKind::Compatible {
                stream_usage,
                tool_stream,
            } => self.compatible(request, cancelled, emit, stream_usage, tool_stream),
        }
    }
}

impl HttpTransport {
    fn openai(
        &self,
        request: ApiRequest<'_>,
        cancelled: &AtomicBool,
        emit: &mut dyn FnMut(ApiStreamEvent),
    ) -> Result<(), ApiAdapterError> {
        let response = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(&self.api_key)
            .json(&json!({
                "model": request.model,
                "input": openai_input(request.messages),
                "tools": request.tools.iter().map(openai_tool).collect::<Vec<_>>(),
                "stream": true,
                "store": false,
                "include": ["reasoning.encrypted_content"]
            }))
            .send()
            .map_err(|_| ApiAdapterError::Provider("OpenAI request failed".into()))?;
        let response = success("OpenAI", response, &[&self.api_key])?;
        let mut calls = BTreeMap::<String, (String, String)>::new();
        let mut saw_tool = false;
        for_each_sse(response, cancelled, |event| {
            match string(&event, "type") {
                "response.output_text.delta" | "response.refusal.delta" => {
                    emit(ApiStreamEvent::Text(string(&event, "delta").into()));
                }
                "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                    emit(ApiStreamEvent::Reasoning(string(&event, "delta").into()));
                }
                "response.output_item.added" => {
                    let item = object(&event, "item");
                    if string_object(item, "type") == "function_call" {
                        calls.insert(
                            string_object(item, "id").into(),
                            (
                                string_object(item, "call_id").into(),
                                string_object(item, "name").into(),
                            ),
                        );
                    }
                }
                "response.function_call_arguments.done" => {
                    let item_id = string(&event, "item_id");
                    let (saved_id, saved_name) = calls
                        .get(item_id)
                        .cloned()
                        .unwrap_or_else(|| (String::new(), String::new()));
                    let call_id = non_empty(&saved_id, string(&event, "call_id"));
                    let name = non_empty(&saved_name, string(&event, "name"));
                    if call_id.is_empty() || name.is_empty() {
                        return Err(ApiAdapterError::Provider(
                            "OpenAI returned an invalid function call".into(),
                        ));
                    }
                    let input =
                        serde_json::from_str(string(&event, "arguments")).map_err(|_| {
                            ApiAdapterError::Provider(
                                "OpenAI returned invalid function arguments".into(),
                            )
                        })?;
                    saw_tool = true;
                    emit(ApiStreamEvent::ToolCall(ApiToolCall {
                        id: call_id.into(),
                        name: name.into(),
                        input,
                    }));
                }
                "response.completed" => {
                    let completed = object(&event, "response");
                    emit(ApiStreamEvent::State(
                        completed
                            .get("output")
                            .cloned()
                            .unwrap_or_else(|| json!([])),
                    ));
                    if let Some(usage) = completed.get("usage").and_then(Value::as_object) {
                        emit(ApiStreamEvent::Usage(openai_usage(usage)));
                    }
                    emit(ApiStreamEvent::Finish(if saw_tool {
                        FinishReason::ToolCalls
                    } else {
                        FinishReason::Stop
                    }));
                }
                "response.failed" | "response.incomplete" | "error" => {
                    return Err(ApiAdapterError::Provider("OpenAI response failed".into()));
                }
                _ => {}
            }
            Ok(())
        })
    }

    fn compatible(
        &self,
        request: ApiRequest<'_>,
        cancelled: &AtomicBool,
        emit: &mut dyn FnMut(ApiStreamEvent),
        stream_usage: bool,
        tool_stream: bool,
    ) -> Result<(), ApiAdapterError> {
        let mut body = Map::from_iter([
            ("model".into(), Value::String(request.model.into())),
            (
                "messages".into(),
                Value::Array(request.messages.iter().map(compatible_message).collect()),
            ),
            (
                "tools".into(),
                Value::Array(request.tools.iter().map(compatible_tool).collect()),
            ),
            ("stream".into(), Value::Bool(true)),
        ]);
        if stream_usage {
            body.insert("stream_options".into(), json!({ "include_usage": true }));
        }
        if tool_stream {
            body.insert("tool_stream".into(), Value::Bool(true));
        }
        let response = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .map_err(|_| ApiAdapterError::Provider("OpenAI-compatible request failed".into()))?;
        let response = success("OpenAI-compatible", response, &[&self.api_key])?;
        let mut calls = BTreeMap::<u64, CompatibleCall>::new();
        let mut finish = None;
        let mut truncated = false;
        for_each_sse(response, cancelled, |event| {
            if event.get("error").is_some_and(|value| !value.is_null()) {
                return Err(ApiAdapterError::Provider(
                    "OpenAI-compatible response failed".into(),
                ));
            }
            let choice = event
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|choices| choices.first())
                .and_then(Value::as_object);
            let delta = choice
                .and_then(|choice| choice.get("delta"))
                .and_then(Value::as_object);
            let reasoning = delta
                .and_then(|delta| {
                    delta
                        .get("reasoning_content")
                        .or_else(|| delta.get("reasoning"))
                })
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !reasoning.is_empty() {
                emit(ApiStreamEvent::Reasoning(reasoning.into()));
            }
            let content = delta
                .and_then(|delta| delta.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !content.is_empty() {
                emit(ApiStreamEvent::Text(content.into()));
            }
            for fragment in delta
                .and_then(|delta| delta.get("tool_calls"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let index = fragment.get("index").and_then(Value::as_u64).unwrap_or(0);
                let call = calls.entry(index).or_default();
                if call.id.is_empty() {
                    call.id = fragment
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into();
                }
                if let Some(function) = fragment.get("function").and_then(Value::as_object) {
                    call.name.push_str(string_object(function, "name"));
                    call.arguments
                        .push_str(string_object(function, "arguments"));
                }
            }
            if let Some(usage) = event.get("usage").and_then(Value::as_object) {
                emit(ApiStreamEvent::Usage(compatible_usage(usage)));
            }
            let reason = choice
                .and_then(|choice| choice.get("finish_reason"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            match reason {
                "tool_calls" => finish = Some(FinishReason::ToolCalls),
                "stop" => finish = Some(FinishReason::Stop),
                "length" => {
                    finish = Some(FinishReason::Stop);
                    truncated = true;
                }
                "" => {}
                reason => {
                    return Err(ApiAdapterError::Provider(format!(
                        "OpenAI-compatible response did not complete ({reason})"
                    )));
                }
            }
            Ok(())
        })?;
        if truncated {
            calls.clear();
        }
        for call in calls.values() {
            if call.id.is_empty() || call.name.is_empty() {
                return Err(ApiAdapterError::Provider(
                    "OpenAI-compatible provider returned an invalid tool call".into(),
                ));
            }
            let input = serde_json::from_str(&call.arguments).map_err(|_| {
                ApiAdapterError::Provider(
                    "OpenAI-compatible provider returned invalid tool arguments".into(),
                )
            })?;
            emit(ApiStreamEvent::ToolCall(ApiToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                input,
            }));
        }
        let mut finish = finish.ok_or_else(|| {
            ApiAdapterError::Provider(
                "OpenAI-compatible response ended without a finish reason".into(),
            )
        })?;
        if !calls.is_empty() {
            finish = FinishReason::ToolCalls;
        }
        emit(ApiStreamEvent::Finish(finish));
        Ok(())
    }

    fn anthropic(
        &self,
        request: ApiRequest<'_>,
        cancelled: &AtomicBool,
        emit: &mut dyn FnMut(ApiStreamEvent),
    ) -> Result<(), ApiAdapterError> {
        let response = self
            .client
            .post(self.endpoint.clone())
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": request.model,
                "max_tokens": 8192,
                "messages": anthropic_messages(request.messages),
                "tools": request.tools.iter().map(anthropic_tool).collect::<Vec<_>>(),
                "stream": true
            }))
            .send()
            .map_err(|_| ApiAdapterError::Provider("Anthropic request failed".into()))?;
        let response = success("Anthropic", response, &[&self.api_key])?;
        let mut blocks = BTreeMap::<u64, Value>::new();
        let mut json_fragments = BTreeMap::<u64, String>::new();
        let mut input_tokens = 0.0;
        let mut cached_input_tokens = 0.0;
        let mut output_tokens = 0.0;
        let mut stop_reason = String::new();
        for_each_sse(response, cancelled, |event| {
            match string(&event, "type") {
                "message_start" => {
                    let usage = object_object(object(&event, "message"), "usage");
                    input_tokens = number_object(usage, "input_tokens");
                    cached_input_tokens = number_object(usage, "cache_read_input_tokens");
                }
                "content_block_start" => {
                    let index = number(&event, "index") as u64;
                    blocks.insert(
                        index,
                        event
                            .get("content_block")
                            .cloned()
                            .unwrap_or_else(|| json!({})),
                    );
                }
                "content_block_delta" => {
                    let index = number(&event, "index") as u64;
                    let delta = object(&event, "delta");
                    let block = blocks.entry(index).or_insert_with(|| json!({}));
                    match string_object(delta, "type") {
                        "text_delta" => {
                            append_field(block, "text", string_object(delta, "text"));
                            emit(ApiStreamEvent::Text(string_object(delta, "text").into()));
                        }
                        "thinking_delta" => {
                            append_field(block, "thinking", string_object(delta, "thinking"));
                            emit(ApiStreamEvent::Reasoning(
                                string_object(delta, "thinking").into(),
                            ));
                        }
                        "signature_delta" => {
                            append_field(block, "signature", string_object(delta, "signature"));
                        }
                        "input_json_delta" => json_fragments
                            .entry(index)
                            .or_default()
                            .push_str(string_object(delta, "partial_json")),
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    let index = number(&event, "index") as u64;
                    let block = blocks.entry(index).or_insert_with(|| json!({}));
                    if string(block, "type") == "tool_use" {
                        let input = match json_fragments.get(&index) {
                            Some(fragment) if !fragment.is_empty() => {
                                serde_json::from_str(fragment).map_err(|_| {
                                    ApiAdapterError::Provider(
                                        "Anthropic returned invalid tool arguments".into(),
                                    )
                                })?
                            }
                            _ => block.get("input").cloned().unwrap_or_else(|| json!({})),
                        };
                        block["input"] = input.clone();
                        emit(ApiStreamEvent::ToolCall(ApiToolCall {
                            id: string(block, "id").into(),
                            name: string(block, "name").into(),
                            input,
                        }));
                    }
                }
                "message_delta" => {
                    stop_reason = string_object(object(&event, "delta"), "stop_reason").into();
                    output_tokens = number_object(object(&event, "usage"), "output_tokens");
                }
                "message_stop" => {
                    if !matches!(
                        stop_reason.as_str(),
                        "end_turn" | "stop_sequence" | "tool_use" | "max_tokens"
                    ) {
                        return Err(ApiAdapterError::Provider(format!(
                            "Anthropic response stopped before completion ({stop_reason})"
                        )));
                    }
                    emit(ApiStreamEvent::State(Value::Array(
                        blocks.values().cloned().collect(),
                    )));
                    emit(ApiStreamEvent::Usage(Usage {
                        input_tokens,
                        cached_input_tokens,
                        output_tokens,
                        reasoning_tokens: 0.0,
                        total_tokens: input_tokens + output_tokens,
                        cost_usd: None,
                        context_window: None,
                    }));
                    emit(ApiStreamEvent::Finish(if stop_reason == "tool_use" {
                        FinishReason::ToolCalls
                    } else {
                        FinishReason::Stop
                    }));
                }
                "error" => {
                    return Err(ApiAdapterError::Provider(
                        "Anthropic response failed".into(),
                    ));
                }
                _ => {}
            }
            Ok(())
        })
    }
}

#[derive(Default)]
struct CompatibleCall {
    id: String,
    name: String,
    arguments: String,
}

fn for_each_sse(
    response: Response,
    cancelled: &AtomicBool,
    mut handle: impl FnMut(Value) -> Result<(), ApiAdapterError>,
) -> Result<(), ApiAdapterError> {
    let mut reader = BufReader::new(response);
    let mut data = Vec::new();
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(ApiAdapterError::Interrupted);
        }
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|_| ApiAdapterError::Provider("provider stream failed".into()))?;
        if read == 0 {
            process_sse_data(&mut data, &mut handle)?;
            return Ok(());
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            process_sse_data(&mut data, &mut handle)?;
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value).to_owned());
        }
    }
}

fn process_sse_data(
    data: &mut Vec<String>,
    handle: &mut impl FnMut(Value) -> Result<(), ApiAdapterError>,
) -> Result<(), ApiAdapterError> {
    if data.is_empty() {
        return Ok(());
    }
    let raw = data.join("\n");
    data.clear();
    if raw == "[DONE]" {
        return Ok(());
    }
    if let Ok(value) = serde_json::from_str::<Value>(&raw)
        && value.is_object()
    {
        handle(value)?;
    }
    Ok(())
}

fn success(
    vendor: &'static str,
    mut response: Response,
    secrets: &[&str],
) -> Result<Response, ApiAdapterError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let mut body = String::new();
    let _ = response.by_ref().take(8_192).read_to_string(&mut body);
    let mut detail = body.trim().chars().take(400).collect::<String>();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        detail = detail.replace(secret, "[REDACTED]");
    }
    Err(ApiAdapterError::Provider(format!(
        "{vendor} request failed with HTTP {status}{}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    )))
}

fn openai_input(messages: &[ApiMessage]) -> Vec<Value> {
    messages
        .iter()
        .flat_map(|message| match message {
            ApiMessage::User { content } => vec![json!({ "role": "user", "content": content })],
            ApiMessage::Tool {
                content,
                tool_call_id,
                ..
            } => vec![json!({
                "type": "function_call_output",
                "call_id": tool_call_id,
                "output": content
            })],
            ApiMessage::Assistant {
                content,
                tool_calls,
                transport_state,
            } => match transport_state.as_ref().and_then(Value::as_array) {
                Some(state) => state.clone(),
                None => {
                    let mut values = Vec::new();
                    if !content.is_empty() {
                        values.push(json!({ "role": "assistant", "content": content }));
                    }
                    values.extend(tool_calls.iter().map(|call| {
                        json!({
                            "type": "function_call",
                            "call_id": call.id,
                            "name": call.name,
                            "arguments": call.input.to_string()
                        })
                    }));
                    values
                }
            },
        })
        .collect()
}

fn openai_tool(tool: &ApiTool) -> Value {
    json!({
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.input_schema,
        "strict": false
    })
}

fn compatible_message(message: &ApiMessage) -> Value {
    match message {
        ApiMessage::User { content } => json!({ "role": "user", "content": content }),
        ApiMessage::Tool {
            content,
            tool_call_id,
            ..
        } => json!({ "role": "tool", "tool_call_id": tool_call_id, "content": content }),
        ApiMessage::Assistant {
            content,
            tool_calls,
            ..
        } => {
            let mut value = Map::from_iter([
                ("role".into(), Value::String("assistant".into())),
                (
                    "content".into(),
                    if content.is_empty() {
                        Value::Null
                    } else {
                        Value::String(content.clone())
                    },
                ),
            ]);
            if !tool_calls.is_empty() {
                value.insert(
                    "tool_calls".into(),
                    Value::Array(
                        tool_calls
                            .iter()
                            .map(|call| {
                                json!({
                                    "id": call.id,
                                    "type": "function",
                                    "function": {
                                        "name": call.name,
                                        "arguments": call.input.to_string()
                                    }
                                })
                            })
                            .collect(),
                    ),
                );
            }
            Value::Object(value)
        }
    }
}

fn compatible_tool(tool: &ApiTool) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema
        }
    })
}

fn anthropic_messages(messages: &[ApiMessage]) -> Vec<Value> {
    let mut result = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        match &messages[index] {
            ApiMessage::User { content } => {
                result.push(json!({ "role": "user", "content": content }));
            }
            ApiMessage::Assistant {
                content,
                tool_calls,
                transport_state,
            } => {
                let content = transport_state
                    .as_ref()
                    .filter(|state| state.is_array())
                    .cloned()
                    .unwrap_or_else(|| {
                        let mut blocks = Vec::new();
                        if !content.is_empty() {
                            blocks.push(json!({ "type": "text", "text": content }));
                        }
                        blocks.extend(tool_calls.iter().map(|call| {
                            json!({
                                "type": "tool_use",
                                "id": call.id,
                                "name": call.name,
                                "input": call.input
                            })
                        }));
                        Value::Array(blocks)
                    });
                result.push(json!({ "role": "assistant", "content": content }));
            }
            ApiMessage::Tool { .. } => {
                let mut content = Vec::new();
                while index < messages.len() {
                    let ApiMessage::Tool {
                        content: tool_content,
                        tool_call_id,
                        is_error,
                    } = &messages[index]
                    else {
                        break;
                    };
                    content.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": tool_content,
                        "is_error": is_error
                    }));
                    index += 1;
                }
                index -= 1;
                result.push(json!({ "role": "user", "content": content }));
            }
        }
        index += 1;
    }
    result
}

fn anthropic_tool(tool: &ApiTool) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.input_schema
    })
}

fn openai_usage(usage: &Map<String, Value>) -> Usage {
    Usage {
        input_tokens: number_object(usage, "input_tokens"),
        cached_input_tokens: usage
            .get("input_tokens_details")
            .and_then(Value::as_object)
            .map(|details| number_object(details, "cached_tokens"))
            .unwrap_or(0.0),
        output_tokens: number_object(usage, "output_tokens"),
        reasoning_tokens: usage
            .get("output_tokens_details")
            .and_then(Value::as_object)
            .map(|details| number_object(details, "reasoning_tokens"))
            .unwrap_or(0.0),
        total_tokens: number_object(usage, "total_tokens"),
        cost_usd: None,
        context_window: None,
    }
}

fn compatible_usage(usage: &Map<String, Value>) -> Usage {
    Usage {
        input_tokens: number_object(usage, "prompt_tokens"),
        cached_input_tokens: usage
            .get("prompt_tokens_details")
            .and_then(Value::as_object)
            .map(|details| number_object(details, "cached_tokens"))
            .unwrap_or(0.0),
        output_tokens: number_object(usage, "completion_tokens"),
        reasoning_tokens: usage
            .get("completion_tokens_details")
            .and_then(Value::as_object)
            .map(|details| number_object(details, "reasoning_tokens"))
            .unwrap_or(0.0),
        total_tokens: number_object(usage, "total_tokens"),
        cost_usd: None,
        context_window: None,
    }
}

fn append_field(value: &mut Value, field: &str, suffix: &str) {
    let current = value.get(field).and_then(Value::as_str).unwrap_or_default();
    value[field] = Value::String(format!("{current}{suffix}"));
}

fn object<'a>(value: &'a Value, field: &str) -> &'a Map<String, Value> {
    match value.get(field).and_then(Value::as_object) {
        Some(value) => value,
        None => empty_object(),
    }
}

fn object_object<'a>(value: &'a Map<String, Value>, field: &str) -> &'a Map<String, Value> {
    match value.get(field).and_then(Value::as_object) {
        Some(value) => value,
        None => empty_object(),
    }
}

fn empty_object() -> &'static Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    EMPTY.get_or_init(Map::new)
}

fn string<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn string_object<'a>(value: &'a Map<String, Value>, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn number(value: &Value, field: &str) -> f64 {
    value.get(field).and_then(Value::as_f64).unwrap_or(0.0)
}

fn number_object(value: &Map<String, Value>, field: &str) -> f64 {
    value.get(field).and_then(Value::as_f64).unwrap_or(0.0)
}

fn non_empty<'a>(first: &'a str, fallback: &'a str) -> &'a str {
    if first.is_empty() { fallback } else { first }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_protocol::{ModelConnectionPreset, ModelTransport};
    use std::io::{BufReader, Write as _};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn maps_compatible_text_reasoning_usage_and_finish_from_sse() {
        let stream = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Checking.\",\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":6,\"total_tokens\":16}}\n\n",
            "data: [DONE]\n\n"
        );
        let server = SseServer::new(vec![stream.into()]);
        let transport = create_transport(
            &connection(server.base_url(), ModelTransport::OpenaiCompatible),
            "test-key".into(),
        )
        .unwrap();
        let mut events = Vec::new();
        transport
            .stream(request(), &AtomicBool::new(false), &mut |event| {
                events.push(event)
            })
            .unwrap();

        assert_eq!(events[0], ApiStreamEvent::Reasoning("Checking.".into()));
        assert_eq!(events[1], ApiStreamEvent::Text("Hello".into()));
        assert!(matches!(events[2], ApiStreamEvent::Usage(_)));
        assert_eq!(events[3], ApiStreamEvent::Finish(FinishReason::Stop));
        assert!(server.request().contains("POST /v1/chat/completions"));
    }

    #[test]
    fn maps_openai_tool_calls_and_preserves_response_state() {
        let stream = concat!(
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"read_file\"}}\n\n",
            "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"id\":\"fc_1\"}]}}\n\n"
        );
        let server = SseServer::new(vec![stream.into()]);
        let transport = create_transport(
            &connection(server.base_url(), ModelTransport::OpenaiResponses),
            "test-key".into(),
        )
        .unwrap();
        let mut events = Vec::new();
        transport
            .stream(request(), &AtomicBool::new(false), &mut |event| {
                events.push(event)
            })
            .unwrap();

        assert!(matches!(events[0], ApiStreamEvent::ToolCall(ref call) if call.id == "call_1"));
        assert!(matches!(events[1], ApiStreamEvent::State(_)));
        assert_eq!(events[2], ApiStreamEvent::Finish(FinishReason::ToolCalls));
    }

    #[test]
    fn maps_anthropic_text_usage_and_stop_reason() {
        let stream = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11,\"cache_read_input_tokens\":3}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello from Claude.\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        );
        let server = SseServer::new(vec![stream.into()]);
        let transport = create_transport(
            &connection(server.base_url(), ModelTransport::AnthropicMessages),
            "test-key".into(),
        )
        .unwrap();
        let mut events = Vec::new();
        transport
            .stream(request(), &AtomicBool::new(false), &mut |event| {
                events.push(event)
            })
            .unwrap();

        assert_eq!(events[0], ApiStreamEvent::Text("Hello from Claude.".into()));
        assert!(
            matches!(events[2], ApiStreamEvent::Usage(ref usage) if usage.total_tokens == 16.0)
        );
        assert_eq!(events[3], ApiStreamEvent::Finish(FinishReason::Stop));
    }

    #[test]
    fn redacts_credentials_from_http_errors() {
        let secret = "sk-provider-secret";
        let server = SseServer::status(401, format!("rejected {secret}"));
        let transport = create_transport(
            &connection(server.base_url(), ModelTransport::OpenaiResponses),
            secret.into(),
        )
        .unwrap();
        let error = transport
            .stream(request(), &AtomicBool::new(false), &mut |_| {})
            .unwrap_err()
            .to_string();
        assert!(error.contains("HTTP 401"));
        assert!(error.contains("rejected"));
        assert!(!error.contains(secret));
    }

    fn connection(base_url: String, transport: ModelTransport) -> ModelConnectionInput {
        ModelConnectionInput {
            id: "test".into(),
            display_name: "Test".into(),
            preset: ModelConnectionPreset::Custom,
            transport,
            base_url,
            default_model: Some("test-model".into()),
            enabled: true,
        }
    }

    fn request() -> ApiRequest<'static> {
        static MESSAGES: std::sync::OnceLock<Vec<ApiMessage>> = std::sync::OnceLock::new();
        ApiRequest {
            model: "test-model",
            messages: MESSAGES.get_or_init(|| {
                vec![ApiMessage::User {
                    content: "Hello".into(),
                }]
            }),
            tools: &[],
        }
    }

    struct SseServer {
        address: std::net::SocketAddr,
        requests: mpsc::Receiver<String>,
        join: Option<thread::JoinHandle<()>>,
    }

    impl SseServer {
        fn new(responses: Vec<String>) -> Self {
            Self::responses(200, responses)
        }

        fn status(status: u16, body: String) -> Self {
            Self::responses(status, vec![body])
        }

        fn responses(status: u16, responses: Vec<String>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (sender, requests) = mpsc::channel();
            let join = thread::spawn(move || {
                for body in responses {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut request = String::new();
                    let content_length;
                    {
                        let mut reader = BufReader::new(&mut stream);
                        loop {
                            let mut line = String::new();
                            reader.read_line(&mut line).unwrap();
                            request.push_str(&line);
                            if line == "\r\n" || line.is_empty() {
                                break;
                            }
                        }
                        content_length = request
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(str::trim)
                                    .and_then(|value| value.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        let mut payload = vec![0; content_length];
                        reader.read_exact(&mut payload).unwrap();
                        request.push_str(&String::from_utf8_lossy(&payload));
                    }
                    sender.send(request).unwrap();
                    let reason = if status == 200 { "OK" } else { "Unauthorized" };
                    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    stream.flush().unwrap();
                }
            });
            Self {
                address,
                requests,
                join: Some(join),
            }
        }

        fn base_url(&self) -> String {
            format!("http://{}/v1", self.address)
        }

        fn request(&self) -> String {
            self.requests.recv().unwrap()
        }
    }

    impl Drop for SseServer {
        fn drop(&mut self) {
            if let Some(join) = self.join.take() {
                join.join().unwrap();
            }
        }
    }
}
