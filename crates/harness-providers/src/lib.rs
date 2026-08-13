use harness_protocol::{
    AcpAgent, Capabilities, ProviderAuth, ProviderId, ProviderLogin, ProviderSetup, ProviderStatus,
};
use std::ffi::OsStr;
use std::thread;
use std::time::Duration;
use thiserror::Error;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
pub const CURSOR_SUPPORTED_VERSION: &str = "2026.07";

pub const CODEX_CAPABILITIES: Capabilities = Capabilities {
    steer: true,
    fork: true,
    interrupt: true,
    reasoning_items: true,
    approvals: true,
    user_input: Some(true),
    auto_review: Some(true),
    images: true,
};

pub const CLAUDE_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: true,
    approvals: false,
    user_input: None,
    auto_review: None,
    images: false,
};

pub const GROK_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: true,
    approvals: false,
    user_input: None,
    auto_review: None,
    images: false,
};

pub const CURSOR_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: false,
    approvals: false,
    user_input: None,
    auto_review: None,
    images: false,
};

pub const OPENCODE_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: true,
    approvals: true,
    user_input: None,
    auto_review: None,
    images: false,
};

pub const ANTIGRAVITY_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: false,
    approvals: false,
    user_input: None,
    auto_review: None,
    images: false,
};

struct ProviderDefinition {
    id: ProviderId,
    display_name: &'static str,
    command: &'static str,
    capabilities: &'static Capabilities,
    install_url: &'static str,
    install_command: Option<&'static str>,
    login: ProviderLogin,
    login_command: Option<&'static str>,
    supported_version: Option<&'static str>,
}

const PROVIDERS: &[ProviderDefinition] = &[
    ProviderDefinition {
        id: ProviderId::Codex,
        display_name: "Codex",
        command: "codex",
        capabilities: &CODEX_CAPABILITIES,
        install_url: "https://help.openai.com/en/articles/11096431",
        install_command: Some("npm install -g @openai/codex"),
        login: ProviderLogin::App,
        login_command: None,
        supported_version: None,
    },
    ProviderDefinition {
        id: ProviderId::ClaudeCode,
        display_name: "Claude Code",
        command: "claude",
        capabilities: &CLAUDE_CAPABILITIES,
        install_url: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
        install_command: Some("npm install -g @anthropic-ai/claude-code"),
        login: ProviderLogin::App,
        login_command: None,
        supported_version: None,
    },
    ProviderDefinition {
        id: ProviderId::Grok,
        display_name: "Grok",
        command: "grok",
        capabilities: &GROK_CAPABILITIES,
        install_url: "https://x.ai/",
        install_command: None,
        login: ProviderLogin::Provider,
        login_command: Some("grok login"),
        supported_version: None,
    },
    ProviderDefinition {
        id: ProviderId::Cursor,
        display_name: "Cursor",
        command: "cursor-agent",
        capabilities: &CURSOR_CAPABILITIES,
        install_url: "https://docs.cursor.com/en/cli/installation",
        install_command: None,
        login: ProviderLogin::App,
        login_command: None,
        supported_version: Some(CURSOR_SUPPORTED_VERSION),
    },
    ProviderDefinition {
        id: ProviderId::OpenCode,
        display_name: "OpenCode",
        command: "opencode",
        capabilities: &OPENCODE_CAPABILITIES,
        install_url: "https://opencode.ai/en/docs",
        install_command: Some("npm install -g opencode-ai"),
        login: ProviderLogin::Provider,
        login_command: Some("opencode auth login"),
        supported_version: None,
    },
    ProviderDefinition {
        id: ProviderId::Antigravity,
        display_name: "Antigravity",
        command: "agy",
        capabilities: &ANTIGRAVITY_CAPABILITIES,
        install_url: "https://antigravity.google/docs/cli",
        install_command: None,
        login: ProviderLogin::Provider,
        login_command: Some("agy"),
        supported_version: None,
    },
];

/// Public-beta discovery exposes the same three subscription plans as the
/// TypeScript server. The remaining definitions stay available to existing
/// sessions and return to discovery after the beta.
const BETA_PROVIDERS: &[ProviderId] =
    &[ProviderId::Codex, ProviderId::ClaudeCode, ProviderId::Grok];

struct AcpDefinition {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    verified: bool,
    install: Option<&'static str>,
    install_url: &'static str,
    install_command: Option<&'static str>,
    login: ProviderLogin,
    problem: Option<&'static str>,
    retired: bool,
}

const ACP_AGENTS: &[AcpDefinition] = &[
    AcpDefinition {
        id: "gemini",
        name: "Gemini CLI",
        command: "gemini",
        verified: true,
        install: Some("npm i -g @google/gemini-cli"),
        install_url: "https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md",
        install_command: Some("npm install -g @google/gemini-cli"),
        login: ProviderLogin::Provider,
        problem: Some(
            "Google ended individual sign-in (June 2026) — use an organization account or set GEMINI_API_KEY.",
        ),
        retired: true,
    },
    AcpDefinition {
        id: "kimi",
        name: "Kimi CLI",
        command: "kimi",
        verified: true,
        install: Some("npm install -g @moonshot-ai/kimi-code"),
        install_url: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
        install_command: Some("npm install -g @moonshot-ai/kimi-code"),
        login: ProviderLogin::Provider,
        problem: None,
        retired: false,
    },
    AcpDefinition {
        id: "qwen",
        name: "Qwen Code",
        command: "qwen",
        verified: false,
        install: Some("npm i -g @qwen-code/qwen-code"),
        install_url: "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
        install_command: Some("npm install -g @qwen-code/qwen-code@latest"),
        login: ProviderLogin::Provider,
        problem: None,
        retired: true,
    },
];

pub trait SystemProbe: Sync {
    fn is_installed(&self, command: &str) -> bool;
    fn version(&self, command: &str) -> Option<String>;
}

pub struct RealSystem;

impl SystemProbe for RealSystem {
    fn is_installed(&self, command: &str) -> bool {
        harness_proc::is_installed(OsStr::new(command), PROBE_TIMEOUT)
    }

    fn version(&self, command: &str) -> Option<String> {
        harness_proc::command_version(OsStr::new(command), PROBE_TIMEOUT)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderCommand {
    pub key: String,
    pub command: &'static str,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProviderCatalogError {
    #[error("unknown install target: {0}")]
    UnknownInstallTarget(String),
    #[error("{0} has no scripted install; use its setup page")]
    NoScriptedInstall(&'static str),
    #[error("unknown launch target: {0}")]
    UnknownLaunchTarget(String),
    #[error("{0} signs in through the app, not its own CLI")]
    AppManagedLogin(&'static str),
}

pub fn detect_providers() -> Vec<ProviderStatus> {
    detect_providers_with(&RealSystem)
}

pub fn detect_providers_with(system: &dyn SystemProbe) -> Vec<ProviderStatus> {
    thread::scope(|scope| {
        PROVIDERS
            .iter()
            .filter(|definition| BETA_PROVIDERS.contains(&definition.id))
            .map(|definition| scope.spawn(move || probe_provider(definition, system)))
            .collect::<Vec<_>>()
            .into_iter()
            .map(|probe| probe.join().expect("provider probe panicked"))
            .collect()
    })
}

pub fn detect_agents() -> Vec<AcpAgent> {
    detect_agents_with(&RealSystem)
}

pub fn detect_agents_with(system: &dyn SystemProbe) -> Vec<AcpAgent> {
    thread::scope(|scope| {
        ACP_AGENTS
            .iter()
            .filter(|definition| !definition.retired)
            .map(|definition| {
                scope.spawn(move || AcpAgent {
                    id: definition.id.into(),
                    name: definition.name.into(),
                    installed: system.is_installed(definition.command),
                    verified: definition.verified,
                    install: definition.install.map(str::to_owned),
                    setup: acp_setup(definition),
                    problem: definition.problem.map(str::to_owned),
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|probe| probe.join().expect("ACP agent probe panicked"))
            .collect()
    })
}

pub fn install_command_for(
    provider: ProviderId,
    agent: Option<&str>,
) -> Result<ProviderCommand, ProviderCatalogError> {
    if provider == ProviderId::Acp {
        let target = agent.and_then(find_acp).ok_or_else(|| {
            ProviderCatalogError::UnknownInstallTarget(agent.unwrap_or("acp").into())
        })?;
        return Ok(ProviderCommand {
            key: format!("acp:{}", target.id),
            command: target
                .install_command
                .ok_or(ProviderCatalogError::NoScriptedInstall(target.name))?,
        });
    }
    let target = find_provider(provider).ok_or_else(|| {
        ProviderCatalogError::UnknownInstallTarget(provider_name(provider).into())
    })?;
    Ok(ProviderCommand {
        key: provider_name(provider).into(),
        command: target
            .install_command
            .ok_or(ProviderCatalogError::NoScriptedInstall(target.display_name))?,
    })
}

pub fn launch_command_for(
    provider: ProviderId,
    agent: Option<&str>,
) -> Result<ProviderCommand, ProviderCatalogError> {
    if provider == ProviderId::Acp {
        let target = agent.and_then(find_acp).ok_or_else(|| {
            ProviderCatalogError::UnknownLaunchTarget(agent.unwrap_or("acp").into())
        })?;
        if target.login != ProviderLogin::Provider {
            return Err(ProviderCatalogError::AppManagedLogin(target.name));
        }
        return Ok(ProviderCommand {
            key: format!("acp:{}", target.id),
            command: target.command,
        });
    }
    let target = find_provider(provider)
        .ok_or_else(|| ProviderCatalogError::UnknownLaunchTarget(provider_name(provider).into()))?;
    if target.login != ProviderLogin::Provider {
        return Err(ProviderCatalogError::AppManagedLogin(target.display_name));
    }
    Ok(ProviderCommand {
        key: provider_name(provider).into(),
        command: target
            .login_command
            .ok_or(ProviderCatalogError::AppManagedLogin(target.display_name))?,
    })
}

fn probe_provider(definition: &ProviderDefinition, system: &dyn SystemProbe) -> ProviderStatus {
    let installed = system.is_installed(definition.command);
    let version = installed
        .then(|| system.version(definition.command))
        .flatten();
    let problem = if !installed {
        Some(format!("{} is not on PATH", definition.command))
    } else if let (Some(version), Some(supported)) = (&version, definition.supported_version)
        && !version.contains(supported)
    {
        Some(format!(
            "Adapter supports {supported}.x; installed version is {version}"
        ))
    } else {
        None
    };
    ProviderStatus {
        id: definition.id,
        display_name: definition.display_name.into(),
        installed,
        version,
        auth: ProviderAuth::Unknown,
        capabilities: installed.then(|| definition.capabilities.clone()),
        setup: Some(provider_setup(definition)),
        problem,
    }
}

fn provider_setup(definition: &ProviderDefinition) -> ProviderSetup {
    ProviderSetup {
        install_url: definition.install_url.into(),
        install_command: definition.install_command.map(str::to_owned),
        login: definition.login,
    }
}

fn acp_setup(definition: &AcpDefinition) -> ProviderSetup {
    ProviderSetup {
        install_url: definition.install_url.into(),
        install_command: definition.install_command.map(str::to_owned),
        login: definition.login,
    }
}

fn find_provider(id: ProviderId) -> Option<&'static ProviderDefinition> {
    PROVIDERS.iter().find(|definition| definition.id == id)
}

fn find_acp(id: &str) -> Option<&'static AcpDefinition> {
    ACP_AGENTS.iter().find(|definition| definition.id == id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[derive(Default)]
    struct FakeSystem {
        installed: HashSet<String>,
        versions: HashMap<String, String>,
    }

    impl SystemProbe for FakeSystem {
        fn is_installed(&self, command: &str) -> bool {
            self.installed.contains(command)
        }

        fn version(&self, command: &str) -> Option<String> {
            self.versions.get(command).cloned()
        }
    }

    #[test]
    fn reports_the_public_beta_roster_without_claiming_credential_knowledge() {
        let providers = detect_providers_with(&FakeSystem::default());
        assert_eq!(
            providers
                .iter()
                .map(|provider| provider.id)
                .collect::<Vec<_>>(),
            [ProviderId::Codex, ProviderId::ClaudeCode, ProviderId::Grok,]
        );
        assert!(
            providers
                .iter()
                .all(|provider| provider.auth == ProviderAuth::Unknown)
        );
        assert!(providers.iter().all(|provider| !provider.installed));
        assert!(providers.iter().all(|provider| provider.problem.is_some()));
    }

    #[test]
    fn installed_providers_expose_capabilities_and_version_compatibility() {
        let system = FakeSystem {
            installed: ["codex", "cursor-agent"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            versions: [
                ("codex".into(), "codex-cli 1.4.0".into()),
                ("cursor-agent".into(), "2025.12.1".into()),
            ]
            .into_iter()
            .collect(),
        };
        let providers = detect_providers_with(&system);
        let codex = providers
            .iter()
            .find(|provider| provider.id == ProviderId::Codex)
            .unwrap();
        assert_eq!(codex.version.as_deref(), Some("codex-cli 1.4.0"));
        assert_eq!(codex.capabilities, Some(CODEX_CAPABILITIES));
        assert!(codex.problem.is_none());
        let cursor = probe_provider(
            find_provider(ProviderId::Cursor).expect("parked Cursor definition"),
            &system,
        );
        assert!(
            cursor
                .problem
                .as_deref()
                .is_some_and(|problem| problem.contains("supports 2026.07")),
            "{cursor:?}"
        );
    }

    #[test]
    fn acp_discovery_stays_available_while_the_roster_is_parked() {
        let system = FakeSystem {
            installed: ["gemini", "kimi"].into_iter().map(str::to_owned).collect(),
            ..FakeSystem::default()
        };
        let providers = detect_providers_with(&system);
        assert!(
            providers
                .iter()
                .all(|provider| provider.id != ProviderId::Acp)
        );
        let agents = detect_agents_with(&system);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "kimi");
        assert!(agents[0].verified);
        assert!(agents[0].problem.is_none());
    }

    #[test]
    fn resolves_only_server_owned_install_and_login_commands() {
        assert_eq!(
            install_command_for(ProviderId::OpenCode, None).unwrap(),
            ProviderCommand {
                key: "opencode".into(),
                command: "npm install -g opencode-ai",
            }
        );
        assert_eq!(
            install_command_for(ProviderId::Acp, Some("gemini"))
                .unwrap()
                .command,
            "npm install -g @google/gemini-cli"
        );
        assert!(matches!(
            install_command_for(ProviderId::Cursor, None),
            Err(ProviderCatalogError::NoScriptedInstall("Cursor"))
        ));
        assert_eq!(
            launch_command_for(ProviderId::OpenCode, None)
                .unwrap()
                .command,
            "opencode auth login"
        );
        assert_eq!(
            launch_command_for(ProviderId::Grok, None).unwrap().command,
            "grok login"
        );
        assert_eq!(
            launch_command_for(ProviderId::Antigravity, None)
                .unwrap()
                .command,
            "agy"
        );
        assert_eq!(
            launch_command_for(ProviderId::Acp, Some("kimi"))
                .unwrap()
                .command,
            "kimi"
        );
        assert!(matches!(
            launch_command_for(ProviderId::Codex, None),
            Err(ProviderCatalogError::AppManagedLogin("Codex"))
        ));
        assert!(matches!(
            launch_command_for(ProviderId::Acp, Some("missing")),
            Err(ProviderCatalogError::UnknownLaunchTarget(_))
        ));
    }
}
