use harness_protocol::{Model, ModelConnectionInput, ModelConnectionPreset, ModelTransport};
use reqwest::blocking::{Client, Response};
use serde_json::Value;
use std::time::Duration;
use thiserror::Error;
use url::Url;

mod runtime;
mod session;
mod transport;

pub use runtime::{ApiRuntime, ApiToolFactory, ApiToolSet};
pub use session::{
    API_CAPABILITIES, ApiAgentSession, ApiSessionOptions, ApiSessionState, ApiToolError,
    ApiToolExecutor, ApiToolResult, ApiToolReview,
};
pub use transport::{
    ApiMessage, ApiRequest, ApiStreamEvent, ApiTool, ApiToolCall, ApiTransport, FinishReason,
    create_transport,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum ApiAdapterError {
    #[error("{0}")]
    InvalidConfiguration(String),
    #[error("{vendor} model listing failed with HTTP {status}")]
    HttpStatus { vendor: &'static str, status: u16 },
    #[error("{0} model listing returned invalid JSON")]
    InvalidJson(&'static str),
    #[error("{0} model pagination did not advance")]
    Pagination(&'static str),
    #[error("{0} model listing failed")]
    Request(&'static str),
    #[error("{0}")]
    Provider(String),
    #[error("direct API request was interrupted")]
    Interrupted,
}

pub fn list_models(
    connection: &ModelConnectionInput,
    api_key: &str,
) -> Result<Vec<Model>, ApiAdapterError> {
    match connection.transport {
        ModelTransport::OpenaiResponses => list_openai_models(connection, api_key),
        ModelTransport::AnthropicMessages => list_anthropic_models(connection, api_key),
        ModelTransport::OpenaiCompatible => list_compatible_models(connection, api_key),
    }
}

fn list_openai_models(
    connection: &ModelConnectionInput,
    api_key: &str,
) -> Result<Vec<Model>, ApiAdapterError> {
    let api_key = required_key(api_key, "OpenAI API key is required")?;
    let response = client()?
        .get(endpoint(&connection.base_url, "models")?)
        .bearer_auth(api_key)
        .send()
        .map_err(|_| ApiAdapterError::Request("OpenAI"))?;
    let body = json_response("OpenAI", response)?;
    Ok(models_from_data(&body, connection.default_model.as_deref()))
}

fn list_compatible_models(
    connection: &ModelConnectionInput,
    api_key: &str,
) -> Result<Vec<Model>, ApiAdapterError> {
    if connection.preset == ModelConnectionPreset::Zai {
        return Ok(Vec::new());
    }
    let api_key = required_key(api_key, "An API key is required")?;
    let response = client()?
        .get(endpoint(&connection.base_url, "models")?)
        .bearer_auth(api_key)
        .send()
        .map_err(|_| ApiAdapterError::Request("OpenAI-compatible"))?;
    let body = json_response("OpenAI-compatible", response)?;
    Ok(models_from_data(&body, connection.default_model.as_deref()))
}

fn list_anthropic_models(
    connection: &ModelConnectionInput,
    api_key: &str,
) -> Result<Vec<Model>, ApiAdapterError> {
    let api_key = required_key(api_key, "Anthropic API key is required")?;
    let client = client()?;
    let mut endpoint = endpoint(&connection.base_url, "models")?;
    endpoint.query_pairs_mut().append_pair("limit", "1000");
    let mut models = Vec::new();
    let mut after_id = String::new();
    loop {
        let response = client
            .get(endpoint.clone())
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .send()
            .map_err(|_| ApiAdapterError::Request("Anthropic"))?;
        let body = json_response("Anthropic", response)?;
        if let Some(data) = body.get("data").and_then(Value::as_array) {
            for entry in data {
                let Some(id) = entry.get("id").and_then(Value::as_str) else {
                    continue;
                };
                models.push(model(
                    id,
                    entry
                        .get("display_name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())
                        .unwrap_or(id),
                    connection.default_model.as_deref(),
                ));
            }
        }
        if !body
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(models);
        }
        let last_id = body
            .get("last_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if last_id.is_empty() || last_id == after_id {
            return Err(ApiAdapterError::Pagination("Anthropic"));
        }
        after_id = last_id.into();
        endpoint.query_pairs_mut().append_pair("after_id", last_id);
    }
}

fn models_from_data(body: &Value, default_model: Option<&str>) -> Vec<Model> {
    let mut ids = body
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids.into_iter()
        .map(|id| model(&id, &id, default_model))
        .collect()
}

fn model(id: &str, display_name: &str, default_model: Option<&str>) -> Model {
    Model {
        id: id.into(),
        display_name: display_name.into(),
        description: None,
        is_default: default_model == Some(id),
        reasoning_efforts: Vec::new(),
        default_reasoning_effort: None,
        service_tiers: Vec::new(),
        default_service_tier: None,
    }
}

fn client() -> Result<Client, ApiAdapterError> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| ApiAdapterError::Request("Direct API"))
}

fn json_response(vendor: &'static str, response: Response) -> Result<Value, ApiAdapterError> {
    if !response.status().is_success() {
        return Err(ApiAdapterError::HttpStatus {
            vendor,
            status: response.status().as_u16(),
        });
    }
    response
        .json()
        .map_err(|_| ApiAdapterError::InvalidJson(vendor))
}

fn endpoint(base_url: &str, path: &str) -> Result<Url, ApiAdapterError> {
    let base = if base_url.ends_with('/') {
        base_url.into()
    } else {
        format!("{base_url}/")
    };
    Url::parse(&base)
        .and_then(|base| base.join(path))
        .map_err(|_| ApiAdapterError::InvalidConfiguration("invalid model endpoint URL".into()))
}

fn required_key<'a>(value: &'a str, message: &str) -> Result<&'a str, ApiAdapterError> {
    if value.trim().is_empty() {
        Err(ApiAdapterError::InvalidConfiguration(message.into()))
    } else {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead as _, BufReader, Write as _};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn discovers_and_sorts_openai_models_without_a_catalog() {
        let server = JsonServer::new(vec![serde_json::json!({
            "data": [{ "id": "gpt-b" }, { "id": "gpt-a" }]
        })]);
        let mut connection = connection(ModelTransport::OpenaiResponses);
        connection.base_url = server.base_url();
        connection.default_model = Some("gpt-b".into());

        let models = list_models(&connection, "test-key").unwrap();
        assert_eq!(models[0].id, "gpt-a");
        assert!(models[1].is_default);
        let request = server.request();
        assert!(request.starts_with("GET /v1/models HTTP/1.1"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer test-key")
        );
    }

    #[test]
    fn paginates_anthropic_models_and_keeps_display_names() {
        let server = JsonServer::new(vec![
            serde_json::json!({
                "data": [{ "id": "claude-b", "display_name": "Claude B" }],
                "has_more": true,
                "last_id": "claude-b"
            }),
            serde_json::json!({
                "data": [{ "id": "claude-c", "display_name": "Claude C" }],
                "has_more": false
            }),
        ]);
        let mut connection = connection(ModelTransport::AnthropicMessages);
        connection.base_url = server.base_url();
        connection.default_model = Some("claude-c".into());

        let models = list_models(&connection, "test-key").unwrap();
        assert_eq!(models[0].display_name, "Claude B");
        assert!(models[1].is_default);
        let first = server.request();
        let second = server.request();
        assert!(first.contains("limit=1000"));
        assert!(second.contains("after_id=claude-b"));
    }

    #[test]
    fn zai_reports_no_discovery_without_contacting_the_network() {
        let mut connection = connection(ModelTransport::OpenaiCompatible);
        connection.preset = ModelConnectionPreset::Zai;
        connection.base_url = "https://invalid.example".into();
        assert!(list_models(&connection, "").unwrap().is_empty());
    }

    fn connection(transport: ModelTransport) -> ModelConnectionInput {
        ModelConnectionInput {
            id: "test".into(),
            display_name: "Test".into(),
            preset: ModelConnectionPreset::Custom,
            transport,
            base_url: String::new(),
            default_model: None,
            enabled: true,
        }
    }

    struct JsonServer {
        address: std::net::SocketAddr,
        requests: mpsc::Receiver<String>,
        join: Option<thread::JoinHandle<()>>,
    }

    impl JsonServer {
        fn new(responses: Vec<Value>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (sender, requests) = mpsc::channel();
            let join = thread::spawn(move || {
                for body in responses {
                    let (mut stream, _) = listener.accept().unwrap();
                    let request = read_request(&mut stream);
                    sender.send(request).unwrap();
                    let body = body.to_string();
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
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

    impl Drop for JsonServer {
        fn drop(&mut self) {
            if let Some(join) = self.join.take() {
                join.join().unwrap();
            }
        }
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut request = String::new();
        let mut reader = BufReader::new(stream);
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            request.push_str(&line);
            if line == "\r\n" || line.is_empty() {
                return request;
            }
        }
    }
}
