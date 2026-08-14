use harness_agent::{AgentError, AgentResult};
use harness_protocol::Model;
use reqwest::Method;
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::Read as _;
use std::time::Duration;
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_JSON_BODY: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct OpenCodeHttp {
    client: Client,
    base_url: Url,
    directory: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SessionRecord {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
    pub(crate) created_at: f64,
}

#[derive(Deserialize)]
struct ProviderList {
    all: Vec<Provider>,
    connected: HashSet<String>,
    default: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Provider {
    id: String,
    name: String,
    #[serde(deserialize_with = "ordered_models")]
    models: Vec<WireModel>,
}

#[derive(Deserialize)]
struct WireModel {
    id: String,
    name: String,
}

impl OpenCodeHttp {
    pub(crate) fn new(base_url: Url, directory: Option<String>) -> AgentResult<Self> {
        validate_base_url(&base_url)?;
        let client = Client::builder().build().map_err(|_| request_failed())?;
        Ok(Self {
            client,
            base_url,
            directory,
        })
    }

    pub(crate) fn without_directory(&self) -> Self {
        Self {
            client: self.client.clone(),
            base_url: self.base_url.clone(),
            directory: None,
        }
    }

    pub(crate) fn create_session(&self) -> AgentResult<SessionRecord> {
        let value = self.request_json(
            Method::POST,
            &["session"],
            Some(serde_json::json!({ "title": "TasteCode" })),
        )?;
        parse_session(value)
    }

    pub(crate) fn get_session(&self, session_id: &str) -> AgentResult<SessionRecord> {
        let value = self.request_json(Method::GET, &["session", session_id], None)?;
        parse_session(value)
    }

    pub(crate) fn prompt_async(&self, session_id: &str, body: Value) -> AgentResult<()> {
        self.request_empty(
            Method::POST,
            &["session", session_id, "prompt_async"],
            Some(body),
        )
    }

    pub(crate) fn abort(&self, session_id: &str) -> AgentResult<()> {
        self.request_empty(Method::POST, &["session", session_id, "abort"], None)
    }

    pub(crate) fn respond_permission(
        &self,
        session_id: &str,
        permission_id: &str,
        response: &str,
    ) -> AgentResult<()> {
        self.request_empty(
            Method::POST,
            &["session", session_id, "permissions", permission_id],
            Some(serde_json::json!({ "response": response })),
        )
    }

    pub(crate) fn list_models(&self) -> AgentResult<Vec<Model>> {
        let response = self
            .request(Method::GET, &["provider"], None)?
            .send()
            .and_then(Response::error_for_status)
            .map_err(|_| request_failed())?;
        parse_models(&read_body(response)?)
    }

    pub(crate) fn subscribe(&self) -> AgentResult<Response> {
        let url = self.endpoint(&["event"], true)?;
        self.client
            .get(url)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .and_then(Response::error_for_status)
            .map_err(|_| request_failed())
    }

    fn request_json(
        &self,
        method: Method,
        path: &[&str],
        body: Option<Value>,
    ) -> AgentResult<Value> {
        let response = self
            .request(method, path, body)?
            .send()
            .and_then(Response::error_for_status)
            .map_err(|_| request_failed())?;
        serde_json::from_slice(&read_body(response)?).map_err(|_| request_failed())
    }

    fn request_empty(&self, method: Method, path: &[&str], body: Option<Value>) -> AgentResult<()> {
        self.request(method, path, body)?
            .send()
            .and_then(Response::error_for_status)
            .map(|_| ())
            .map_err(|_| request_failed())
    }

    fn request(
        &self,
        method: Method,
        path: &[&str],
        body: Option<Value>,
    ) -> AgentResult<RequestBuilder> {
        let get = method == Method::GET;
        let url = self.endpoint(path, get)?;
        let mut request = self.client.request(method, url).timeout(REQUEST_TIMEOUT);
        if !get && let Some(directory) = &self.directory {
            let encoded =
                url::form_urlencoded::byte_serialize(directory.as_bytes()).collect::<String>();
            request = request.header("x-opencode-directory", encoded);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        Ok(request)
    }

    fn endpoint(&self, path: &[&str], include_directory_query: bool) -> AgentResult<Url> {
        let mut url = self.base_url.clone();
        url.set_query(None);
        url.set_fragment(None);
        url.path_segments_mut()
            .map_err(|_| request_failed())?
            .clear()
            .extend(path);
        if include_directory_query && let Some(directory) = &self.directory {
            url.query_pairs_mut().append_pair("directory", directory);
        }
        Ok(url)
    }
}

pub(crate) fn validate_base_url(url: &Url) -> AgentResult<()> {
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AgentError::Failed(
            "OpenCode server URL must use literal loopback HTTP".into(),
        ));
    }
    Ok(())
}

fn read_body(response: Response) -> AgentResult<Vec<u8>> {
    let mut bytes = Vec::new();
    response
        .take((MAX_JSON_BODY as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| request_failed())?;
    if bytes.len() > MAX_JSON_BODY {
        return Err(AgentError::Failed(
            "OpenCode response exceeded the safety limit".into(),
        ));
    }
    Ok(bytes)
}

fn parse_session(value: Value) -> AgentResult<SessionRecord> {
    #[derive(Deserialize)]
    struct WireSession {
        id: String,
        title: Option<String>,
        time: WireTime,
    }
    #[derive(Deserialize)]
    struct WireTime {
        created: f64,
    }
    let session: WireSession = serde_json::from_value(value).map_err(|_| request_failed())?;
    if session.id.is_empty() {
        return Err(request_failed());
    }
    Ok(SessionRecord {
        id: session.id,
        title: session.title.filter(|title| !title.is_empty()),
        created_at: session.time.created,
    })
}

fn ordered_models<'de, D>(deserializer: D) -> Result<Vec<WireModel>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = Vec<WireModel>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an OpenCode model object")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            let mut models = Vec::new();
            while let Some((_key, model)) = map.next_entry::<String, WireModel>()? {
                models.push(model);
            }
            Ok(models)
        }
    }
    deserializer.deserialize_map(Visitor)
}

fn parse_models(bytes: &[u8]) -> AgentResult<Vec<Model>> {
    let result: ProviderList = serde_json::from_slice(bytes).map_err(|_| request_failed())?;
    Ok(result
        .all
        .into_iter()
        .filter(|provider| result.connected.contains(&provider.id))
        .flat_map(|provider| {
            let default = result.default.get(&provider.id).cloned();
            provider.models.into_iter().map(move |model| Model {
                id: format!("{}/{}", provider.id, model.id),
                display_name: format!("{} · {}", provider.name, model.name),
                description: None,
                is_default: default.as_deref() == Some(model.id.as_str()),
                reasoning_efforts: Vec::new(),
                default_reasoning_effort: None,
                service_tiers: Vec::new(),
                default_service_tier: None,
            })
        })
        .collect())
}

fn request_failed() -> AgentError {
    AgentError::Failed("OpenCode request failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_literal_loopback_http_base_urls() {
        assert!(validate_base_url(&Url::parse("http://127.0.0.1:4311").unwrap()).is_ok());
        for url in [
            "http://localhost:4311",
            "http://[::1]:4311",
            "https://127.0.0.1:4311",
            "http://127.0.0.1",
            "http://example.com:4311",
        ] {
            assert!(validate_base_url(&Url::parse(url).unwrap()).is_err());
        }
    }

    #[test]
    fn preserves_provider_and_model_wire_order() {
        let models = parse_models(
            br#"{
            "all": [
                {
                    "id": "provider-1",
                    "name": "Provider One",
                    "models": {
                        "z": { "id": "z-model", "name": "Z Model" },
                        "a": { "id": "a-model", "name": "A Model" }
                    }
                },
                {
                    "id": "disconnected",
                    "name": "Hidden",
                    "models": { "hidden": { "id": "hidden", "name": "Hidden" } }
                }
            ],
            "default": { "provider-1": "a-model" },
            "connected": ["provider-1"]
        }"#,
        )
        .unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| (model.id.as_str(), model.is_default))
                .collect::<Vec<_>>(),
            [("provider-1/z-model", false), ("provider-1/a-model", true)]
        );
        assert_eq!(models[0].display_name, "Provider One · Z Model");
    }
}
