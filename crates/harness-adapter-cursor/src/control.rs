use crate::runtime::{command_args, list_cursor_models};
use crate::session::CursorCommand;
use harness_agent::{AgentError, AgentResult, ControlHandlers, LoginEvent, ProviderControl};
use harness_proc::{SpawnOptions, SpawnedChild, run_cli, spawn_cli};
use harness_protocol::{Account, AuthStartLoginResult, Model};
use std::ffi::OsString;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const AUTH_MAX_OUTPUT: usize = 1024 * 1024;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub struct CursorControl {
    inner: Arc<ControlInner>,
}

struct ControlInner {
    command: CursorCommand,
    handlers: ControlHandlers,
    login_timeout: Duration,
    active_login: Mutex<Option<ActiveLogin>>,
    disposed: AtomicBool,
}

#[derive(Clone)]
struct ActiveLogin {
    id: String,
    child: Arc<Mutex<SpawnedChild>>,
    cancelled: Arc<AtomicBool>,
}

impl CursorControl {
    pub(crate) fn new(command: CursorCommand, handlers: ControlHandlers) -> Self {
        Self::with_login_timeout(command, handlers, LOGIN_TIMEOUT)
    }

    fn with_login_timeout(
        command: CursorCommand,
        handlers: ControlHandlers,
        login_timeout: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(ControlInner {
                command,
                handlers,
                login_timeout,
                active_login: Mutex::new(None),
                disposed: AtomicBool::new(false),
            }),
        }
    }

    fn account_inner(&self) -> AgentResult<Account> {
        let output = run_command(&self.inner.command, &["status"])?;
        Ok(Account {
            signed_in: output.code == Some(0) && is_cursor_signed_in(&output.stdout),
            email: None,
            plan: None,
        })
    }

    fn start_login_inner(&self) -> AgentResult<AuthStartLoginResult> {
        if self.inner.disposed.load(Ordering::Acquire) {
            return Err(AgentError::Failed("Cursor control is closed".into()));
        }
        self.cancel_active_login();
        let args = command_args(&self.inner.command, &["login"]);
        let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
        let mut child = spawn_cli(
            self.inner.command.program.as_os_str(),
            &arg_refs,
            &spawn_options(&self.inner.command),
        )
        .map_err(|_| AgentError::Failed("Cursor could not start its sign-in flow.".into()))?;
        drop(child.take_stdin());
        let stdout = child
            .take_stdout()
            .ok_or_else(|| AgentError::Failed("Cursor login stdout is unavailable".into()))?;
        let stderr = child
            .take_stderr()
            .ok_or_else(|| AgentError::Failed("Cursor login stderr is unavailable".into()))?;
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
            .name("harness-cursor-login".into())
            .spawn(move || {
                let stdout_reader = thread::spawn(move || {
                    let mut stdout = stdout;
                    io::copy(&mut stdout, &mut io::sink())
                });
                let stderr_reader = thread::spawn(move || {
                    let mut stderr = stderr;
                    io::copy(&mut stderr, &mut io::sink())
                });
                let deadline = Instant::now() + inner.login_timeout;
                let (success, error) = loop {
                    let wait_result = { lock(&child).try_wait() };
                    match wait_result {
                        Ok(Some(status)) => {
                            let success = status.success();
                            break (success, (!success).then(|| "Cursor sign-in failed.".into()));
                        }
                        Ok(None) if Instant::now() < deadline => {
                            thread::sleep(PROCESS_POLL_INTERVAL);
                        }
                        Ok(None) => {
                            let _ = lock(&child).kill_tree();
                            break (false, Some("Cursor sign-in timed out.".into()));
                        }
                        Err(_) => {
                            let _ = lock(&child).kill_tree();
                            break (false, Some("Cursor sign-in failed.".into()));
                        }
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
                if current && !cancelled.load(Ordering::Acquire) {
                    inner.handlers.emit_login(LoginEvent {
                        login_id: Some(worker_login_id),
                        success,
                        error,
                    });
                }
            });
        if worker.is_err() {
            self.cancel_active_login();
            return Err(AgentError::Failed(
                "could not start the Cursor login worker".into(),
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
                .map_err(|_| AgentError::Failed("could not cancel Cursor sign-in".into()))?;
        }
        Ok(())
    }

    fn sign_out_inner(&self) -> AgentResult<()> {
        self.cancel_active_login();
        let output = run_command(&self.inner.command, &["logout"])?;
        if output.code != Some(0) {
            return Err(AgentError::Failed("Cursor could not sign out.".into()));
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

impl ProviderControl for CursorControl {
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
        list_cursor_models(&self.inner.command)
    }

    fn dispose(&self) {
        self.dispose_inner();
    }
}

impl Drop for CursorControl {
    fn drop(&mut self) {
        self.dispose_inner();
    }
}

pub fn is_cursor_signed_in(output: &str) -> bool {
    let normalized = output.to_ascii_lowercase();
    !["not authenticated", "not logged in"]
        .iter()
        .any(|message| normalized.contains(message))
        && ["authenticated", "logged in"]
            .iter()
            .any(|message| normalized.contains(message))
}

fn run_command(
    command: &CursorCommand,
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
    .map_err(|_| AgentError::Failed("Cursor authentication command failed".into()))
}

fn spawn_options(command: &CursorCommand) -> SpawnOptions {
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

    const HELPER_MODE: &str = "HARNESS_CURSOR_CONTROL_HELPER";
    const HELPER_ACTION: &str = "HARNESS_CURSOR_CONTROL_ACTION";
    const WAIT: Duration = Duration::from_secs(2);

    #[test]
    fn distinguishes_positive_and_negative_status_text() {
        assert!(!is_cursor_signed_in(
            "Not authenticated. Run cursor-agent login."
        ));
        assert!(!is_cursor_signed_in("Not logged in"));
        assert!(is_cursor_signed_in("Authenticated as developer"));
        assert!(is_cursor_signed_in("Logged in"));
        assert!(!is_cursor_signed_in("status unavailable"));
    }

    #[test]
    fn drives_status_and_logout_over_bounded_cli_calls() {
        let status = CursorControl::new(test_command("status"), ControlHandlers::default());
        assert_eq!(
            status.account().unwrap(),
            Account {
                signed_in: true,
                email: None,
                plan: None,
            }
        );
        status.dispose();

        let logout = CursorControl::new(test_command("logout"), ControlHandlers::default());
        logout.sign_out().unwrap();
        logout.dispose();
    }

    #[test]
    fn login_completion_is_correlated_and_cancellation_is_quiet() {
        let (login_tx, login_rx) = mpsc::channel();
        let control = CursorControl::new(
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
        let cancelled = CursorControl::new(
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
    fn login_timeout_stops_the_child_and_reports_one_failure() {
        let (login_tx, login_rx) = mpsc::channel();
        let control = CursorControl::with_login_timeout(
            test_command("block"),
            ControlHandlers::new(
                move |event| {
                    let _ = login_tx.send(event);
                },
                |_| {},
            ),
            Duration::from_millis(50),
        );
        let started = control.start_login().unwrap();
        assert_eq!(
            login_rx.recv_timeout(WAIT).unwrap(),
            LoginEvent {
                login_id: Some(started.login_id),
                success: false,
                error: Some("Cursor sign-in timed out.".into()),
            }
        );
        assert!(login_rx.recv_timeout(Duration::from_millis(100)).is_err());
        control.dispose();
    }

    #[test]
    fn cursor_control_helper() {
        if std::env::var_os(HELPER_MODE).is_none() {
            return;
        }
        match std::env::var(HELPER_ACTION).unwrap().as_str() {
            "status" => println!("Authenticated as developer"),
            "login" | "logout" => {}
            "block" => {
                std::io::stdout().flush().unwrap();
                thread::sleep(Duration::from_secs(30));
            }
            action => panic!("unexpected helper action: {action}"),
        }
    }

    fn test_command(action: &str) -> CursorCommand {
        let executable = std::env::current_exe().unwrap();
        CursorCommand {
            program: executable.into_os_string(),
            prefix_args: vec![
                OsString::from("--exact"),
                OsString::from("control::tests::cursor_control_helper"),
                OsString::from("--nocapture"),
            ],
            environment: vec![
                (OsString::from(HELPER_MODE), OsString::from("1")),
                (OsString::from(HELPER_ACTION), OsString::from(action)),
            ],
            append_provider_args: false,
        }
    }
}
