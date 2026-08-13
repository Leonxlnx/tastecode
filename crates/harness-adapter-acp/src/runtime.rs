use crate::agents::{
    AcpAgentSpec, acp_account, acp_sign_out, find_agent_spec, gemini_models, parse_kimi_models,
};
use crate::session::{AcpCommand, AcpSession, AcpSessionState};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentRuntime, AgentSession, ControlHandlers,
    ProviderControl, StartOptions,
};
use harness_proc::{SpawnOptions, run_cli};
use harness_protocol::{
    Account, AuthStartLoginResult, McpCapabilities, McpListResult, Model, Thread,
};
use std::ffi::OsString;
use std::sync::Arc;
use std::time::Duration;

const MODELS_TIMEOUT: Duration = Duration::from_secs(5);
const MODELS_MAX_OUTPUT: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct AcpLaunchOptions {
    /// Extra process environment for controlled launches and tests.
    pub environment: Vec<(OsString, OsString)>,
}

pub struct AcpRuntime {
    spec: &'static AcpAgentSpec,
    command: AcpCommand,
}

impl AcpRuntime {
    pub fn new(agent_id: &str, options: AcpLaunchOptions) -> AgentResult<Self> {
        let spec = find_agent_spec(agent_id)
            .ok_or_else(|| AgentError::Failed(format!("unknown ACP agent \"{agent_id}\"")))?;
        Ok(Self {
            spec,
            command: AcpCommand {
                program: OsString::from(spec.command),
                prefix_args: Vec::new(),
                environment: options.environment,
                append_agent_args: true,
            },
        })
    }

    #[cfg(test)]
    pub(crate) fn with_command(agent_id: &str, command: AcpCommand) -> Self {
        Self {
            spec: find_agent_spec(agent_id).expect("test ACP agent must exist"),
            command,
        }
    }
}

impl AgentRuntime for AcpRuntime {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let (thread, session) = AcpSession::start(
            self.spec,
            self.command.clone(),
            workspace_path,
            options,
            handlers,
        )?;
        Ok((thread, session))
    }

    fn resume(
        &self,
        thread_id: &str,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let saved = options
            .resume_state
            .as_ref()
            .ok_or_else(|| AgentError::Failed("ACP session state is unavailable".into()))?;
        let state = serde_json::from_value::<AcpSessionState>(saved.value().clone())
            .map_err(|_| AgentError::Failed("ACP session state is invalid".into()))?;
        if state.thread.id != thread_id || state.thread.workspace_path != workspace_path {
            return Err(AgentError::Failed(
                "ACP session state does not match the stored thread".into(),
            ));
        }
        if state.agent_id != self.spec.id {
            return Err(AgentError::Failed(
                "ACP session state belongs to a different agent".into(),
            ));
        }
        let (thread, session) =
            AcpSession::resume(self.spec, self.command.clone(), state, options, handlers)?;
        Ok((thread, session))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        discover_models(self.spec, &self.command)
    }

    fn open_control(&self, _handlers: ControlHandlers) -> AgentResult<Arc<dyn ProviderControl>> {
        Ok(Arc::new(AcpControl {
            spec: self.spec,
            command: self.command.clone(),
        }))
    }
}

struct AcpControl {
    spec: &'static AcpAgentSpec,
    command: AcpCommand,
}

impl ProviderControl for AcpControl {
    fn account(&self) -> AgentResult<Account> {
        let home = dirs::home_dir()
            .ok_or_else(|| AgentError::Failed("home directory is unavailable".into()))?;
        Ok(acp_account(self.spec.id, &home))
    }

    fn start_login(&self) -> AgentResult<AuthStartLoginResult> {
        Err(AgentError::Unsupported("in-app sign-in"))
    }

    fn cancel_login(&self, _login_id: &str) -> AgentResult<()> {
        Err(AgentError::Unsupported("in-app sign-in"))
    }

    fn use_api_key(&self, _api_key: &str) -> AgentResult<Account> {
        Err(AgentError::Unsupported("API key sign-in"))
    }

    fn sign_out(&self) -> AgentResult<()> {
        let home = dirs::home_dir()
            .ok_or_else(|| AgentError::Failed("home directory is unavailable".into()))?;
        acp_sign_out(self.spec.id, &home)
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        discover_models(self.spec, &self.command)
    }

    fn list_mcp_servers(&self) -> AgentResult<McpListResult> {
        Ok(McpListResult {
            capabilities: McpCapabilities {
                inventory: false,
                add: false,
                update: false,
                remove: false,
                reload: false,
                start_o_auth: false,
                cancel_o_auth: false,
            },
            servers: Vec::new(),
        })
    }

    fn dispose(&self) {}
}

fn discover_models(spec: &AcpAgentSpec, command: &AcpCommand) -> AgentResult<Vec<Model>> {
    match spec.id {
        "gemini" => Ok(gemini_models()),
        "kimi" => {
            let mut args = command.prefix_args.clone();
            if command.append_agent_args {
                args.extend(
                    ["provider", "list", "--json"]
                        .into_iter()
                        .map(OsString::from),
                );
            }
            let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
            let output = run_cli(
                command.program.as_os_str(),
                &arg_refs,
                &SpawnOptions {
                    environment: command.environment.clone(),
                    ..SpawnOptions::default()
                },
                MODELS_TIMEOUT,
                MODELS_MAX_OUTPUT,
            )
            .map_err(|_| AgentError::Failed("Kimi model discovery failed".into()))?;
            if output.code != Some(0) {
                return Err(AgentError::Failed("Kimi model discovery failed".into()));
            }
            parse_kimi_models(&output.stdout)
        }
        _ => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn validates_agents_and_uses_their_owned_commands() {
        assert!(AcpRuntime::new("missing", AcpLaunchOptions::default()).is_err());
        let gemini = AcpRuntime::new("gemini", AcpLaunchOptions::default()).unwrap();
        assert_eq!(gemini.command.program, OsStr::new("gemini"));
        assert!(gemini.command.prefix_args.is_empty());
        assert!(gemini.command.append_agent_args);
        assert_eq!(gemini.list_models().unwrap().len(), 5);
        let control = gemini.open_control(ControlHandlers::default()).unwrap();
        assert!(!control.account().unwrap().signed_in);
        let mcp = control.list_mcp_servers().unwrap();
        assert!(!mcp.capabilities.inventory);
        assert!(!mcp.capabilities.add);
    }
}
