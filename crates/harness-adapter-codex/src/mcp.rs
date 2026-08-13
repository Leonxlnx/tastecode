use harness_agent::CredentialValues;
use harness_protocol::{
    McpAuth, McpAuthMethod, McpCapabilities, McpConfigValue, McpResource, McpResourceTemplate,
    McpServer, McpServerConfig, McpServerScope, McpStartupStatus, McpTool, McpTransport,
};
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;

pub const CODEX_MCP_CAPABILITIES: McpCapabilities = McpCapabilities {
    inventory: true,
    add: true,
    update: true,
    remove: true,
    reload: true,
    start_o_auth: true,
    cancel_o_auth: false,
};

pub(crate) struct PreparedMcpConfig {
    pub servers: Map<String, Value>,
    pub environment: BTreeMap<String, String>,
}

pub(crate) fn prepare_mcp_config(
    servers: &[McpServerConfig],
    credentials: &CredentialValues,
) -> Result<PreparedMcpConfig, String> {
    let mut prepared = Map::new();
    let mut environment = BTreeMap::new();
    for server in servers {
        if !server.enabled {
            prepared.insert(server.id.clone(), json!({ "enabled": false }));
            continue;
        }
        let transport = server
            .transport
            .as_ref()
            .ok_or_else(|| format!("enabled MCP server {} has no transport", server.id))?;
        let value = match transport {
            McpTransport::Stdio {
                command,
                args,
                cwd,
                environment,
            } => {
                let values = environment
                    .as_ref()
                    .map(|values| {
                        values
                            .iter()
                            .map(|(name, value)| {
                                Ok((name.clone(), config_value(value, credentials)?))
                            })
                            .collect::<Result<Map<_, _>, String>>()
                    })
                    .transpose()?
                    .unwrap_or_default();
                let mut value = Map::new();
                value.insert("command".into(), Value::String(command.clone()));
                value.insert("enabled".into(), Value::Bool(true));
                if let Some(args) = args {
                    value.insert("args".into(), json!(args));
                }
                if let Some(cwd) = cwd {
                    value.insert("cwd".into(), Value::String(cwd.clone()));
                }
                if !values.is_empty() {
                    value.insert("env".into(), Value::Object(values));
                }
                Value::Object(value)
            }
            McpTransport::Http { url, headers } => {
                let mut literal = Map::new();
                let mut inherited = Map::new();
                for (name, value) in headers.iter().flatten() {
                    match value {
                        McpConfigValue::Literal { value } => {
                            literal.insert(name.clone(), Value::String(value.clone()));
                        }
                        McpConfigValue::Credential { credential_ref } => {
                            let variable = credential_environment_name(&server.id, name);
                            environment.insert(
                                variable.clone(),
                                secret(credentials, credential_ref)?.into(),
                            );
                            inherited.insert(name.clone(), Value::String(variable));
                        }
                    }
                }
                let mut value = Map::new();
                value.insert("url".into(), Value::String(url.clone()));
                value.insert("enabled".into(), Value::Bool(true));
                if !literal.is_empty() {
                    value.insert("http_headers".into(), Value::Object(literal));
                }
                if !inherited.is_empty() {
                    value.insert("env_http_headers".into(), Value::Object(inherited));
                }
                Value::Object(value)
            }
        };
        prepared.insert(server.id.clone(), value);
    }
    Ok(PreparedMcpConfig {
        servers: prepared,
        environment,
    })
}

fn config_value(value: &McpConfigValue, credentials: &CredentialValues) -> Result<Value, String> {
    match value {
        McpConfigValue::Literal { value } => Ok(Value::String(value.clone())),
        McpConfigValue::Credential { credential_ref } => {
            Ok(Value::String(secret(credentials, credential_ref)?.into()))
        }
    }
}

fn secret<'a>(credentials: &'a CredentialValues, reference: &str) -> Result<&'a str, String> {
    credentials
        .get(reference)
        .ok_or_else(|| format!("MCP credential \"{reference}\" is unavailable"))
}

fn credential_environment_name(server_id: &str, header: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(server_id.as_bytes());
    hash.update([0]);
    hash.update(header.as_bytes());
    let digest = hash.finalize();
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    format!("HARNESS_MCP_{suffix}")
}

pub fn map_startup_status(params: &Value) -> Result<McpStartupStatus, String> {
    let object = params
        .as_object()
        .ok_or_else(|| "MCP startup status must be an object".to_owned())?;
    match object.get("status").and_then(Value::as_str) {
        Some("starting") => Ok(McpStartupStatus::Starting),
        Some("ready") => Ok(McpStartupStatus::Ready),
        Some("cancelled") => Ok(McpStartupStatus::Stopped),
        Some("failed") => Ok(McpStartupStatus::Failed {
            message: optional_string(object, "error").unwrap_or_else(|| {
                if object.get("failureReason").and_then(Value::as_str)
                    == Some("reauthenticationRequired")
                {
                    "Authentication required".into()
                } else {
                    "MCP server failed to start".into()
                }
            }),
        }),
        Some(other) => Err(format!("unknown MCP startup status {other}")),
        None => Err("MCP startup status is missing status".into()),
    }
}

pub(crate) fn map_server_status(
    status: &Value,
    startup: Option<&McpStartupStatus>,
) -> Result<McpServer, String> {
    let object = status
        .as_object()
        .ok_or_else(|| "server status must be an object".to_owned())?;
    let id = required_string(object, "name")?;
    let server_info = match object.get("serverInfo") {
        None | Some(Value::Null) => None,
        Some(Value::Object(info)) => Some(info),
        Some(_) => return Err(format!("MCP server {id} has invalid serverInfo")),
    };
    let display_name = server_info.and_then(|info| {
        optional_string(info, "title").or_else(|| {
            optional_string(info, "name").filter(|candidate| candidate.as_str() != id.as_str())
        })
    });
    let tools = object
        .get("tools")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("MCP server {id} is missing tools"))?
        .values()
        .filter_map(map_tool)
        .collect();
    let resources = required_array(object, "resources")?
        .iter()
        .map(map_resource)
        .collect::<Result<Vec<_>, _>>()?;
    let resource_templates = required_array(object, "resourceTemplates")?
        .iter()
        .map(map_resource_template)
        .collect::<Result<Vec<_>, _>>()?;
    let auth = match object.get("authStatus").and_then(Value::as_str) {
        Some("notLoggedIn") => McpAuth::SignInRequired {
            method: McpAuthMethod::Oauth,
        },
        Some("bearerToken") => McpAuth::Authenticated {
            method: McpAuthMethod::Bearer,
        },
        Some("oAuth") => McpAuth::Authenticated {
            method: McpAuthMethod::Oauth,
        },
        Some("unsupported") => McpAuth::NotRequired,
        Some(other) => return Err(format!("MCP server {id} has unknown auth status {other}")),
        None => return Err(format!("MCP server {id} is missing authStatus")),
    };

    Ok(McpServer {
        id,
        display_name,
        description: server_info.and_then(|info| optional_string(info, "description")),
        version: server_info.and_then(|info| optional_string(info, "version")),
        scope: McpServerScope::Global,
        enabled: true,
        transport: None,
        auth,
        startup: startup.cloned().unwrap_or_else(|| {
            if server_info.is_some() {
                McpStartupStatus::Ready
            } else {
                McpStartupStatus::Stopped
            }
        }),
        tools,
        resources,
        resource_templates,
    })
}

fn map_tool(value: &Value) -> Option<McpTool> {
    let object = value.as_object()?;
    let name = object.get("name")?.as_str()?.to_owned();
    let input_schema = object.get("inputSchema")?.as_object().map(json_object)?;
    let output_schema = object
        .get("outputSchema")
        .and_then(Value::as_object)
        .map(json_object);
    Some(McpTool {
        name,
        title: optional_string(object, "title"),
        description: optional_string(object, "description"),
        input_schema,
        output_schema,
    })
}

fn map_resource(value: &Value) -> Result<McpResource, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "MCP resource must be an object".to_owned())?;
    Ok(McpResource {
        uri: required_string(object, "uri")?,
        name: required_string(object, "name")?,
        title: optional_string(object, "title"),
        description: optional_string(object, "description"),
        mime_type: optional_string(object, "mimeType"),
        size: object.get("size").and_then(Value::as_u64),
    })
}

fn map_resource_template(value: &Value) -> Result<McpResourceTemplate, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "MCP resource template must be an object".to_owned())?;
    Ok(McpResourceTemplate {
        uri_template: required_string(object, "uriTemplate")?,
        name: required_string(object, "name")?,
        title: optional_string(object, "title"),
        description: optional_string(object, "description"),
        mime_type: optional_string(object, "mimeType"),
    })
}

fn required_array<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a [Value], String> {
    object
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("missing {key} array"))
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {key} string"))
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn json_object(object: &Map<String, Value>) -> BTreeMap<String, Value> {
    object
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prepares_http_credentials_without_putting_secrets_in_codex_config() {
        let mut credentials = CredentialValues::default();
        credentials.insert("docs-token".into(), "super-secret".into());
        let servers = [McpServerConfig {
            id: "docs".into(),
            enabled: true,
            display_name: None,
            transport: Some(McpTransport::Http {
                url: "https://docs.example/mcp".into(),
                headers: Some(BTreeMap::from([
                    (
                        "Authorization".into(),
                        McpConfigValue::Credential {
                            credential_ref: "docs-token".into(),
                        },
                    ),
                    (
                        "X-Client".into(),
                        McpConfigValue::Literal {
                            value: "harness".into(),
                        },
                    ),
                ])),
            }),
        }];

        let prepared = prepare_mcp_config(&servers, &credentials).unwrap();
        let variable = credential_environment_name("docs", "Authorization");
        assert_eq!(prepared.environment.get(&variable).unwrap(), "super-secret");
        assert_eq!(
            prepared.servers["docs"]["env_http_headers"]["Authorization"],
            variable
        );
        assert_eq!(
            prepared.servers["docs"]["http_headers"]["X-Client"],
            "harness"
        );
        assert!(
            !Value::Object(prepared.servers)
                .to_string()
                .contains("super-secret")
        );
    }

    #[test]
    fn resolves_stdio_credentials_inside_the_server_environment() {
        let mut credentials = CredentialValues::default();
        credentials.insert("stdio-token".into(), "process-secret".into());
        let servers = [McpServerConfig {
            id: "local".into(),
            enabled: true,
            display_name: None,
            transport: Some(McpTransport::Stdio {
                command: "node".into(),
                args: Some(vec!["server.js".into()]),
                cwd: Some("C:\\repo".into()),
                environment: Some(BTreeMap::from([(
                    "TOKEN".into(),
                    McpConfigValue::Credential {
                        credential_ref: "stdio-token".into(),
                    },
                )])),
            }),
        }];

        let prepared = prepare_mcp_config(&servers, &credentials).unwrap();
        assert!(prepared.environment.is_empty());
        assert_eq!(prepared.servers["local"]["env"]["TOKEN"], "process-secret");
        assert_eq!(prepared.servers["local"]["cwd"], "C:\\repo");
    }

    #[test]
    fn missing_credentials_fail_without_echoing_any_secret() {
        let servers = [McpServerConfig {
            id: "docs".into(),
            enabled: true,
            display_name: None,
            transport: Some(McpTransport::Http {
                url: "https://docs.example/mcp".into(),
                headers: Some(BTreeMap::from([(
                    "Authorization".into(),
                    McpConfigValue::Credential {
                        credential_ref: "missing-token".into(),
                    },
                )])),
            }),
        }];

        let error = match prepare_mcp_config(&servers, &CredentialValues::default()) {
            Ok(_) => panic!("missing credential unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error, "MCP credential \"missing-token\" is unavailable");
    }

    #[test]
    fn credential_environment_names_are_stable_and_header_specific() {
        let first = credential_environment_name("docs", "Authorization");
        assert_eq!(first, credential_environment_name("docs", "Authorization"));
        assert!(first.starts_with("HARNESS_MCP_"));
        assert_eq!(first.len(), "HARNESS_MCP_".len() + 16);
        assert_ne!(first, credential_environment_name("docs", "X-Token"));
    }

    #[test]
    fn maps_captured_tools_resources_auth_and_startup_failures() {
        let status = json!({
            "name": "capture",
            "serverInfo": {
                "name": "captured-server",
                "title": "Captured server",
                "version": "1.2.3",
                "description": "Captured from a real Codex app-server exchange"
            },
            "tools": {
                "captured_tool": {
                    "name": "captured_tool",
                    "title": "Captured tool",
                    "description": "A captured tool",
                    "inputSchema": {
                        "type": "object",
                        "properties": { "query": { "type": "string" } },
                        "required": ["query"]
                    },
                    "outputSchema": {
                        "type": "object",
                        "properties": { "answer": { "type": "string" } }
                    }
                }
            },
            "resources": [{
                "uri": "capture://resource",
                "name": "captured-resource",
                "title": "Captured resource",
                "description": "A captured resource",
                "mimeType": "text/plain",
                "size": 7
            }],
            "resourceTemplates": [{
                "uriTemplate": "capture://resource/{id}",
                "name": "captured-template",
                "title": "Captured template",
                "mimeType": "text/plain"
            }],
            "authStatus": "oAuth"
        });
        let startup = map_startup_status(&json!({
            "status": "failed",
            "error": "MCP startup failed: program not found",
            "failureReason": null
        }))
        .unwrap();
        let server = map_server_status(&status, Some(&startup)).unwrap();

        assert_eq!(server.id, "capture");
        assert_eq!(server.display_name.as_deref(), Some("Captured server"));
        assert!(matches!(
            server.auth,
            McpAuth::Authenticated {
                method: McpAuthMethod::Oauth
            }
        ));
        assert!(matches!(
            server.startup,
            McpStartupStatus::Failed { ref message }
                if message == "MCP startup failed: program not found"
        ));
        assert_eq!(server.tools[0].name, "captured_tool");
        assert_eq!(server.resources[0].uri, "capture://resource");
        assert_eq!(
            server.resource_templates[0].uri_template,
            "capture://resource/{id}"
        );
    }

    #[test]
    fn skips_partial_tools_and_rejects_unknown_known_fields() {
        let mut status = json!({
            "name": "docs",
            "serverInfo": null,
            "tools": {
                "null": null,
                "missing-schema": { "name": "missing-schema" }
            },
            "resources": [],
            "resourceTemplates": [],
            "authStatus": "unsupported"
        });
        let server = map_server_status(&status, None).unwrap();
        assert!(server.tools.is_empty());
        assert_eq!(server.startup, McpStartupStatus::Stopped);

        status["authStatus"] = json!("future-auth");
        assert!(map_server_status(&status, None).is_err());
        assert!(map_startup_status(&json!({ "status": "future" })).is_err());
    }
}
