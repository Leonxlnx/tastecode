use crate::session::{GrokCommand, GrokSession, GrokSessionState};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentRuntime, AgentSession, ControlHandlers,
    ProviderControl, StartOptions,
};
use harness_proc::{SpawnOptions, run_direct};
use harness_protocol::{
    Account, AuthStartLoginResult, McpCapabilities, McpListResult, Model, Thread,
};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub const GROK_SUPPORTED_VERSION: &str = "0.1";
pub const GROK_EFFORTS: &[&str] = &["low", "medium", "high"];
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);
const CAPTURE_MAX_OUTPUT: usize = 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct GrokLaunchOptions {
    /// Extra process environment for controlled launches and tests.
    pub environment: Vec<(OsString, OsString)>,
}

pub struct GrokRuntime {
    command: GrokCommand,
}

impl GrokRuntime {
    pub fn new(options: GrokLaunchOptions) -> Self {
        Self {
            command: GrokCommand {
                program: grok_command(),
                prefix_args: Vec::new(),
                environment: options.environment,
                append_turn_args: true,
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn with_command(command: GrokCommand) -> Self {
        Self { command }
    }
}

impl Default for GrokRuntime {
    fn default() -> Self {
        Self::new(GrokLaunchOptions::default())
    }
}

impl AgentRuntime for GrokRuntime {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let (thread, session) =
            GrokSession::start(workspace_path, options, self.command.clone(), handlers)?;
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
            .ok_or_else(|| AgentError::Failed("Grok session state is unavailable".into()))?;
        let state = serde_json::from_value::<GrokSessionState>(saved.value().clone())
            .map_err(|_| AgentError::Failed("Grok session state is invalid".into()))?;
        if state.thread.id != thread_id || state.thread.workspace_path != workspace_path {
            return Err(AgentError::Failed(
                "Grok session state does not match the stored thread".into(),
            ));
        }
        let (thread, session) = GrokSession::resume(state, self.command.clone(), handlers)?;
        Ok((thread, session))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        list_grok_models(&self.command)
    }

    fn open_control(&self, _handlers: ControlHandlers) -> AgentResult<Arc<dyn ProviderControl>> {
        Ok(Arc::new(GrokControl {
            command: self.command.clone(),
        }))
    }
}

struct GrokControl {
    command: GrokCommand,
}

impl ProviderControl for GrokControl {
    fn account(&self) -> AgentResult<Account> {
        let output = capture_grok(&self.command, &["models"])?;
        Ok(parse_grok_account(&output))
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
        capture_grok(&self.command, &["logout"]).map(|_| ())
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        list_grok_models(&self.command)
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

pub fn grok_command() -> OsString {
    let executable = if cfg!(windows) { "grok.exe" } else { "grok" };
    let installed = dirs::home_dir()
        .map(|home| home.join(".grok").join("bin").join(executable))
        .filter(|path| path.is_file());
    installed
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|| OsString::from("grok"))
}

pub fn parse_grok_models(output: &str) -> Vec<Model> {
    let mut models = Vec::new();
    let mut reading = false;
    for raw_line in output.split(['\r', '\n']) {
        let line = raw_line.trim();
        if line.eq_ignore_ascii_case("Available models:") {
            reading = true;
            continue;
        }
        if !reading || line.is_empty() {
            continue;
        }
        let Some(details) = line.strip_prefix('*').map(str::trim) else {
            continue;
        };
        let Some(id) = details
            .split_whitespace()
            .next()
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let known_efforts = (id == "grok-4.5")
            .then(|| GROK_EFFORTS.iter().map(|effort| (*effort).into()).collect());
        models.push(Model {
            id: id.into(),
            display_name: grok_display_name(id),
            description: None,
            is_default: details[id.len()..].trim_start().starts_with("(default)"),
            reasoning_efforts: known_efforts.unwrap_or_default(),
            default_reasoning_effort: (id == "grok-4.5").then(|| "high".into()),
            service_tiers: Vec::new(),
            default_service_tier: None,
        });
    }
    models
}

pub fn grok_display_name(id: &str) -> String {
    id.split('-')
        .filter(|token| !token.is_empty())
        .map(|token| {
            if token.eq_ignore_ascii_case("grok") {
                return "Grok".into();
            }
            let mut characters = token.chars();
            characters.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(characters).collect::<String>()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_grok_account(output: &str) -> Account {
    Account {
        signed_in: !output
            .to_ascii_lowercase()
            .contains("you are not authenticated"),
        email: None,
        plan: None,
    }
}

fn list_grok_models(command: &GrokCommand) -> AgentResult<Vec<Model>> {
    capture_grok(command, &["models"]).map(|output| parse_grok_models(&output))
}

fn capture_grok(command: &GrokCommand, args: &[&str]) -> AgentResult<String> {
    let mut all_args = command.prefix_args.clone();
    if command.append_turn_args {
        all_args.extend(args.iter().map(OsString::from));
    }
    let arg_refs = all_args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
    let output = run_direct(
        command.program.as_os_str(),
        &arg_refs,
        &SpawnOptions {
            environment: command.environment.clone(),
            ..SpawnOptions::default()
        },
        CAPTURE_TIMEOUT,
        CAPTURE_MAX_OUTPUT,
    )
    .map_err(|_| AgentError::Failed("Grok CLI did not answer".into()))?;
    if output.code != Some(0) {
        return Err(AgentError::Failed(format!(
            "Grok CLI exited with code {}",
            output
                .code
                .map_or_else(|| "unknown".into(), |code| code.to_string())
        )));
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    const HELPER_MODE: &str = "HARNESS_GROK_MODELS_HELPER";
    const MODELS_OUTPUT: &str = concat!(
        "You are not authenticated.\n\n",
        "Default model: grok-4.5\n\n",
        "Available models:\n",
        "  * grok-4.5 (default)\n"
    );

    #[test]
    fn parses_models_efforts_and_cli_reported_auth() {
        let models = parse_grok_models(MODELS_OUTPUT);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "grok-4.5");
        assert!(models[0].is_default);
        assert_eq!(models[0].display_name, "Grok 4.5");
        assert_eq!(models[0].reasoning_efforts, ["low", "medium", "high"]);
        assert_eq!(models[0].default_reasoning_effort.as_deref(), Some("high"));
        assert!(!parse_grok_account(MODELS_OUTPUT).signed_in);
        assert!(parse_grok_account("Default model: grok-4.5").signed_in);
    }

    #[test]
    fn unknown_models_do_not_inherit_grok_4_5_reasoning_levels() {
        let models = parse_grok_models("Available models:\n  * grok-future (default)");

        assert_eq!(models[0].display_name, "Grok Future");
        assert!(models[0].reasoning_efforts.is_empty());
        assert_eq!(models[0].default_reasoning_effort, None);
    }

    #[test]
    fn discovers_models_and_account_over_a_bounded_direct_process() {
        let executable = std::env::current_exe().unwrap();
        let runtime = GrokRuntime::with_command(GrokCommand {
            program: executable.into_os_string(),
            prefix_args: vec![
                "--exact".into(),
                "runtime::tests::grok_models_helper".into(),
                "--nocapture".into(),
            ],
            environment: vec![(HELPER_MODE.into(), "1".into())],
            append_turn_args: false,
        });
        assert_eq!(runtime.list_models().unwrap().len(), 1);
        let control = runtime.open_control(ControlHandlers::default()).unwrap();
        assert!(!control.account().unwrap().signed_in);
        control.sign_out().unwrap();
    }

    #[test]
    fn grok_models_helper() {
        if std::env::var_os(HELPER_MODE).is_some() {
            print!("{MODELS_OUTPUT}");
        }
    }

    #[test]
    fn default_runtime_uses_the_resolved_real_executable() {
        assert_eq!(GrokRuntime::default().command.program, grok_command());
        assert_ne!(grok_command(), OsStr::new("cmd.exe"));
    }
}
