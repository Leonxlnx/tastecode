use crate::open_code_mcp_config;
use harness_agent::{AgentError, AgentHandlers, AgentResult, CredentialValues};
use harness_proc::{SpawnOptions, SpawnedChild, spawn_cli};
use harness_protocol::McpServerConfig;
use serde_json::json;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_STARTUP_LINE: usize = 1024 * 1024;
const CONFIG_ENVIRONMENT_KEY: &str = "OPENCODE_CONFIG_CONTENT";

#[derive(Clone, Debug)]
pub(crate) struct OpenCodeCommand {
    pub(crate) program: OsString,
    pub(crate) prefix_args: Vec<OsString>,
    pub(crate) environment: Vec<(OsString, OsString)>,
    pub(crate) append_provider_args: bool,
}

pub(crate) struct OpenCodeServer {
    pub(crate) base_url: Url,
    process: Arc<Mutex<SpawnedChild>>,
    closed: Arc<AtomicBool>,
}

impl OpenCodeServer {
    pub(crate) fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = lock(&self.process).kill_tree();
    }
}

impl Drop for OpenCodeServer {
    fn drop(&mut self) {
        self.close();
    }
}

pub(crate) fn start_server(
    command: &OpenCodeCommand,
    mcp_servers: &[McpServerConfig],
    mcp_credentials: &CredentialValues,
    handlers: &AgentHandlers,
) -> AgentResult<OpenCodeServer> {
    let mcp = open_code_mcp_config(mcp_servers, mcp_credentials)?;
    let config = if mcp_servers.is_empty() {
        json!({})
    } else {
        json!({ "mcp": mcp })
    };
    let mut environment = command.environment.clone();
    environment.retain(|(key, _)| key != OsStr::new(CONFIG_ENVIRONMENT_KEY));
    environment.push((
        OsString::from(CONFIG_ENVIRONMENT_KEY),
        OsString::from(config.to_string()),
    ));

    let mut args = command.prefix_args.clone();
    if command.append_provider_args {
        args.extend([
            OsString::from("serve"),
            OsString::from("--hostname=127.0.0.1"),
            OsString::from("--port=0"),
        ]);
    }
    let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
    let mut child = spawn_cli(
        command.program.as_os_str(),
        &arg_refs,
        &SpawnOptions {
            environment,
            ..SpawnOptions::default()
        },
    )
    .map_err(|_| unavailable())?;
    drop(child.take_stdin());
    let stdout = child.take_stdout().ok_or_else(unavailable)?;
    let stderr = child.take_stderr().ok_or_else(unavailable)?;
    let process = Arc::new(Mutex::new(child));
    let closed = Arc::new(AtomicBool::new(false));
    let (startup_tx, startup_rx) = std::sync::mpsc::sync_channel(1);
    let stdout_handlers = handlers.clone();
    let _ = thread::Builder::new()
        .name("harness-opencode-stdout".into())
        .spawn(move || stream_stdout(stdout, startup_tx, &stdout_handlers));
    let stderr_handlers = handlers.clone();
    let _ = thread::Builder::new()
        .name("harness-opencode-stderr".into())
        .spawn(move || stream_stderr(stderr, &stderr_handlers));

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let base_url = loop {
        match startup_rx.try_recv() {
            Ok(Ok(url)) => break url,
            Ok(Err(())) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                close_failed_start(&process, &closed);
                return Err(unavailable());
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
        }
        let wait_result = { lock(&process).try_wait() };
        match wait_result {
            Ok(Some(_)) | Err(_) => {
                close_failed_start(&process, &closed);
                return Err(unavailable());
            }
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            close_failed_start(&process, &closed);
            return Err(unavailable());
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    };

    let monitor_process = Arc::clone(&process);
    let monitor_closed = Arc::clone(&closed);
    let monitor_handlers = handlers.clone();
    let _ = thread::Builder::new()
        .name("harness-opencode-monitor".into())
        .spawn(move || {
            loop {
                match lock(&monitor_process).try_wait() {
                    Ok(Some(_)) | Err(_) => {
                        if !monitor_closed.load(Ordering::Acquire) {
                            monitor_handlers.emit_log("OpenCode server stopped unexpectedly");
                        }
                        return;
                    }
                    Ok(None) => thread::sleep(PROCESS_POLL_INTERVAL),
                }
            }
        });

    Ok(OpenCodeServer {
        base_url,
        process,
        closed,
    })
}

fn stream_stdout(
    mut stdout: impl Read,
    startup: std::sync::mpsc::SyncSender<Result<Url, ()>>,
    handlers: &AgentHandlers,
) {
    let mut pending = Vec::new();
    let mut discarding = false;
    let mut startup_sent = false;
    let mut chunk = [0_u8; 8192];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => {
                if !discarding && !pending.is_empty() {
                    startup_sent |= handle_stdout_line(&pending, &startup, handlers);
                }
                if !startup_sent {
                    let _ = startup.send(Err(()));
                }
                return;
            }
            Ok(read) => {
                for &byte in &chunk[..read] {
                    if byte == b'\n' {
                        if !discarding {
                            startup_sent |= handle_stdout_line(&pending, &startup, handlers);
                        }
                        pending.clear();
                        discarding = false;
                    } else if !discarding && pending.len() == MAX_STARTUP_LINE {
                        pending.clear();
                        discarding = true;
                        handlers.emit_log(format!(
                            "OpenCode stdout line exceeded {MAX_STARTUP_LINE} bytes"
                        ));
                    } else if !discarding {
                        pending.push(byte);
                    }
                }
            }
            Err(_) => {
                if !startup_sent {
                    let _ = startup.send(Err(()));
                }
                handlers.emit_log("OpenCode stdout ended unexpectedly");
                return;
            }
        }
    }
}

fn handle_stdout_line(
    bytes: &[u8],
    startup: &std::sync::mpsc::SyncSender<Result<Url, ()>>,
    handlers: &AgentHandlers,
) -> bool {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim_end_matches('\r');
    if let Some(url) = parse_server_url(line) {
        let _ = startup.try_send(Ok(url));
        true
    } else {
        if !line.trim().is_empty() {
            handlers.emit_log(line);
        }
        false
    }
}

fn stream_stderr(mut stderr: impl Read, handlers: &AgentHandlers) {
    let mut chunk = [0_u8; 8192];
    loop {
        match stderr.read(&mut chunk) {
            Ok(0) => return,
            Ok(read) => {
                let text = String::from_utf8_lossy(&chunk[..read]);
                let text = text.trim_end();
                if !text.is_empty() {
                    handlers.emit_log(text);
                }
            }
            Err(_) => {
                handlers.emit_log("OpenCode stderr ended unexpectedly");
                return;
            }
        }
    }
}

pub(crate) fn parse_server_url(line: &str) -> Option<Url> {
    if !line.starts_with("opencode server listening") {
        return None;
    }
    let candidate = line
        .split_ascii_whitespace()
        .find(|part| part.starts_with("http://") || part.starts_with("https://"))?;
    let url = Url::parse(candidate).ok()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url)
}

fn close_failed_start(process: &Mutex<SpawnedChild>, closed: &AtomicBool) {
    closed.store(true, Ordering::Release);
    let _ = lock(process).kill_tree();
}

fn unavailable() -> AgentError {
    AgentError::Failed(
        "OpenCode is unavailable. Install it and run `opencode` once to sign in.".into(),
    )
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_protocol::{McpConfigValue, McpTransport};
    use std::collections::{BTreeMap, HashMap};
    use std::io::Write as _;

    const HELPER_MODE: &str = "HARNESS_OPENCODE_SERVER_HELPER";
    const WAIT: Duration = Duration::from_secs(2);

    #[test]
    fn accepts_only_the_expected_literal_loopback_announcement() {
        assert_eq!(
            parse_server_url("opencode server listening on http://127.0.0.1:43110")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:43110/"
        );
        for line in [
            "listening on http://127.0.0.1:43110",
            "opencode server listening on http://localhost:43110",
            "opencode server listening on http://127.0.0.1",
            "opencode server listening on https://127.0.0.1:43110",
            "opencode server listening on http://example.com:43110",
        ] {
            assert!(parse_server_url(line).is_none(), "accepted {line}");
        }
    }

    #[test]
    fn launches_with_environment_config_and_reaps_the_process_tree() {
        let command = test_command();
        let credentials = CredentialValues::new(HashMap::from([(
            "secret-ref".into(),
            "secret-value".into(),
        )]));
        let server = start_server(
            &command,
            &[McpServerConfig {
                id: "docs".into(),
                enabled: true,
                display_name: None,
                transport: Some(McpTransport::Stdio {
                    command: "docs-server".into(),
                    args: None,
                    cwd: None,
                    environment: Some(BTreeMap::from([(
                        "TOKEN".into(),
                        McpConfigValue::Credential {
                            credential_ref: "secret-ref".into(),
                        },
                    )])),
                }),
            }],
            &credentials,
            &AgentHandlers::default(),
        )
        .unwrap();
        assert_eq!(server.base_url.as_str(), "http://127.0.0.1:43110/");
        let started = Instant::now();
        server.close();
        assert!(started.elapsed() < WAIT);
    }

    #[test]
    fn opencode_server_helper() {
        if std::env::var_os(HELPER_MODE).is_none() {
            return;
        }
        let config: serde_json::Value = serde_json::from_str(
            &std::env::var(CONFIG_ENVIRONMENT_KEY).expect("missing OpenCode config"),
        )
        .unwrap();
        assert_eq!(
            config["mcp"]["docs"]["environment"]["TOKEN"],
            "secret-value"
        );
        println!("opencode server listening on http://127.0.0.1:43110");
        std::io::stdout().flush().unwrap();
        thread::sleep(Duration::from_secs(30));
    }

    fn test_command() -> OpenCodeCommand {
        let executable = std::env::current_exe().unwrap();
        OpenCodeCommand {
            program: executable.into_os_string(),
            prefix_args: vec![
                OsString::from("--exact"),
                OsString::from("process::tests::opencode_server_helper"),
                OsString::from("--nocapture"),
            ],
            environment: vec![(OsString::from(HELPER_MODE), OsString::from("1"))],
            append_provider_args: false,
        }
    }
}
