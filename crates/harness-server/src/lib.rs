//! Native Personal Harness core transport.
//!
//! The server owns persistence and protocol ordering. Provider-specific behavior
//! stays behind adapters as it is ported; this transport never branches on a
//! provider name.

mod access;
mod agents;
mod api_workspace_tools;
mod design_preview_runner;
mod design_workflow;
mod diff_review;
mod inbox;
mod mcp_config;
mod mobile_access;
mod model_connections;
mod preview_capture;
mod project_directory_browser;
mod push;
mod router;
mod safe_command_environment;
mod skill_install;
mod update_check;
mod uploaded_attachment;

pub use access::{allowed_origin, assert_safe_bind, has_access};
pub use router::SERVER_VERSION;

use harness_agent::CancellationToken;
use harness_credentials::{CredentialStore, SystemCredentialStore};
use harness_protocol::{
    ErrorCode, Push, Request, Response, TerminalExitPush, TerminalOutputPush, WireError, channel,
};
use harness_store::Store;
use harness_terminal::TerminalManager;
use mobile_access::ConnectionAccess;
use push::{PendingPush, PushBus};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use thiserror::Error;
use tungstenite::handshake::server::{Request as HandshakeRequest, Response as HandshakeResponse};
use tungstenite::protocol::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::{Error as WebSocketError, Message, WebSocket, accept_hdr};

pub const DEFAULT_PORT: u16 = 4311;
const IO_POLL_INTERVAL: Duration = Duration::from_millis(40);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONNECTION_REQUESTS: usize = 32;

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub address: SocketAddr,
    pub mobile_port: Option<u16>,
    pub mobile_addresses: Option<Vec<harness_protocol::ConnectionAddress>>,
    pub access_token: Option<String>,
    pub store_path: PathBuf,
    pub mcp_config_path: PathBuf,
    pub providers_config_path: PathBuf,
    pub project_browser_home: Option<PathBuf>,
}

impl ServerConfig {
    pub fn loopback(store_path: impl Into<PathBuf>) -> Self {
        let store_path = store_path.into();
        Self {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DEFAULT_PORT),
            mobile_port: None,
            mobile_addresses: None,
            access_token: None,
            mcp_config_path: store_path.with_file_name("mcp.json"),
            providers_config_path: store_path.with_file_name("providers.json"),
            store_path,
            project_browser_home: None,
        }
    }

    pub fn from_environment() -> Result<Self, ServerError> {
        let host = std::env::var("HARNESS_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let host = host
            .parse::<IpAddr>()
            .map_err(|_| ServerError::InvalidHost(host))?;
        let port = environment_port()?;
        let config_root = environment_config_root()?;
        Ok(Self {
            address: SocketAddr::new(host, port),
            mobile_port: environment_mobile_port()?,
            mobile_addresses: None,
            access_token: std::env::var("HARNESS_ACCESS_TOKEN").ok(),
            store_path: store_location()?,
            mcp_config_path: config_root.join("mcp.json"),
            providers_config_path: config_root.join("providers.json"),
            project_browser_home: None,
        })
    }

    pub fn embedded_from_environment() -> Result<Self, ServerError> {
        let port = environment_port()?;
        let config_root = environment_config_root()?;
        Ok(Self {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            mobile_port: environment_mobile_port()?,
            mobile_addresses: None,
            access_token: None,
            store_path: store_location()?,
            mcp_config_path: config_root.join("mcp.json"),
            providers_config_path: config_root.join("providers.json"),
            project_browser_home: None,
        })
    }
}

fn environment_port() -> Result<u16, ServerError> {
    std::env::var("HARNESS_PORT")
        .ok()
        .map(|value| {
            value
                .parse::<u16>()
                .map_err(|_| ServerError::InvalidPort(value))
        })
        .transpose()
        .map(|port| port.unwrap_or(DEFAULT_PORT))
}

fn environment_mobile_port() -> Result<Option<u16>, ServerError> {
    std::env::var("HARNESS_MOBILE_PORT")
        .ok()
        .map(|value| {
            value
                .parse::<u16>()
                .map_err(|_| ServerError::InvalidMobilePort(value))
        })
        .transpose()
}

fn environment_config_root() -> Result<PathBuf, ServerError> {
    std::env::var_os("HARNESS_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".personalharness")))
        .ok_or(ServerError::MissingConfigDirectory)
}

#[derive(Debug, Error)]
pub enum ServerError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] harness_store::StoreError),
    #[error("{0}")]
    UnsafeBind(&'static str),
    #[error("HARNESS_HOST must be a literal IP address: {0}")]
    InvalidHost(String),
    #[error("HARNESS_PORT must be between 0 and 65535: {0}")]
    InvalidPort(String),
    #[error("HARNESS_MOBILE_PORT must be between 0 and 65535: {0}")]
    InvalidMobilePort(String),
    #[error("the control and mobile listeners must use different ports")]
    SharedControlAndMobilePort,
    #[error("the operating system did not provide a per-user data directory")]
    MissingDataDirectory,
    #[error("the operating system did not provide a home directory for MCP configuration")]
    MissingConfigDirectory,
    #[error("the Harness server thread panicked")]
    ThreadPanicked,
}

pub struct ServerHandle {
    address: SocketAddr,
    state: Arc<ServerState>,
    join: Option<JoinHandle<()>>,
}

impl ServerHandle {
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub fn close(mut self) -> Result<(), ServerError> {
        self.stop()
    }

    fn stop(&mut self) -> Result<(), ServerError> {
        self.state.shutdown.store(true, Ordering::Release);
        let _ = self.state.mobile_access.stop();
        self.state.agents.dispose_all();
        self.state.terminals.close_all();
        if let Some(join) = self.join.take() {
            join.join().map_err(|_| ServerError::ThreadPanicked)?;
        }
        Ok(())
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub fn start(config: ServerConfig) -> Result<ServerHandle, ServerError> {
    let credentials: Arc<dyn CredentialStore> = Arc::new(SystemCredentialStore::new());
    let model_connections = Arc::new(Mutex::new(model_connections::ModelConnectionStore::new(
        config.providers_config_path.clone(),
        Arc::clone(&credentials),
    )));
    let runtimes = Arc::new(agents::NativeRuntimes::new(
        Arc::clone(&model_connections),
        Arc::clone(&credentials),
    ));
    start_with_prepared_services(config, runtimes, credentials, model_connections)
}

#[cfg(test)]
fn start_with_runtimes(
    config: ServerConfig,
    runtimes: Arc<dyn agents::RuntimeRegistry>,
) -> Result<ServerHandle, ServerError> {
    start_with_services(config, runtimes, Arc::new(SystemCredentialStore::new()))
}

#[cfg(test)]
fn start_with_services(
    config: ServerConfig,
    runtimes: Arc<dyn agents::RuntimeRegistry>,
    credentials: Arc<dyn CredentialStore>,
) -> Result<ServerHandle, ServerError> {
    let model_connections = Arc::new(Mutex::new(model_connections::ModelConnectionStore::new(
        config.providers_config_path.clone(),
        Arc::clone(&credentials),
    )));
    start_with_prepared_services(config, runtimes, credentials, model_connections)
}

fn start_with_prepared_services(
    config: ServerConfig,
    runtimes: Arc<dyn agents::RuntimeRegistry>,
    credentials: Arc<dyn CredentialStore>,
    model_connections: Arc<Mutex<model_connections::ModelConnectionStore>>,
) -> Result<ServerHandle, ServerError> {
    assert_safe_bind(config.address.ip(), config.access_token.as_deref())
        .map_err(ServerError::UnsafeBind)?;
    let listener = TcpListener::bind(config.address)?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let mobile_port = config.mobile_port.unwrap_or_else(|| {
        if config.address.port() == 0 {
            0
        } else {
            config.address.port().saturating_add(1)
        }
    });
    if mobile_port != 0 && mobile_port == address.port() {
        return Err(ServerError::SharedControlAndMobilePort);
    }
    let store = Store::open(&config.store_path)?;
    recover_worktree_metadata(&store);
    let push = Arc::new(PushBus::new());
    let preview_capture = preview_capture::PreviewCaptureCoordinator::new(Arc::clone(&push));
    let output_push = Arc::clone(&push);
    let exit_push = Arc::clone(&push);
    let terminals = TerminalManager::new(
        move |terminal_id, data| {
            let _ = output_push.broadcast(
                channel::TERMINAL_OUTPUT,
                TerminalOutputPush { terminal_id, data },
            );
        },
        move |terminal_id, exit_code| {
            let _ = exit_push.broadcast(
                channel::TERMINAL_EXIT,
                TerminalExitPush {
                    terminal_id,
                    exit_code,
                },
            );
        },
    );
    let state = Arc::new(ServerState {
        store: Mutex::new(store),
        inbox: Mutex::new(inbox::InboxProjections::default()),
        mcp_config: Mutex::new(mcp_config::McpConfigStore::new(config.mcp_config_path)),
        model_connections,
        credentials,
        push,
        preview_capture,
        terminals,
        agents: agents::AgentManager::new(runtimes),
        reviewing_diffs: Mutex::new(HashSet::new()),
        voice_requests: Mutex::new(HashMap::new()),
        mobile_access: mobile_access::MobileAccess::new(mobile_port, config.mobile_addresses),
        shutdown: AtomicBool::new(false),
        access_token: config.access_token,
        project_browser_home: config.project_browser_home,
    });
    let listener_state = Arc::clone(&state);
    let join = thread::Builder::new()
        .name("harness-server".into())
        .spawn(move || run_listener(listener, listener_state))?;
    let restore_mobile_access = state
        .store
        .lock()
        .ok()
        .and_then(|store| store.mobile_access_enabled().ok())
        .unwrap_or(false);
    if restore_mobile_access && let Err(error) = state.mobile_access.start(&state) {
        eprintln!("[server] could not restore mobile access: {error}");
    }
    Ok(ServerHandle {
        address,
        state,
        join: Some(join),
    })
}

fn recover_worktree_metadata(store: &Store) {
    let Ok(worktrees) = store.worktrees() else {
        return;
    };
    let repositories = worktrees
        .iter()
        .map(|worktree| PathBuf::from(&worktree.repo_path))
        .collect::<BTreeSet<_>>();
    for repository in repositories {
        harness_workspace::prune_worktrees(repository);
    }
    for worktree in worktrees {
        if !std::path::Path::new(&worktree.path).exists() {
            let _ = store.forget_worktree(&worktree.thread_id);
        }
    }
}

pub fn store_location() -> Result<PathBuf, ServerError> {
    if let Some(override_path) = std::env::var_os("HARNESS_DATA_DIR") {
        return Ok(PathBuf::from(override_path).join("harness.db"));
    }
    dirs::data_dir()
        .map(|path| path.join("PersonalHarness").join("harness.db"))
        .ok_or(ServerError::MissingDataDirectory)
}

pub(crate) struct ServerState {
    store: Mutex<Store>,
    inbox: Mutex<inbox::InboxProjections>,
    mcp_config: Mutex<mcp_config::McpConfigStore>,
    model_connections: Arc<Mutex<model_connections::ModelConnectionStore>>,
    credentials: Arc<dyn CredentialStore>,
    push: Arc<PushBus>,
    preview_capture: preview_capture::PreviewCaptureCoordinator,
    terminals: TerminalManager,
    agents: agents::AgentManager,
    reviewing_diffs: Mutex<HashSet<String>>,
    voice_requests: Mutex<HashMap<String, ActiveVoiceRequest>>,
    mobile_access: mobile_access::MobileAccess,
    shutdown: AtomicBool,
    access_token: Option<String>,
    project_browser_home: Option<PathBuf>,
}

struct ActiveVoiceRequest {
    connection_id: u64,
    cancellation: CancellationToken,
}

struct VoiceRequestGuard<'a> {
    state: &'a ServerState,
    request_id: String,
    cancellation: CancellationToken,
}

impl VoiceRequestGuard<'_> {
    fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }
}

impl Drop for VoiceRequestGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.state.voice_requests.lock() {
            requests.remove(&self.request_id);
        }
    }
}

impl ServerState {
    fn start_voice_request(
        &self,
        connection_id: u64,
        request_id: &str,
    ) -> Result<VoiceRequestGuard<'_>, &'static str> {
        let cancellation = CancellationToken::default();
        let mut requests = self
            .voice_requests
            .lock()
            .map_err(|_| "voice request mutex poisoned")?;
        if requests.contains_key(request_id) {
            return Err("A voice transcription with this request id is already running.");
        }
        requests.insert(
            request_id.into(),
            ActiveVoiceRequest {
                connection_id,
                cancellation: cancellation.clone(),
            },
        );
        Ok(VoiceRequestGuard {
            state: self,
            request_id: request_id.into(),
            cancellation,
        })
    }

    fn cancel_voice_request(&self, request_id: &str) {
        if let Ok(requests) = self.voice_requests.lock()
            && let Some(request) = requests.get(request_id)
        {
            request.cancellation.cancel();
        }
    }

    fn cancel_connection_voice(&self, connection_id: u64) {
        if let Ok(requests) = self.voice_requests.lock() {
            for request in requests
                .values()
                .filter(|request| request.connection_id == connection_id)
            {
                request.cancellation.cancel();
            }
        }
    }
}

fn run_listener(listener: TcpListener, state: Arc<ServerState>) {
    let mut workers = Vec::new();
    while !state.shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _peer)) => {
                let worker_state = Arc::clone(&state);
                match thread::Builder::new()
                    .name("harness-connection".into())
                    .spawn(move || handle_connection(stream, worker_state))
                {
                    Ok(worker) => workers.push(worker),
                    Err(error) => eprintln!("[server] failed to start connection: {error}"),
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(IO_POLL_INTERVAL);
            }
            Err(error) => {
                eprintln!("[server] listener failed: {error}");
                break;
            }
        }
        let mut index = 0;
        while index < workers.len() {
            if workers[index].is_finished() {
                let worker = workers.swap_remove(index);
                let _ = worker.join();
            } else {
                index += 1;
            }
        }
    }
    state.shutdown.store(true, Ordering::Release);
    for worker in workers {
        let _ = worker.join();
    }
}

fn handle_connection(stream: TcpStream, state: Arc<ServerState>) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));

    let mut denial = None;
    let socket = accept_hdr(
        stream,
        |request: &HandshakeRequest, response: HandshakeResponse| {
            let origin_allowed = match request.headers().get("origin") {
                None => true,
                Some(value) => value
                    .to_str()
                    .ok()
                    .is_some_and(|origin| allowed_origin(Some(origin))),
            };
            if !origin_allowed {
                denial = Some("Origin not allowed");
            } else if !has_access(&request.uri().to_string(), state.access_token.as_deref()) {
                denial = Some("Access denied");
            }
            Ok(response)
        },
    );
    let Ok(mut socket) = socket else {
        return;
    };
    if let Some(reason) = denial {
        let _ = socket.close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: reason.into(),
        }));
        return;
    }
    let _ = socket.get_mut().set_read_timeout(Some(IO_POLL_INTERVAL));

    run_established_connection(&mut socket, &state, ConnectionAccess::Admin, None);
}

fn handle_mobile_connection(
    stream: TcpStream,
    state: Arc<ServerState>,
    mobile_shutdown: Arc<AtomicBool>,
) {
    let local_address = stream.local_addr().ok().map(|address| address.ip());
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));

    let mut denial = None;
    let mut access = None;
    let socket = accept_hdr(
        stream,
        |request: &HandshakeRequest, response: HandshakeResponse| {
            if !local_address
                .is_some_and(|address| state.mobile_access.listener_address_allowed(address))
            {
                denial = Some("Interface not allowed");
            } else {
                match state
                    .mobile_access
                    .authorize(&request.uri().to_string(), &state)
                {
                    Ok(Some(authorized)) => access = Some(authorized),
                    Ok(None) | Err(_) => denial = Some("Access denied"),
                }
            }
            Ok(response)
        },
    );
    let Ok(mut socket) = socket else {
        return;
    };
    if let Some(reason) = denial {
        let _ = socket.close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: reason.into(),
        }));
        return;
    }
    let Some(access) = access else {
        let _ = socket.close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: "Access denied".into(),
        }));
        return;
    };
    let _ = socket.get_mut().set_read_timeout(Some(IO_POLL_INTERVAL));
    run_established_connection(&mut socket, &state, access, Some(mobile_shutdown));
}

fn run_established_connection(
    socket: &mut WebSocket<TcpStream>,
    state: &Arc<ServerState>,
    access: ConnectionAccess,
    mobile_shutdown: Option<Arc<AtomicBool>>,
) {
    if matches!(access, ConnectionAccess::Pairing { .. }) {
        let (isolated_sender, pushes) = std::sync::mpsc::channel();
        let welcome = Push {
            channel: channel::SERVER_WELCOME.into(),
            sequence: 1,
            data: router::welcome(),
        };
        if !send_json(socket, &welcome) {
            return;
        }
        run_connection(socket, state, 0, pushes, access, mobile_shutdown, 1);
        drop(isolated_sender);
        return;
    }

    let (connection_id, pushes) = state.push.add();
    let _ = state
        .push
        .send(connection_id, channel::SERVER_WELCOME, router::welcome());
    run_connection(
        socket,
        state,
        connection_id,
        pushes,
        access,
        mobile_shutdown,
        0,
    );
    state.preview_capture.remove(connection_id);
    state.push.remove(connection_id);
}

fn run_connection(
    socket: &mut WebSocket<TcpStream>,
    state: &Arc<ServerState>,
    connection_id: u64,
    pushes: Receiver<PendingPush>,
    access: ConnectionAccess,
    mobile_shutdown: Option<Arc<AtomicBool>>,
    initial_sequence: u64,
) {
    let mut sequence = initial_sequence;
    let mut heartbeat = ConnectionHeartbeat::new(Instant::now());
    let (response_tx, response_rx) = std::sync::mpsc::channel();
    let mut workers = Vec::new();
    loop {
        reap_workers(&mut workers);
        if state.shutdown.load(Ordering::Acquire) {
            let _ = socket.close(None);
            break;
        }
        if mobile_shutdown
            .as_ref()
            .is_some_and(|shutdown| shutdown.load(Ordering::Acquire))
            || matches!(
                &access,
                ConnectionAccess::Device { device_id }
                    if !state.mobile_access.is_device_active(state, device_id)
            )
        {
            break;
        }
        if !flush_pushes(socket, &pushes, &mut sequence)
            || !flush_responses(socket, &pushes, &response_rx, &mut sequence)
        {
            break;
        }
        let now = Instant::now();
        if heartbeat.expired(now) {
            break;
        }
        if heartbeat.should_ping(now) {
            if socket.send(Message::Ping(Vec::new().into())).is_err() {
                break;
            }
            heartbeat.ping_sent(now);
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                heartbeat.received(Instant::now());
                dispatch_request(
                    state,
                    connection_id,
                    &access,
                    &response_tx,
                    &mut workers,
                    &text,
                );
            }
            Ok(Message::Binary(bytes)) => {
                heartbeat.received(Instant::now());
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    dispatch_request(
                        state,
                        connection_id,
                        &access,
                        &response_tx,
                        &mut workers,
                        text,
                    );
                }
            }
            Ok(Message::Ping(_) | Message::Pong(_)) => {
                heartbeat.received(Instant::now());
                if socket.flush().is_err() {
                    break;
                }
            }
            Ok(Message::Close(_) | Message::Frame(_)) => break,
            Err(error) if is_read_timeout(&error) => {}
            Err(_) => break,
        }
    }
    state.cancel_connection_voice(connection_id);
    for worker in workers {
        let _ = worker.join();
    }
}

struct ConnectionHeartbeat {
    last_received: Instant,
    last_ping: Instant,
}

impl ConnectionHeartbeat {
    fn new(now: Instant) -> Self {
        Self {
            last_received: now,
            last_ping: now,
        }
    }

    fn received(&mut self, now: Instant) {
        self.last_received = now;
    }

    fn should_ping(&self, now: Instant) -> bool {
        now.duration_since(self.last_ping) >= HEARTBEAT_INTERVAL
    }

    fn ping_sent(&mut self, now: Instant) {
        self.last_ping = now;
    }

    fn expired(&self, now: Instant) -> bool {
        now.duration_since(self.last_received) >= HEARTBEAT_TIMEOUT
    }
}

#[cfg(test)]
mod heartbeat_tests {
    use super::*;

    #[test]
    fn pings_and_expires_from_inbound_activity() {
        let start = Instant::now();
        let mut heartbeat = ConnectionHeartbeat::new(start);
        assert!(!heartbeat.should_ping(start + HEARTBEAT_INTERVAL - Duration::from_millis(1)));
        assert!(heartbeat.should_ping(start + HEARTBEAT_INTERVAL));

        heartbeat.ping_sent(start + HEARTBEAT_INTERVAL);
        assert!(!heartbeat.should_ping(start + HEARTBEAT_INTERVAL * 2 - Duration::from_millis(1)));
        heartbeat.received(start + HEARTBEAT_TIMEOUT - Duration::from_millis(1));
        assert!(!heartbeat.expired(start + HEARTBEAT_TIMEOUT));
        assert!(heartbeat.expired(start + HEARTBEAT_TIMEOUT * 2 - Duration::from_millis(1)));
    }
}

fn dispatch_request(
    state: &Arc<ServerState>,
    connection_id: u64,
    access: &ConnectionAccess,
    responses: &Sender<Response<Value>>,
    workers: &mut Vec<JoinHandle<()>>,
    text: &str,
) {
    let Ok(request) = serde_json::from_str::<Request<Value>>(text) else {
        return;
    };
    if !method_allowed(access, &request.method) {
        let _ = responses.send(Response::Failure {
            id: request.id,
            error: WireError {
                code: ErrorCode::Forbidden,
                message: "This connection cannot perform that action".into(),
                detail: None,
            },
        });
        return;
    }
    if matches!(
        access,
        ConnectionAccess::Device { device_id }
            if !state.mobile_access.is_device_active(state, device_id)
    ) {
        let _ = responses.send(Response::Failure {
            id: request.id,
            error: WireError {
                code: ErrorCode::Forbidden,
                message: "This device has been revoked".into(),
                detail: None,
            },
        });
        return;
    }
    if workers.len() >= MAX_CONNECTION_REQUESTS {
        let _ = responses.send(Response::Failure {
            id: request.id,
            error: WireError {
                code: ErrorCode::Internal,
                message: "too many requests are already running on this connection".into(),
                detail: None,
            },
        });
        return;
    }
    let state = Arc::clone(state);
    let access = access.clone();
    let worker_responses = responses.clone();
    let request_id = request.id.clone();
    let panic_request_id = request_id.clone();
    let worker = thread::Builder::new()
        .name("harness-request".into())
        .spawn(move || {
            let routed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                router::route(
                    &state,
                    connection_id,
                    &access,
                    &request.method,
                    request.params,
                )
            }));
            let response = match routed {
                Ok(Ok(result)) => Response::Success {
                    id: request.id,
                    result,
                },
                Ok(Err(error)) => Response::Failure {
                    id: request.id,
                    error: error.0,
                },
                Err(_) => Response::Failure {
                    id: panic_request_id,
                    error: WireError {
                        code: ErrorCode::Internal,
                        message: "request handler panicked".into(),
                        detail: None,
                    },
                },
            };
            let _ = worker_responses.send(response);
        });
    match worker {
        Ok(worker) => workers.push(worker),
        Err(error) => {
            let _ = responses.send(Response::Failure {
                id: request_id,
                error: WireError {
                    code: ErrorCode::Internal,
                    message: format!("could not start request handler: {error}"),
                    detail: None,
                },
            });
        }
    }
}

fn method_allowed(access: &ConnectionAccess, method_name: &str) -> bool {
    match access {
        ConnectionAccess::Admin => method_name != harness_protocol::method::CONNECTIONS_CLAIM,
        ConnectionAccess::Pairing { .. } => {
            method_name == harness_protocol::method::CONNECTIONS_CLAIM
        }
        ConnectionAccess::Device { .. } => matches!(
            method_name,
            harness_protocol::method::SYSTEM_INFO
                | harness_protocol::method::PROVIDERS_LIST
                | harness_protocol::method::CONNECTIONS_LIST
                | harness_protocol::method::CONNECTIONS_MODELS
                | harness_protocol::method::CONNECTIONS_DEVICE_STATUS
                | harness_protocol::method::WORKSPACE_INFO
                | harness_protocol::method::WORKSPACE_BRANCHES
                | harness_protocol::method::WORKSPACE_SWITCH_BRANCH
                | harness_protocol::method::MODELS_LIST
                | harness_protocol::method::ACP_AGENTS
                | harness_protocol::method::PROJECTS_LIST
                | harness_protocol::method::PROJECTS_BROWSE
                | harness_protocol::method::PROJECTS_ADD
                | harness_protocol::method::ATTACHMENTS_SAVE_FILE
                | harness_protocol::method::THREAD_HISTORY
                | harness_protocol::method::THREAD_QUEUE
                | harness_protocol::method::THREAD_START
                | harness_protocol::method::THREAD_RENAME
                | harness_protocol::method::THREAD_SEND_TURN
                | harness_protocol::method::THREAD_SETTLE
                | harness_protocol::method::THREAD_UNSETTLE
                | harness_protocol::method::THREAD_CLOSE
                | harness_protocol::method::THREAD_DELETE
                | harness_protocol::method::THREAD_DIFF
                | harness_protocol::method::THREAD_REVIEW_FILE
                | harness_protocol::method::THREAD_UNSAVED_WORK
                | harness_protocol::method::THREAD_INTERRUPT
                | harness_protocol::method::THREAD_RESPOND_TO_APPROVAL
                | harness_protocol::method::THREAD_RESPOND_TO_USER_INPUT
                | harness_protocol::method::THREAD_DELETE_QUEUED_TURN
                | harness_protocol::method::THREAD_STEER_QUEUED_TURN
        ),
    }
}

#[cfg(test)]
mod connection_access_tests {
    use super::*;
    use harness_protocol::method;

    #[test]
    fn pairing_and_device_connections_keep_the_mobile_trust_boundary() {
        let pairing = ConnectionAccess::Pairing {
            ticket_hash: "ticket".into(),
        };
        assert!(method_allowed(&pairing, method::CONNECTIONS_CLAIM));
        assert!(!method_allowed(&pairing, method::PROJECTS_LIST));

        let device = ConnectionAccess::Device {
            device_id: "phone".into(),
        };
        assert!(method_allowed(&device, method::PROJECTS_LIST));
        assert!(method_allowed(&device, method::ATTACHMENTS_SAVE_FILE));
        assert!(!method_allowed(&device, method::CONNECTIONS_STATUS));
        assert!(!method_allowed(&device, method::TERMINAL_OPEN));

        assert!(method_allowed(
            &ConnectionAccess::Admin,
            method::CONNECTIONS_STATUS
        ));
        assert!(!method_allowed(
            &ConnectionAccess::Admin,
            method::CONNECTIONS_CLAIM
        ));
    }
}

fn reap_workers(workers: &mut Vec<JoinHandle<()>>) {
    let mut index = 0;
    while index < workers.len() {
        if workers[index].is_finished() {
            let worker = workers.swap_remove(index);
            let _ = worker.join();
        } else {
            index += 1;
        }
    }
}

fn flush_responses(
    socket: &mut WebSocket<TcpStream>,
    pushes: &Receiver<PendingPush>,
    responses: &Receiver<Response<Value>>,
    sequence: &mut u64,
) -> bool {
    loop {
        match responses.try_recv() {
            Ok(response) => {
                // A route enqueues its pushes before publishing its response.
                // Drain that queue at the response boundary so the established
                // push-before-response ordering survives concurrent requests.
                if !flush_pushes(socket, pushes, sequence) || !send_json(socket, &response) {
                    return false;
                }
            }
            Err(TryRecvError::Empty) => return true,
            Err(TryRecvError::Disconnected) => return false,
        }
    }
}

fn flush_pushes(
    socket: &mut WebSocket<TcpStream>,
    pushes: &Receiver<PendingPush>,
    sequence: &mut u64,
) -> bool {
    loop {
        match pushes.try_recv() {
            Ok(pending) => {
                *sequence = sequence.saturating_add(1);
                if !send_json(
                    socket,
                    &Push {
                        channel: pending.channel,
                        sequence: *sequence,
                        data: pending.data,
                    },
                ) {
                    return false;
                }
            }
            Err(TryRecvError::Empty) => return true,
            Err(TryRecvError::Disconnected) => return false,
        }
    }
}

fn send_json<T: serde::Serialize>(socket: &mut WebSocket<TcpStream>, value: &T) -> bool {
    serde_json::to_string(value)
        .ok()
        .is_some_and(|text| socket.send(Message::text(text)).is_ok())
}

fn is_read_timeout(error: &WebSocketError) -> bool {
    matches!(
        error,
        WebSocketError::Io(error)
            if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
    )
}

#[cfg(test)]
mod tests;
