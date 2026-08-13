use harness_agent::{AgentError, AgentResult};
use harness_protocol::{Account, Model};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AcpAgentSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub verified: bool,
    pub supported_version: Option<&'static str>,
    pub model_arg: Option<&'static str>,
    pub model_config_id: Option<&'static str>,
    pub retired: bool,
    pub credential_probe: Option<&'static [&'static str]>,
}

const ACP_AGENTS: &[AcpAgentSpec] = &[
    AcpAgentSpec {
        id: "gemini",
        name: "Gemini CLI",
        command: "gemini",
        args: &["--experimental-acp"],
        verified: true,
        supported_version: None,
        model_arg: Some("--model"),
        model_config_id: None,
        retired: true,
        credential_probe: None,
    },
    AcpAgentSpec {
        id: "kimi",
        name: "Kimi CLI",
        command: "kimi",
        args: &["acp"],
        verified: true,
        supported_version: Some("0.29"),
        model_arg: None,
        model_config_id: Some("model"),
        retired: false,
        credential_probe: Some(&[".kimi-code", "credentials", "kimi-code.json"]),
    },
    AcpAgentSpec {
        id: "qwen",
        name: "Qwen Code",
        command: "qwen",
        args: &["--experimental-acp"],
        verified: false,
        supported_version: None,
        model_arg: Some("--model"),
        model_config_id: None,
        retired: true,
        credential_probe: None,
    },
];

pub fn find_agent_spec(id: &str) -> Option<&'static AcpAgentSpec> {
    ACP_AGENTS.iter().find(|agent| agent.id == id)
}

pub fn listed_agent_specs() -> impl Iterator<Item = &'static AcpAgentSpec> {
    ACP_AGENTS.iter().filter(|agent| !agent.retired)
}

pub fn acp_account(agent_id: &str, home: &Path) -> Account {
    let signed_in = find_agent_spec(agent_id)
        .and_then(|spec| spec.credential_probe)
        .is_some_and(|probe| credential_path(home, probe).is_file());
    Account {
        signed_in,
        email: None,
        plan: None,
    }
}

pub fn acp_sign_out(agent_id: &str, home: &Path) -> AgentResult<()> {
    let spec = find_agent_spec(agent_id);
    let probe = spec
        .and_then(|spec| spec.credential_probe)
        .ok_or(AgentError::Unsupported("signing out from this ACP agent"))?;
    match std::fs::remove_file(credential_path(home, probe)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AgentError::Failed(format!(
            "{} could not sign out",
            spec.map_or(agent_id, |spec| spec.name)
        ))),
    }
}

fn credential_path(home: &Path, components: &[&str]) -> PathBuf {
    components
        .iter()
        .fold(home.to_path_buf(), |path, component| path.join(component))
}

pub fn gemini_models() -> Vec<Model> {
    vec![
        model(
            "gemini-3-pro-preview",
            "Gemini 3 Pro (Preview)",
            "Most capable Gemini model",
            true,
        ),
        model(
            "gemini-3-flash-preview",
            "Gemini 3 Flash (Preview)",
            "Fast Gemini 3 model",
            false,
        ),
        model(
            "gemini-2.5-pro",
            "Gemini 2.5 Pro",
            "Stable Pro model",
            false,
        ),
        model(
            "gemini-2.5-flash",
            "Gemini 2.5 Flash",
            "Stable fast model",
            false,
        ),
        model(
            "gemini-2.5-flash-lite",
            "Gemini 2.5 Flash Lite",
            "Lightest and cheapest model",
            false,
        ),
    ]
}

pub fn parse_kimi_models(output: &str) -> AgentResult<Vec<Model>> {
    #[derive(Deserialize)]
    struct Wire {
        #[serde(default, deserialize_with = "ordered_values")]
        models: Vec<(String, Value)>,
    }

    let wire: Wire = serde_json::from_str(output)
        .map_err(|_| AgentError::Failed("Kimi model discovery returned invalid JSON".into()))?;
    Ok(wire
        .models
        .into_iter()
        .enumerate()
        .map(|(index, (id, details))| {
            let display_name = details
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_owned();
            let reasoning_efforts = details
                .get("supportEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let default_reasoning_effort = details
                .get("defaultEffort")
                .and_then(Value::as_str)
                .map(str::to_owned);
            Model {
                id,
                display_name,
                description: None,
                is_default: index == 0,
                reasoning_efforts,
                default_reasoning_effort,
                service_tiers: Vec::new(),
                default_service_tier: None,
            }
        })
        .collect())
}

fn ordered_values<'de, D>(deserializer: D) -> Result<Vec<(String, Value)>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Visitor;

    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = Vec<(String, Value)>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a Kimi model object")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            let mut values = Vec::new();
            while let Some(entry) = map.next_entry()? {
                values.push(entry);
            }
            Ok(values)
        }
    }

    deserializer.deserialize_map(Visitor)
}

fn model(id: &str, display_name: &str, description: &str, is_default: bool) -> Model {
    Model {
        id: id.into(),
        display_name: display_name.into(),
        description: Some(description.into()),
        is_default,
        reasoning_efforts: Vec::new(),
        default_reasoning_effort: None,
        service_tiers: Vec::new(),
        default_service_tier: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_the_captured_agent_launch_contracts() {
        let kimi = find_agent_spec("kimi").unwrap();
        assert_eq!(kimi.command, "kimi");
        assert_eq!(kimi.args, ["acp"]);
        assert!(kimi.verified);
        assert_eq!(kimi.supported_version, Some("0.29"));
        assert!(!kimi.retired);
        assert_eq!(
            listed_agent_specs()
                .map(|agent| agent.id)
                .collect::<Vec<_>>(),
            ["kimi"]
        );
        assert!(find_agent_spec("gemini").unwrap().retired);
        assert!(find_agent_spec("qwen").unwrap().retired);
        assert!(find_agent_spec("missing").is_none());
    }

    #[test]
    fn probes_and_removes_only_kimis_credential_file() {
        let home = tempfile::tempdir().unwrap();
        assert!(!acp_account("kimi", home.path()).signed_in);
        let credentials = home.path().join(".kimi-code").join("credentials");
        std::fs::create_dir_all(&credentials).unwrap();
        let credential = credentials.join("kimi-code.json");
        std::fs::write(&credential, b"{}").unwrap();
        let sibling = credentials.join("keep.json");
        std::fs::write(&sibling, b"{}").unwrap();
        assert!(acp_account("kimi", home.path()).signed_in);
        acp_sign_out("kimi", home.path()).unwrap();
        assert!(!credential.exists());
        assert!(sibling.exists());
        assert!(!acp_account("qwen", home.path()).signed_in);
        assert!(acp_sign_out("qwen", home.path()).is_err());
    }

    #[test]
    fn offers_the_concrete_gemini_model_names() {
        let models = gemini_models();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            [
                "gemini-3-pro-preview",
                "gemini-3-flash-preview",
                "gemini-2.5-pro",
                "gemini-2.5-flash",
                "gemini-2.5-flash-lite",
            ]
        );
        assert!(models[0].is_default);
        assert_eq!(models.iter().filter(|model| model.is_default).count(), 1);
    }

    #[test]
    fn normalizes_kimi_models_without_reordering_the_wire() {
        let models = parse_kimi_models(
            r#"{
                "models": {
                    "z-model": {
                        "displayName": "Kimi Z",
                        "supportEfforts": ["low", 7, "high"],
                        "defaultEffort": "high"
                    },
                    "a-model": { "displayName": "Kimi A" }
                }
            }"#,
        )
        .unwrap();
        assert_eq!(models[0].id, "z-model");
        assert_eq!(models[0].display_name, "Kimi Z");
        assert!(models[0].is_default);
        assert_eq!(models[0].reasoning_efforts, ["low", "high"]);
        assert_eq!(models[0].default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(models[1].id, "a-model");
        assert!(!models[1].is_default);
    }
}
