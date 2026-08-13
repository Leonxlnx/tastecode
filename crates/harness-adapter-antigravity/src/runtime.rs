use crate::models::parse_antigravity_models;
use crate::session::{AntigravityCommand, AntigravitySession, AntigravitySessionState};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentRuntime, AgentSession, ControlHandlers,
    ProviderControl, StartOptions,
};
use harness_proc::{SpawnOptions, run_direct};
use harness_protocol::{
    Account, AuthStartLoginResult, McpCapabilities, McpListResult, Model, Thread,
};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const ANTIGRAVITY_SUPPORTED_VERSION: &str = "1.1";
const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const MODELS_MAX_OUTPUT: usize = 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct AntigravityLaunchOptions {
    /// Extra process environment for controlled launches and tests.
    pub environment: Vec<(OsString, OsString)>,
}

pub struct AntigravityRuntime {
    command: AntigravityCommand,
}

impl AntigravityRuntime {
    pub fn new(options: AntigravityLaunchOptions) -> Self {
        Self {
            command: AntigravityCommand {
                program: antigravity_command(),
                prefix_args: Vec::new(),
                environment: options.environment,
                append_turn_args: true,
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn with_command(command: AntigravityCommand) -> Self {
        Self { command }
    }
}

impl Default for AntigravityRuntime {
    fn default() -> Self {
        Self::new(AntigravityLaunchOptions::default())
    }
}

impl AgentRuntime for AntigravityRuntime {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let (thread, session) =
            AntigravitySession::start(workspace_path, options, self.command.clone(), handlers)?;
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
            .ok_or_else(|| AgentError::Failed("Antigravity session state is unavailable".into()))?;
        let state = serde_json::from_value::<AntigravitySessionState>(saved.value().clone())
            .map_err(|_| AgentError::Failed("Antigravity session state is invalid".into()))?;
        if state.thread.id != thread_id || state.thread.workspace_path != workspace_path {
            return Err(AgentError::Failed(
                "Antigravity session state does not match the stored thread".into(),
            ));
        }
        let (thread, session) = AntigravitySession::resume(state, self.command.clone(), handlers)?;
        Ok((thread, session))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        list_antigravity_models(&self.command)
    }

    fn open_control(&self, _handlers: ControlHandlers) -> AgentResult<Arc<dyn ProviderControl>> {
        Ok(Arc::new(AntigravityControl {
            command: self.command.clone(),
        }))
    }
}

struct AntigravityControl {
    command: AntigravityCommand,
}

impl ProviderControl for AntigravityControl {
    fn account(&self) -> AgentResult<Account> {
        Err(AgentError::Unsupported("Antigravity account status"))
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
        Err(AgentError::Unsupported("in-app sign-out"))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        list_antigravity_models(&self.command)
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

pub fn antigravity_command() -> OsString {
    antigravity_command_for(
        cfg!(windows),
        std::env::var_os("LOCALAPPDATA").as_deref().map(Path::new),
    )
}

fn antigravity_command_for(windows: bool, local_app_data: Option<&Path>) -> OsString {
    if !windows {
        return "agy".into();
    }
    let installed = local_app_data
        .map(|root| root.join("agy").join("bin").join("agy.exe"))
        .filter(|path| path.is_file());
    installed
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|| "agy.exe".into())
}

pub(crate) fn list_antigravity_models(command: &AntigravityCommand) -> AgentResult<Vec<Model>> {
    let mut args = command.prefix_args.clone();
    if command.append_turn_args {
        args.push("models".into());
    }
    let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
    let output = run_direct(
        command.program.as_os_str(),
        &arg_refs,
        &SpawnOptions {
            environment: command.environment.clone(),
            ..SpawnOptions::default()
        },
        MODELS_TIMEOUT,
        MODELS_MAX_OUTPUT,
    )
    .map_err(|_| AgentError::Failed("Antigravity model discovery failed".into()))?;
    if output.code != Some(0) {
        return Err(AgentError::Failed(
            "Antigravity model discovery failed".into(),
        ));
    }
    Ok(parse_antigravity_models(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    const HELPER_MODE: &str = "HARNESS_ANTIGRAVITY_MODELS_HELPER";

    #[test]
    fn resolves_the_fixed_windows_install_and_cross_platform_path_name() {
        assert_eq!(antigravity_command_for(false, None), OsStr::new("agy"));
        assert_eq!(antigravity_command_for(true, None), OsStr::new("agy.exe"));
        let local = tempfile::tempdir().unwrap();
        let binary = local.path().join("agy").join("bin").join("agy.exe");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, b"").unwrap();
        assert_eq!(antigravity_command_for(true, Some(local.path())), binary);
    }

    #[test]
    fn discovery_closes_stdin_and_collapses_models_over_a_real_process() {
        let executable = std::env::current_exe().unwrap();
        let runtime = AntigravityRuntime::with_command(AntigravityCommand {
            program: executable.into_os_string(),
            prefix_args: vec![
                "--exact".into(),
                "runtime::tests::antigravity_models_helper".into(),
                "--nocapture".into(),
                "--quiet".into(),
            ],
            environment: vec![(HELPER_MODE.into(), "1".into())],
            append_turn_args: false,
        });
        let models = runtime.list_models().unwrap();
        assert_eq!(models.len(), 6);
        assert_eq!(models[0].display_name, "Gemini 3.6 Flash");
        let control = runtime.open_control(ControlHandlers::default()).unwrap();
        assert_eq!(control.list_models().unwrap(), models);
    }

    #[test]
    fn antigravity_models_helper() {
        if std::env::var_os(HELPER_MODE).is_some() {
            print!("{}", include_str!("../fixtures/models-2026-08-07.txt"));
        }
    }
}
