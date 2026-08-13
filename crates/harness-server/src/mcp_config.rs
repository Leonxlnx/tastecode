use harness_protocol::{McpConfigValue, McpServerConfig, McpTransport, ProviderId};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

type Servers = BTreeMap<String, McpServerConfig>;
type Providers = BTreeMap<String, Servers>;
type Projects = BTreeMap<String, Providers>;

#[derive(Serialize)]
struct ConfigFile {
    version: u8,
    projects: Projects,
}

impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            version: 1,
            projects: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum McpConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("invalid MCP config: expected a version 1 project map")]
    InvalidFile,
    #[error("{0}")]
    InvalidServer(String),
    #[error("project MCP server \"{0}\" already exists")]
    AlreadyExists(String),
    #[error("project MCP server \"{0}\" does not exist")]
    NotFound(String),
}

pub(crate) struct McpConfigStore {
    location: PathBuf,
    read_lossy: bool,
}

impl McpConfigStore {
    pub(crate) fn new(location: PathBuf) -> Self {
        Self {
            location,
            read_lossy: false,
        }
    }

    pub(crate) fn list(
        &mut self,
        provider: ProviderId,
        project_path: &str,
    ) -> Result<Vec<McpServerConfig>, McpConfigError> {
        let file = self.read()?;
        let project = canonical_project_path(project_path)?;
        Ok(file
            .projects
            .get(&project)
            .and_then(|providers| providers.get(provider_name(provider)))
            .map(|servers| servers.values().cloned().collect())
            .unwrap_or_default())
    }

    pub(crate) fn add(
        &mut self,
        provider: ProviderId,
        project_path: &str,
        server: McpServerConfig,
    ) -> Result<(), McpConfigError> {
        let server = normalize_server(server)?;
        let mut file = self.read()?;
        let servers = servers_mut(&mut file, provider, project_path)?;
        if servers.contains_key(&server.id) {
            return Err(McpConfigError::AlreadyExists(server.id));
        }
        servers.insert(server.id.clone(), server);
        self.write(&file)
    }

    pub(crate) fn update(
        &mut self,
        provider: ProviderId,
        project_path: &str,
        server: McpServerConfig,
    ) -> Result<(), McpConfigError> {
        let server = normalize_server(server)?;
        let mut file = self.read()?;
        let servers = servers_mut(&mut file, provider, project_path)?;
        if !servers.contains_key(&server.id) {
            return Err(McpConfigError::NotFound(server.id));
        }
        servers.insert(server.id.clone(), server);
        self.write(&file)
    }

    pub(crate) fn remove(
        &mut self,
        provider: ProviderId,
        project_path: &str,
        server_id: &str,
    ) -> Result<(), McpConfigError> {
        let mut file = self.read()?;
        let project = canonical_project_path(project_path)?;
        let provider = provider_name(provider);
        let removed = file
            .projects
            .get_mut(&project)
            .and_then(|providers| providers.get_mut(provider))
            .and_then(|servers| servers.remove(server_id));
        if removed.is_none() {
            return Err(McpConfigError::NotFound(server_id.into()));
        }
        if file.projects[&project][provider].is_empty() {
            file.projects.get_mut(&project).unwrap().remove(provider);
        }
        if file.projects[&project].is_empty() {
            file.projects.remove(&project);
        }
        self.write(&file)
    }

    fn read(&mut self) -> Result<ConfigFile, McpConfigError> {
        if !self.location.exists() {
            self.read_lossy = false;
            return Ok(ConfigFile::default());
        }
        let value: Value = serde_json::from_slice(&fs::read(&self.location)?)?;
        let object = value.as_object().ok_or(McpConfigError::InvalidFile)?;
        if object.get("version").and_then(Value::as_u64) != Some(1) {
            return Err(McpConfigError::InvalidFile);
        }
        let projects = object
            .get("projects")
            .and_then(Value::as_object)
            .ok_or(McpConfigError::InvalidFile)?;
        let mut parsed = ConfigFile::default();
        let mut skipped = false;
        for (project_path, providers) in projects {
            let Some(providers) = providers.as_object() else {
                skipped = true;
                continue;
            };
            let mut parsed_providers = Providers::new();
            for (provider_name, servers) in providers {
                if parse_provider(provider_name).is_none() {
                    skipped = true;
                    continue;
                }
                let Some(servers) = servers.as_object() else {
                    skipped = true;
                    continue;
                };
                let mut parsed_servers = Servers::new();
                for (server_id, server) in servers {
                    let Ok(server) = serde_json::from_value::<McpServerConfig>(server.clone())
                    else {
                        skipped = true;
                        continue;
                    };
                    let Ok(server) = normalize_server(server) else {
                        skipped = true;
                        continue;
                    };
                    if server.id != *server_id {
                        skipped = true;
                        continue;
                    }
                    parsed_servers.insert(server_id.clone(), server);
                }
                parsed_providers.insert(provider_name.clone(), parsed_servers);
            }
            parsed
                .projects
                .insert(project_path.clone(), parsed_providers);
        }
        self.read_lossy = skipped;
        Ok(parsed)
    }

    fn write(&mut self, file: &ConfigFile) -> Result<(), McpConfigError> {
        let parent = self
            .location
            .parent()
            .ok_or_else(|| std::io::Error::other("MCP config path has no parent"))?;
        fs::create_dir_all(parent)?;
        let lossy_backup = if self.read_lossy && self.location.exists() {
            let backup = suffixed_path(
                &self.location,
                &format!(".invalid-{}-{}.bak", now_ms(), Uuid::new_v4()),
            );
            fs::rename(&self.location, &backup)?;
            self.read_lossy = false;
            Some(backup)
        } else {
            None
        };
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
            serde_json::to_writer_pretty(&mut output, file)?;
            output.write_all(b"\n")?;
            output.sync_all()?;
            replace_file(&temporary, &self.location)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            if let Some(backup) = lossy_backup
                && !self.location.exists()
                && fs::rename(backup, &self.location).is_ok()
            {
                self.read_lossy = true;
            }
        }
        result.map_err(Into::into)
    }
}

fn servers_mut<'a>(
    file: &'a mut ConfigFile,
    provider: ProviderId,
    project_path: &str,
) -> Result<&'a mut Servers, McpConfigError> {
    let project = canonical_project_path(project_path)?;
    Ok(file
        .projects
        .entry(project)
        .or_default()
        .entry(provider_name(provider).into())
        .or_default())
}

pub(crate) fn normalize_server(
    mut server: McpServerConfig,
) -> Result<McpServerConfig, McpConfigError> {
    if server.id.is_empty() {
        return Err(McpConfigError::InvalidServer(
            "MCP server id must be non-empty".into(),
        ));
    }
    if !server.enabled {
        server.display_name = None;
        server.transport = None;
        return Ok(server);
    }
    if server.display_name.as_deref().is_some_and(str::is_empty) {
        return Err(McpConfigError::InvalidServer(
            "MCP display name must be non-empty when present".into(),
        ));
    }
    let transport = server.transport.as_ref().ok_or_else(|| {
        McpConfigError::InvalidServer("enabled MCP server requires a transport".into())
    })?;
    validate_transport(transport)?;
    Ok(server)
}

fn validate_transport(transport: &McpTransport) -> Result<(), McpConfigError> {
    match transport {
        McpTransport::Stdio {
            command,
            cwd,
            environment,
            ..
        } => {
            if command.is_empty() {
                return invalid_server("stdio MCP transport requires a command");
            }
            if cwd.as_deref().is_some_and(str::is_empty) {
                return invalid_server("MCP working directory must be non-empty");
            }
            if let Some(environment) = environment {
                validate_values("environment", environment)?;
            }
        }
        McpTransport::Http { url, headers } => {
            let url = Url::parse(url)
                .map_err(|_| McpConfigError::InvalidServer("invalid MCP HTTP URL".into()))?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return invalid_server("MCP transport URL must use HTTP or HTTPS");
            }
            if let Some(headers) = headers {
                validate_values("header", headers)?;
            }
        }
    }
    Ok(())
}

fn validate_values(
    label: &str,
    values: &BTreeMap<String, McpConfigValue>,
) -> Result<(), McpConfigError> {
    for (name, value) in values {
        if name.is_empty() {
            return invalid_server(&format!("MCP {label} name must be non-empty"));
        }
        if let McpConfigValue::Credential { credential_ref } = value
            && credential_ref.is_empty()
        {
            return invalid_server(&format!(
                "credential reference for MCP {label} {name} must be non-empty"
            ));
        }
    }
    Ok(())
}

fn invalid_server<T>(message: &str) -> Result<T, McpConfigError> {
    Err(McpConfigError::InvalidServer(message.into()))
}

fn canonical_project_path(path: &str) -> Result<String, McpConfigError> {
    let input = PathBuf::from(path);
    let absolute = if input.exists() {
        fs::canonicalize(input)?
    } else {
        let input = if input.is_absolute() {
            input
        } else {
            std::env::current_dir()?.join(input)
        };
        normalize_path(input)
    };
    let text = absolute.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    return Ok(text.to_lowercase());
    #[cfg(not(target_os = "windows"))]
    Ok(text)
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn provider_name(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Codex => "codex",
        ProviderId::ClaudeCode => "claude-code",
        ProviderId::Grok => "grok",
        ProviderId::Cursor => "cursor",
        ProviderId::OpenCode => "opencode",
        ProviderId::Antigravity => "antigravity",
        ProviderId::Acp => "acp",
        ProviderId::Api => "api",
    }
}

fn parse_provider(value: &str) -> Option<ProviderId> {
    serde_json::from_value(Value::String(value.into())).ok()
}

fn suffixed_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().into();
    value.push(suffix);
    PathBuf::from(value)
}

fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(_) if destination.exists() => {
            let backup = suffixed_path(destination, &format!(".{}.replace", Uuid::new_v4()));
            fs::rename(destination, &backup)?;
            match fs::rename(source, destination) {
                Ok(()) => {
                    let _ = fs::remove_file(backup);
                    Ok(())
                }
                Err(error) => {
                    let _ = fs::rename(&backup, destination);
                    Err(error)
                }
            }
        }
        Err(error) => Err(error),
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn http_server(id: &str, url: &str) -> McpServerConfig {
        McpServerConfig {
            id: id.into(),
            enabled: true,
            display_name: Some("Docs".into()),
            transport: Some(McpTransport::Http {
                url: url.into(),
                headers: None,
            }),
        }
    }

    #[test]
    fn add_update_remove_round_trips_the_version_one_file() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        fs::create_dir(&project).unwrap();
        let location = directory.path().join("config/mcp.json");
        let mut store = McpConfigStore::new(location.clone());
        store
            .add(
                ProviderId::Codex,
                &project.to_string_lossy(),
                http_server("docs", "https://example.com/mcp"),
            )
            .unwrap();
        assert_eq!(
            store
                .list(ProviderId::Codex, &project.to_string_lossy())
                .unwrap()
                .len(),
            1
        );
        store
            .update(
                ProviderId::Codex,
                &project.to_string_lossy(),
                http_server("docs", "https://example.com/v2"),
            )
            .unwrap();
        let reopened = fs::read_to_string(&location).unwrap();
        assert!(reopened.contains("https://example.com/v2"));
        assert!(!reopened.contains("https://example.com/mcp"));
        store
            .remove(ProviderId::Codex, &project.to_string_lossy(), "docs")
            .unwrap();
        assert!(
            store
                .list(ProviderId::Codex, &project.to_string_lossy())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn lossy_read_backs_up_the_original_before_a_sanitized_write() {
        let directory = tempfile::tempdir().unwrap();
        let location = directory.path().join("mcp.json");
        fs::write(
            &location,
            serde_json::to_vec_pretty(&json!({
                "version": 1,
                "projects": {
                    "/repo": {
                        "codex": {
                            "valid": {
                                "id": "valid",
                                "enabled": true,
                                "transport": { "type": "http", "url": "https://example.com" }
                            },
                            "broken": { "id": "other", "enabled": false }
                        }
                    },
                    "/bad": []
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let mut store = McpConfigStore::new(location.clone());
        assert_eq!(store.list(ProviderId::Codex, "/repo").unwrap().len(), 1);
        store
            .add(
                ProviderId::Codex,
                "/repo",
                McpServerConfig {
                    id: "disabled".into(),
                    enabled: false,
                    display_name: None,
                    transport: None,
                },
            )
            .unwrap();
        let backups = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".invalid-"))
            .count();
        assert_eq!(backups, 1);
        let rewritten = fs::read_to_string(location).unwrap();
        assert!(rewritten.contains("disabled"));
        assert!(!rewritten.contains("broken"));
    }

    #[test]
    fn validates_enabled_transports_and_normalizes_disabled_overrides() {
        assert!(normalize_server(http_server("docs", "ftp://example.com")).is_err());
        assert!(
            normalize_server(McpServerConfig {
                id: "docs".into(),
                enabled: true,
                display_name: None,
                transport: None,
            })
            .is_err()
        );
        let disabled = normalize_server(McpServerConfig {
            id: "docs".into(),
            enabled: false,
            display_name: Some("ignored".into()),
            transport: Some(McpTransport::Http {
                url: "https://example.com".into(),
                headers: None,
            }),
        })
        .unwrap();
        assert!(disabled.display_name.is_none());
        assert!(disabled.transport.is_none());
    }
}
