use harness_credentials::CredentialStore;
use harness_protocol::{
    ModelConnection, ModelConnectionInput, ModelConnectionPreset, ModelTransport,
    ModelTransportCapabilities,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use url::Url;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredModelConnection {
    pub id: String,
    pub display_name: String,
    pub preset: ModelConnectionPreset,
    pub transport: ModelTransport,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub enabled: bool,
    pub credential_ref: String,
}

impl StoredModelConnection {
    pub(crate) fn input(&self) -> ModelConnectionInput {
        ModelConnectionInput {
            id: self.id.clone(),
            display_name: self.display_name.clone(),
            preset: self.preset,
            transport: self.transport,
            base_url: self.base_url.clone(),
            default_model: self.default_model.clone(),
            enabled: self.enabled,
        }
    }
}

#[derive(Serialize)]
struct ConfigFile<'a> {
    version: u8,
    connections: &'a [StoredModelConnection],
}

#[derive(Debug, Error)]
pub(crate) enum ModelConnectionError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("invalid provider config: expected a version 1 connection list")]
    InvalidFile,
    #[error("{0}")]
    InvalidConnection(String),
    #[error("model connection \"{0}\" does not exist")]
    NotFound(String),
    #[error(transparent)]
    Credential(#[from] harness_credentials::CredentialError),
}

pub(crate) struct ModelConnectionStore {
    location: PathBuf,
    credentials: Arc<dyn CredentialStore>,
}

impl ModelConnectionStore {
    pub(crate) fn new(location: PathBuf, credentials: Arc<dyn CredentialStore>) -> Self {
        Self {
            location,
            credentials,
        }
    }

    pub(crate) fn list(&self) -> Result<Vec<ModelConnection>, ModelConnectionError> {
        self.read()?
            .iter()
            .map(|connection| Ok(self.public(connection)))
            .collect()
    }

    pub(crate) fn get(&self, id: &str) -> Result<StoredModelConnection, ModelConnectionError> {
        self.read()?
            .into_iter()
            .find(|connection| connection.id == id)
            .ok_or_else(|| ModelConnectionError::NotFound(id.into()))
    }

    pub(crate) fn upsert(
        &self,
        input: ModelConnectionInput,
    ) -> Result<ModelConnection, ModelConnectionError> {
        let input = normalize_input(input)?;
        let mut connections = self.read()?;
        let index = connections
            .iter()
            .position(|connection| connection.id == input.id);
        let credential_ref = index
            .and_then(|index| connections.get(index))
            .map(|connection| connection.credential_ref.clone())
            .unwrap_or_else(|| format!("model-connections/{}", input.id));
        let connection = StoredModelConnection {
            id: input.id,
            display_name: input.display_name,
            preset: input.preset,
            transport: input.transport,
            base_url: input.base_url,
            default_model: input.default_model,
            enabled: input.enabled,
            credential_ref,
        };
        match index {
            Some(index) => connections[index] = connection.clone(),
            None => connections.push(connection.clone()),
        }
        self.write(&connections)?;
        Ok(self.public(&connection))
    }

    pub(crate) fn set_credential(
        &self,
        id: &str,
        api_key: &str,
    ) -> Result<(), ModelConnectionError> {
        let connection = self.get(id)?;
        self.credentials
            .write(&connection.credential_ref, api_key)?;
        Ok(())
    }

    pub(crate) fn remove(&self, id: &str) -> Result<(), ModelConnectionError> {
        let mut connections = self.read()?;
        let index = connections
            .iter()
            .position(|connection| connection.id == id)
            .ok_or_else(|| ModelConnectionError::NotFound(id.into()))?;
        let connection = connections.remove(index);
        self.write(&connections)?;
        self.credentials.remove(&connection.credential_ref);
        Ok(())
    }

    fn public(&self, connection: &StoredModelConnection) -> ModelConnection {
        let supports_discovery_and_usage = connection.preset != ModelConnectionPreset::Zai;
        ModelConnection {
            id: connection.id.clone(),
            display_name: connection.display_name.clone(),
            preset: connection.preset,
            transport: connection.transport,
            base_url: connection.base_url.clone(),
            default_model: connection.default_model.clone(),
            enabled: connection.enabled,
            credential_configured: self.credentials.contains(&connection.credential_ref),
            capabilities: Some(ModelTransportCapabilities {
                streaming: true,
                tools: true,
                images: false,
                reasoning: true,
                model_discovery: supports_discovery_and_usage,
                usage: supports_discovery_and_usage,
            }),
            problem: None,
        }
    }

    fn read(&self) -> Result<Vec<StoredModelConnection>, ModelConnectionError> {
        if !self.location.exists() {
            return Ok(Vec::new());
        }
        let value: Value = serde_json::from_slice(&fs::read(&self.location)?)?;
        let object = value.as_object().ok_or(ModelConnectionError::InvalidFile)?;
        if object.get("version").and_then(Value::as_u64) != Some(1) {
            return Err(ModelConnectionError::InvalidFile);
        }
        let raw = object
            .get("connections")
            .and_then(Value::as_array)
            .ok_or(ModelConnectionError::InvalidFile)?;
        raw.iter()
            .map(|value| {
                let connection = serde_json::from_value::<StoredModelConnection>(value.clone())?;
                validate_stored(connection)
            })
            .collect()
    }

    fn write(&self, connections: &[StoredModelConnection]) -> Result<(), ModelConnectionError> {
        let parent = self
            .location
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let temporary = suffixed_path(&self.location, &format!(".{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let mut output = options.open(&temporary)?;
            serde_json::to_writer_pretty(
                &mut output,
                &ConfigFile {
                    version: 1,
                    connections,
                },
            )?;
            output.write_all(b"\n")?;
            output.sync_all()?;
            replace_file(&temporary, &self.location)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(Into::into)
    }
}

fn normalize_input(
    mut input: ModelConnectionInput,
) -> Result<ModelConnectionInput, ModelConnectionError> {
    if input.id.is_empty() {
        return Err(invalid("connection id must be non-empty"));
    }
    input.display_name = input.display_name.trim().into();
    if input.display_name.is_empty() {
        return Err(invalid("connection display name must be non-empty"));
    }
    validate_endpoint(&input.base_url)?;
    input.default_model = input.default_model.map(|model| model.trim().into());
    if input.default_model.as_deref() == Some("") {
        return Err(invalid("default model must be non-empty when present"));
    }
    Ok(input)
}

fn validate_stored(
    connection: StoredModelConnection,
) -> Result<StoredModelConnection, ModelConnectionError> {
    let normalized = normalize_input(ModelConnectionInput {
        id: connection.id.clone(),
        display_name: connection.display_name.clone(),
        preset: connection.preset,
        transport: connection.transport,
        base_url: connection.base_url.clone(),
        default_model: connection.default_model.clone(),
        enabled: connection.enabled,
    })?;
    if connection.credential_ref.is_empty()
        || normalized.display_name != connection.display_name
        || normalized.default_model != connection.default_model
    {
        return Err(ModelConnectionError::InvalidFile);
    }
    Ok(connection)
}

fn validate_endpoint(endpoint: &str) -> Result<(), ModelConnectionError> {
    let url = Url::parse(endpoint)
        .map_err(|_| invalid("connection base URL must be HTTPS or loopback HTTP on 127.0.0.1"))?;
    let safe =
        url.scheme() == "https" || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1"));
    if !safe {
        return Err(invalid(
            "connection base URL must be HTTPS or loopback HTTP on 127.0.0.1",
        ));
    }
    Ok(())
}

fn invalid(message: &str) -> ModelConnectionError {
    ModelConnectionError::InvalidConnection(message.into())
}

fn suffixed_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(ToOwned::to_owned).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    if !destination.exists() {
        return fs::rename(source, destination);
    }
    let backup = suffixed_path(destination, &format!(".{}.bak", Uuid::new_v4()));
    fs::rename(destination, &backup)?;
    match fs::rename(source, destination) {
        Ok(()) => {
            let _ = fs::remove_file(backup);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(backup, destination);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryCredentials(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryCredentials {
        fn read(&self, reference: &str) -> harness_credentials::Result<String> {
            self.0
                .lock()
                .unwrap()
                .get(reference)
                .cloned()
                .ok_or_else(|| harness_credentials::CredentialError::NotFound(reference.into()))
        }

        fn contains(&self, reference: &str) -> bool {
            self.0.lock().unwrap().contains_key(reference)
        }

        fn write(&self, reference: &str, value: &str) -> harness_credentials::Result<()> {
            self.0
                .lock()
                .unwrap()
                .insert(reference.into(), value.into());
            Ok(())
        }

        fn remove(&self, reference: &str) {
            self.0.lock().unwrap().remove(reference);
        }
    }

    #[test]
    fn keeps_api_keys_out_of_the_human_readable_config() {
        let directory = tempfile::tempdir().unwrap();
        let location = directory.path().join("providers.json");
        let credentials = Arc::new(MemoryCredentials::default());
        let store = ModelConnectionStore::new(location.clone(), credentials);
        store.upsert(openrouter()).unwrap();
        store
            .set_credential("work-openrouter", "secret-test-key")
            .unwrap();

        assert!(store.list().unwrap()[0].credential_configured);
        let raw = fs::read_to_string(location).unwrap();
        assert!(!raw.contains("secret-test-key"));
        assert!(raw.contains("model-connections/work-openrouter"));
    }

    #[test]
    fn preserves_the_credential_reference_on_update_and_removes_the_secret_last() {
        let directory = tempfile::tempdir().unwrap();
        let credentials = Arc::new(MemoryCredentials::default());
        let store =
            ModelConnectionStore::new(directory.path().join("providers.json"), credentials.clone());
        store.upsert(openrouter()).unwrap();
        store.set_credential("work-openrouter", "secret").unwrap();
        let mut updated = openrouter();
        updated.display_name = "Updated".into();
        store.upsert(updated).unwrap();
        assert!(credentials.contains("model-connections/work-openrouter"));
        store.remove("work-openrouter").unwrap();
        assert!(!credentials.contains("model-connections/work-openrouter"));
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn rejects_remote_plaintext_endpoints() {
        let directory = tempfile::tempdir().unwrap();
        let store = ModelConnectionStore::new(
            directory.path().join("providers.json"),
            Arc::new(MemoryCredentials::default()),
        );
        let mut connection = openrouter();
        connection.base_url = "http://example.com/v1".into();
        assert!(matches!(
            store.upsert(connection),
            Err(ModelConnectionError::InvalidConnection(_))
        ));
        let mut loopback = openrouter();
        loopback.base_url = "http://127.0.0.1:11434/v1".into();
        store.upsert(loopback).unwrap();
    }

    fn openrouter() -> ModelConnectionInput {
        ModelConnectionInput {
            id: "work-openrouter".into(),
            display_name: "Work OpenRouter".into(),
            preset: ModelConnectionPreset::Openrouter,
            transport: ModelTransport::OpenaiCompatible,
            base_url: "https://openrouter.ai/api/v1".into(),
            default_model: Some("openai/gpt-5.6".into()),
            enabled: true,
        }
    }
}
