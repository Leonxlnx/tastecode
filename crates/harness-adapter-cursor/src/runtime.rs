use crate::CursorControl;
use crate::parse_cursor_models;
use crate::session::{CursorCommand, CursorSession, CursorSessionState};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentRuntime, AgentSession, ControlHandlers,
    ProviderControl, StartOptions,
};
use harness_proc::{SpawnOptions, run_cli};
use harness_protocol::{Model, Thread};
use std::ffi::OsString;
use std::sync::Arc;
use std::time::Duration;

pub const CURSOR_SUPPORTED_VERSION: &str = "2026.07";
const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const MODELS_MAX_OUTPUT: usize = 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct CursorLaunchOptions {
    /// Extra process environment for controlled launches and tests.
    pub environment: Vec<(OsString, OsString)>,
}

pub struct CursorRuntime {
    command: CursorCommand,
}

impl CursorRuntime {
    pub fn new(options: CursorLaunchOptions) -> Self {
        Self {
            command: CursorCommand {
                program: OsString::from("cursor-agent"),
                prefix_args: Vec::new(),
                environment: options.environment,
                append_provider_args: true,
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn with_command(command: CursorCommand) -> Self {
        Self { command }
    }
}

impl Default for CursorRuntime {
    fn default() -> Self {
        Self::new(CursorLaunchOptions::default())
    }
}

impl AgentRuntime for CursorRuntime {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let (thread, session) =
            CursorSession::start(workspace_path, options, self.command.clone(), handlers)?;
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
            .ok_or_else(|| AgentError::Failed("Cursor session state is unavailable".into()))?;
        let state = serde_json::from_value::<CursorSessionState>(saved.value().clone())
            .map_err(|_| AgentError::Failed("Cursor session state is invalid".into()))?;
        if state.thread.id != thread_id || state.thread.workspace_path != workspace_path {
            return Err(AgentError::Failed(
                "Cursor session state does not match the stored thread".into(),
            ));
        }
        let (thread, session) = CursorSession::resume(state, self.command.clone(), handlers)?;
        Ok((thread, session))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        list_cursor_models(&self.command)
    }

    fn open_control(&self, handlers: ControlHandlers) -> AgentResult<Arc<dyn ProviderControl>> {
        Ok(Arc::new(CursorControl::new(self.command.clone(), handlers)))
    }
}

pub(crate) fn list_cursor_models(command: &CursorCommand) -> AgentResult<Vec<Model>> {
    let args = command_args(command, &["models"]);
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
    .map_err(|_| AgentError::Failed("Cursor model discovery failed".into()))?;
    if output.code != Some(0) {
        return Err(AgentError::Failed("Cursor model discovery failed".into()));
    }
    Ok(parse_cursor_models(&output.stdout))
}

pub(crate) fn command_args(command: &CursorCommand, provider_args: &[&str]) -> Vec<OsString> {
    let mut args = command.prefix_args.clone();
    if command.append_provider_args {
        args.extend(provider_args.iter().map(OsString::from));
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    const HELPER_MODE: &str = "HARNESS_CURSOR_MODELS_HELPER";

    #[test]
    fn default_runtime_invokes_the_vendor_cli_directly() {
        let runtime = CursorRuntime::default();
        assert_eq!(runtime.command.program, OsStr::new("cursor-agent"));
        assert!(runtime.command.prefix_args.is_empty());
        assert!(runtime.command.append_provider_args);
    }

    #[test]
    fn discovers_models_over_a_bounded_real_process() {
        let executable = std::env::current_exe().unwrap();
        let runtime = CursorRuntime::with_command(CursorCommand {
            program: executable.into_os_string(),
            prefix_args: vec![
                OsString::from("--exact"),
                OsString::from("runtime::tests::cursor_models_helper"),
                OsString::from("--nocapture"),
            ],
            environment: vec![(OsString::from(HELPER_MODE), OsString::from("1"))],
            append_provider_args: false,
        });
        let models = runtime.list_models().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "composer-2.5");
        assert!(models[0].is_default);
    }

    #[test]
    fn cursor_models_helper() {
        if std::env::var_os(HELPER_MODE).is_none() {
            return;
        }
        println!("Available models");
        println!("composer-2.5 - Composer 2.5 Fast (current, default)");
        println!("Tip: done");
    }
}
