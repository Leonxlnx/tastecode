use harness_agent::{AgentError, AgentResult, CredentialValues};
use harness_protocol::{McpConfigValue, McpServerConfig, McpTransport};
use serde_json::{Map, Value, json};

/// Build the `mcp` block accepted through `OPENCODE_CONFIG_CONTENT` by
/// OpenCode 1.x. Credential references are resolved only at process launch.
pub fn open_code_mcp_config(
    servers: &[McpServerConfig],
    credentials: &CredentialValues,
) -> AgentResult<Value> {
    let mut configured = Map::new();
    for server in servers {
        if !server.enabled {
            configured.insert(
                server.id.clone(),
                json!({
                    "type": "local",
                    "command": disabled_command(),
                    "enabled": false
                }),
            );
            continue;
        }
        let transport = server.transport.as_ref().ok_or_else(|| {
            AgentError::Failed(format!(
                "enabled OpenCode MCP server {} has no transport",
                server.id
            ))
        })?;
        let value = match transport {
            McpTransport::Stdio {
                command,
                args,
                environment,
                ..
            } => {
                let mut value = Map::from_iter([
                    ("type".into(), Value::String("local".into())),
                    (
                        "command".into(),
                        Value::Array(
                            std::iter::once(command)
                                .chain(args.iter().flatten())
                                .cloned()
                                .map(Value::String)
                                .collect(),
                        ),
                    ),
                    ("enabled".into(), Value::Bool(true)),
                ]);
                if let Some(environment) = environment {
                    value.insert(
                        "environment".into(),
                        Value::Object(resolve_values(environment, credentials)),
                    );
                }
                Value::Object(value)
            }
            McpTransport::Http { url, headers } => {
                let mut value = Map::from_iter([
                    ("type".into(), Value::String("remote".into())),
                    ("url".into(), Value::String(url.clone())),
                    ("enabled".into(), Value::Bool(true)),
                ]);
                if let Some(headers) = headers {
                    value.insert(
                        "headers".into(),
                        Value::Object(resolve_values(headers, credentials)),
                    );
                }
                Value::Object(value)
            }
        };
        configured.insert(server.id.clone(), value);
    }
    Ok(Value::Object(configured))
}

fn resolve_values(
    values: &std::collections::BTreeMap<String, McpConfigValue>,
    credentials: &CredentialValues,
) -> Map<String, Value> {
    values
        .iter()
        .map(|(key, value)| {
            let value = match value {
                McpConfigValue::Literal { value } => value.as_str(),
                McpConfigValue::Credential { credential_ref } => {
                    credentials.get(credential_ref).unwrap_or_default()
                }
            };
            (key.clone(), Value::String(value.into()))
        })
        .collect()
}

#[cfg(windows)]
fn disabled_command() -> Vec<&'static str> {
    vec!["cmd.exe", "/d", "/s", "/c", "exit", "0"]
}

#[cfg(not(windows))]
fn disabled_command() -> Vec<&'static str> {
    vec!["true"]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, HashMap};

    #[test]
    fn maps_local_remote_and_disabled_servers_at_the_process_boundary() {
        let credentials =
            CredentialValues::new(HashMap::from([("ref-1".into(), "secret-value".into())]));
        let config = open_code_mcp_config(
            &[
                McpServerConfig {
                    id: "docs".into(),
                    enabled: true,
                    display_name: None,
                    transport: Some(McpTransport::Stdio {
                        command: "npx".into(),
                        args: Some(vec!["docs-mcp".into()]),
                        cwd: None,
                        environment: Some(BTreeMap::from([
                            (
                                "PLAIN".into(),
                                McpConfigValue::Literal { value: "x".into() },
                            ),
                            (
                                "TOKEN".into(),
                                McpConfigValue::Credential {
                                    credential_ref: "ref-1".into(),
                                },
                            ),
                        ])),
                    }),
                },
                McpServerConfig {
                    id: "remote".into(),
                    enabled: true,
                    display_name: None,
                    transport: Some(McpTransport::Http {
                        url: "https://mcp.example.test".into(),
                        headers: Some(BTreeMap::from([(
                            "Authorization".into(),
                            McpConfigValue::Credential {
                                credential_ref: "ref-1".into(),
                            },
                        )])),
                    }),
                },
                McpServerConfig {
                    id: "off".into(),
                    enabled: false,
                    display_name: None,
                    transport: None,
                },
            ],
            &credentials,
        )
        .unwrap();

        assert_eq!(config["docs"]["command"], json!(["npx", "docs-mcp"]));
        assert_eq!(config["docs"]["environment"]["PLAIN"], "x");
        assert_eq!(config["docs"]["environment"]["TOKEN"], "secret-value");
        assert_eq!(config["remote"]["type"], "remote");
        assert_eq!(config["remote"]["headers"]["Authorization"], "secret-value");
        assert_eq!(config["off"]["enabled"], false);
        assert!(
            config["off"]["command"]
                .as_array()
                .is_some_and(|args| !args.is_empty())
        );
    }

    #[test]
    fn rejects_an_enabled_server_without_a_transport() {
        assert!(
            open_code_mcp_config(
                &[McpServerConfig {
                    id: "broken".into(),
                    enabled: true,
                    display_name: None,
                    transport: None,
                }],
                &CredentialValues::default(),
            )
            .is_err()
        );
    }
}
