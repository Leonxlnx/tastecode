use crate::runtime::claude_models_for_command;
use crate::session::ClaudeCommand;
use harness_agent::{AgentError, AgentResult, ControlHandlers, LoginEvent, ProviderControl};
use harness_proc::{SpawnOptions, SpawnedChild, run_cli, spawn_cli};
use harness_protocol::{Account, AuthStartLoginResult, Model};
use serde_json::Value;
use std::ffi::OsString;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const AUTH_MAX_OUTPUT: usize = 1024 * 1024;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub struct ClaudeControl {
    inner: Arc<ControlInner>,
}

struct ControlInner {
    command: ClaudeCommand,
    handlers: ControlHandlers,
    active_login: Mutex<Option<ActiveLogin>>,
    disposed: AtomicBool,
}

#[derive(Clone)]
struct ActiveLogin {
    id: String,
    child: Arc<Mutex<SpawnedChild>>,
    cancelled: Arc<AtomicBool>,
}

impl ClaudeControl {
    pub(crate) fn new(command: ClaudeCommand, handlers: ControlHandlers) -> Self {
        Self {
            inner: Arc::new(ControlInner {
                command,
                handlers,
                active_login: Mutex::new(None),
                disposed: AtomicBool::new(false),
            }),
        }
    }

    fn account_inner(&self) -> AgentResult<Account> {
        let output = run_command(&self.inner.command, &["auth", "status"])?;
        if output.code != Some(0) {
            return Ok(signed_out());
        }
        parse_claude_account(&output.stdout)
    }

    fn start_login_inner(&self) -> AgentResult<AuthStartLoginResult> {
        if self.inner.disposed.load(Ordering::Acquire) {
            return Err(AgentError::Failed("Claude Code control is closed".into()));
        }
        self.cancel_active_login();
        let args = command_args(&self.inner.command, &["auth", "login"]);
        let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
        let mut child = spawn_cli(
            self.inner.command.program.as_os_str(),
            &arg_refs,
            &spawn_options(&self.inner.command),
        )
        .map_err(|_| AgentError::Failed("Claude Code could not start its sign-in flow".into()))?;
        drop(child.take_stdin());
        let stdout = child
            .take_stdout()
            .ok_or_else(|| AgentError::Failed("Claude Code login stdout is unavailable".into()))?;
        let stderr = child
            .take_stderr()
            .ok_or_else(|| AgentError::Failed("Claude Code login stderr is unavailable".into()))?;
        let login_id = Uuid::new_v4().to_string();
        let child = Arc::new(Mutex::new(child));
        let cancelled = Arc::new(AtomicBool::new(false));
        *lock(&self.inner.active_login) = Some(ActiveLogin {
            id: login_id.clone(),
            child: Arc::clone(&child),
            cancelled: Arc::clone(&cancelled),
        });

        let inner = Arc::clone(&self.inner);
        let worker_login_id = login_id.clone();
        let worker = thread::Builder::new()
            .name("harness-claude-login".into())
            .spawn(move || {
                let stdout_reader = thread::spawn(move || {
                    let mut stdout = stdout;
                    io::copy(&mut stdout, &mut io::sink())
                });
                let stderr_reader = thread::spawn(move || {
                    let mut stderr = stderr;
                    io::copy(&mut stderr, &mut io::sink())
                });
                let status = loop {
                    match lock(&child).try_wait() {
                        Ok(Some(status)) => break Some(status),
                        Ok(None) => thread::sleep(PROCESS_POLL_INTERVAL),
                        Err(_) => break None,
                    }
                };
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                let current = {
                    let mut active = lock(&inner.active_login);
                    if active.as_ref().map(|login| login.id.as_str())
                        == Some(worker_login_id.as_str())
                    {
                        active.take();
                        true
                    } else {
                        false
                    }
                };
                if !current || cancelled.load(Ordering::Acquire) {
                    return;
                }
                let success = status.is_some_and(|status| status.success());
                inner.handlers.emit_login(LoginEvent {
                    login_id: Some(worker_login_id),
                    success,
                    error: (!success).then(|| "Claude Code sign-in failed".into()),
                });
            });
        if worker.is_err() {
            self.cancel_active_login();
            return Err(AgentError::Failed(
                "could not start the Claude Code login worker".into(),
            ));
        }
        Ok(AuthStartLoginResult {
            login_id,
            auth_url: None,
        })
    }

    fn cancel_login_inner(&self, login_id: &str) -> AgentResult<()> {
        let login = {
            let mut active = lock(&self.inner.active_login);
            if active.as_ref().map(|login| login.id.as_str()) == Some(login_id) {
                active.take()
            } else {
                None
            }
        };
        if let Some(login) = login {
            login.cancelled.store(true, Ordering::Release);
            lock(&login.child)
                .kill_tree()
                .map_err(|_| AgentError::Failed("could not cancel Claude Code sign-in".into()))?;
        }
        Ok(())
    }

    fn sign_out_inner(&self) -> AgentResult<()> {
        self.cancel_active_login();
        let output = run_command(&self.inner.command, &["auth", "logout"])?;
        if output.code != Some(0) {
            return Err(AgentError::Failed("Claude Code could not sign out".into()));
        }
        Ok(())
    }

    fn cancel_active_login(&self) {
        let login = lock(&self.inner.active_login).take();
        if let Some(login) = login {
            login.cancelled.store(true, Ordering::Release);
            let _ = lock(&login.child).kill_tree();
        }
    }

    fn dispose_inner(&self) {
        if self.inner.disposed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.cancel_active_login();
    }
}

impl ProviderControl for ClaudeControl {
    fn account(&self) -> AgentResult<Account> {
        self.account_inner()
    }

    fn start_login(&self) -> AgentResult<AuthStartLoginResult> {
        self.start_login_inner()
    }

    fn cancel_login(&self, login_id: &str) -> AgentResult<()> {
        self.cancel_login_inner(login_id)
    }

    fn use_api_key(&self, _api_key: &str) -> AgentResult<Account> {
        Err(AgentError::Unsupported("API key sign-in"))
    }

    fn sign_out(&self) -> AgentResult<()> {
        self.sign_out_inner()
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        Ok(claude_models_for_command(&self.inner.command))
    }

    fn dispose(&self) {
        self.dispose_inner();
    }
}

impl Drop for ClaudeControl {
    fn drop(&mut self) {
        self.dispose_inner();
    }
}

pub fn parse_claude_account(output: &str) -> AgentResult<Account> {
    let value = output
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value.get("loggedIn").is_some())
        .ok_or_else(|| AgentError::Failed("Claude Code returned invalid auth status".into()))?;
    Ok(Account {
        signed_in: value
            .get("loggedIn")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        email: value
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_owned),
        plan: value
            .get("subscriptionType")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn signed_out() -> Account {
    Account {
        signed_in: false,
        email: None,
        plan: None,
    }
}

pub(crate) fn run_command(
    command: &ClaudeCommand,
    provider_args: &[&str],
) -> AgentResult<harness_proc::CliOutput> {
    let args = command_args(command, provider_args);
    let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
    run_cli(
        command.program.as_os_str(),
        &arg_refs,
        &spawn_options(command),
        AUTH_TIMEOUT,
        AUTH_MAX_OUTPUT,
    )
    .map_err(|_| AgentError::Failed("Claude Code authentication command failed".into()))
}

fn command_args(command: &ClaudeCommand, provider_args: &[&str]) -> Vec<OsString> {
    let mut args = command.prefix_args.clone();
    if command.append_turn_args {
        args.extend(provider_args.iter().map(OsString::from));
    }
    args
}

fn spawn_options(command: &ClaudeCommand) -> SpawnOptions {
    SpawnOptions {
        environment: command.environment.clone(),
        ..SpawnOptions::default()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::mpsc;

    const HELPER_MODE: &str = "HARNESS_CLAUDE_CONTROL_HELPER";
    const HELPER_ACTION: &str = "HARNESS_CLAUDE_CONTROL_ACTION";
    const WAIT: Duration = Duration::from_secs(2);

    #[test]
    fn maps_only_shared_account_fields() {
        assert_eq!(
            parse_claude_account(
                r#"{"loggedIn":true,"authMethod":"claude.ai","email":"dev@example.test","subscriptionType":"pro","orgId":"private"}"#,
            )
            .unwrap(),
            Account {
                signed_in: true,
                email: Some("dev@example.test".into()),
                plan: Some("pro".into()),
            }
        );
        assert!(parse_claude_account("not json").is_err());
    }

    #[test]
    fn drives_status_and_logout_over_bounded_cli_calls() {
        let status = ClaudeControl::new(test_command("status"), ControlHandlers::default());
        assert_eq!(
            status.account().unwrap(),
            Account {
                signed_in: true,
                email: Some("developer@example.test".into()),
                plan: Some("pro".into()),
            }
        );
        status.dispose();

        let logout = ClaudeControl::new(test_command("logout"), ControlHandlers::default());
        logout.sign_out().unwrap();
        logout.dispose();
    }

    #[test]
    fn model_list_uses_efforts_published_by_the_installed_cli() {
        let control = ClaudeControl::new(test_command("models"), ControlHandlers::default());
        let models = control.list_models().unwrap();
        assert_eq!(
            models[0].reasoning_efforts,
            ["low", "medium", "high", "max"]
        );
        assert_eq!(models[5].default_reasoning_effort.as_deref(), Some("high"));
        control.dispose();
    }

    #[test]
    fn login_completion_is_correlated_and_cancellation_is_quiet() {
        let (login_tx, login_rx) = mpsc::channel();
        let control = ClaudeControl::new(
            test_command("login"),
            ControlHandlers::new(
                move |event| {
                    let _ = login_tx.send(event);
                },
                |_| {},
            ),
        );
        let started = control.start_login().unwrap();
        assert_eq!(
            login_rx.recv_timeout(WAIT).unwrap(),
            LoginEvent {
                login_id: Some(started.login_id),
                success: true,
                error: None,
            }
        );
        control.dispose();

        let (cancel_tx, cancel_rx) = mpsc::channel();
        let cancelled = ClaudeControl::new(
            test_command("block"),
            ControlHandlers::new(
                move |event| {
                    let _ = cancel_tx.send(event);
                },
                |_| {},
            ),
        );
        let started = cancelled.start_login().unwrap();
        cancelled.cancel_login(&started.login_id).unwrap();
        assert!(cancel_rx.recv_timeout(Duration::from_millis(200)).is_err());
        cancelled.dispose();
    }

    #[test]
    fn claude_control_helper() {
        if std::env::var_os(HELPER_MODE).is_none() {
            return;
        }
        match std::env::var(HELPER_ACTION).unwrap().as_str() {
            "status" => println!(
                "{}",
                serde_json::json!({
                    "loggedIn": true,
                    "email": "developer@example.test",
                    "subscriptionType": "pro"
                })
            ),
            "login" | "logout" => {}
            "models" => println!("--effort <level> (low, medium, high, max)"),
            "block" => {
                std::io::stdout().flush().unwrap();
                thread::sleep(Duration::from_secs(30));
            }
            action => panic!("unexpected helper action: {action}"),
        }
    }

    fn test_command(action: &str) -> ClaudeCommand {
        let executable = std::env::current_exe().unwrap();
        ClaudeCommand {
            program: executable.into_os_string(),
            prefix_args: vec![
                OsString::from("--exact"),
                OsString::from("control::tests::claude_control_helper"),
                OsString::from("--nocapture"),
            ],
            environment: vec![
                (OsString::from(HELPER_MODE), OsString::from("1")),
                (OsString::from(HELPER_ACTION), OsString::from(action)),
            ],
            append_turn_args: false,
        }
    }
}
