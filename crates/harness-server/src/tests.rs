use super::*;
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentRuntime, AgentSession, CancellationToken,
    ControlHandlers, CredentialValues, LoginEvent, McpOAuthEvent, ProviderControl, StartOptions,
    TurnOptions,
};
use harness_credentials::{CredentialError, CredentialStore};
use harness_protocol::{
    Account, ApprovalDecision, AuthStartLoginResult, Capabilities, DomainEvent, Item, ItemStatus,
    ItemType, McpOAuthStartResult, McpServerConfig, MessageRole, Model, ProviderId, ServiceTier,
    Thread, Turn, TurnStatus, VoiceStatusResult, VoiceTranscribeParams,
};
use harness_store::{NewCheckpoint, NewThread as StoreNewThread};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;
use tempfile::TempDir;
use tungstenite::client::IntoClientRequest as _;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket, connect};

type ClientSocket = WebSocket<MaybeTlsStream<TcpStream>>;

fn start_test_server(
    access_token: Option<&str>,
    seed: impl FnOnce(&mut Store),
) -> (TempDir, ServerHandle) {
    let directory = tempfile::tempdir().unwrap();
    let store_path = directory.path().join("harness.db");
    let mut store = Store::open(&store_path).unwrap();
    seed(&mut store);
    store.close().unwrap();
    let server = start(ServerConfig {
        address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        access_token: access_token.map(str::to_owned),
        mcp_config_path: directory.path().join("mcp.json"),
        providers_config_path: directory.path().join("providers.json"),
        store_path,
    })
    .unwrap();
    (directory, server)
}

fn start_test_server_with_runtimes(
    runtimes: Arc<dyn crate::agents::RuntimeRegistry>,
) -> (TempDir, ServerHandle) {
    start_test_server_with_runtimes_and_seed(runtimes, |_| {})
}

fn start_test_server_with_runtimes_and_seed(
    runtimes: Arc<dyn crate::agents::RuntimeRegistry>,
    seed: impl FnOnce(&mut Store),
) -> (TempDir, ServerHandle) {
    let directory = tempfile::tempdir().unwrap();
    let store_path = directory.path().join("harness.db");
    let mut store = Store::open(&store_path).unwrap();
    seed(&mut store);
    store.close().unwrap();
    let server = start_with_runtimes(
        ServerConfig {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            access_token: None,
            mcp_config_path: directory.path().join("mcp.json"),
            providers_config_path: directory.path().join("providers.json"),
            store_path,
        },
        runtimes,
    )
    .unwrap();
    (directory, server)
}

fn start_test_server_with_services(
    runtimes: Arc<dyn crate::agents::RuntimeRegistry>,
    credentials: Arc<dyn CredentialStore>,
) -> (TempDir, ServerHandle) {
    let directory = tempfile::tempdir().unwrap();
    let store_path = directory.path().join("harness.db");
    Store::open(&store_path).unwrap().close().unwrap();
    let server = start_with_services(
        ServerConfig {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            access_token: None,
            mcp_config_path: directory.path().join("mcp.json"),
            providers_config_path: directory.path().join("providers.json"),
            store_path,
        },
        runtimes,
        credentials,
    )
    .unwrap();
    (directory, server)
}

fn start_test_server_with_native_runtimes() -> (TempDir, ServerHandle, Arc<MemoryCredentials>) {
    let directory = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let server = start_native_server_in(directory.path(), Arc::clone(&credentials));
    (directory, server, credentials)
}

fn start_native_server_in(
    directory: &std::path::Path,
    credentials: Arc<MemoryCredentials>,
) -> ServerHandle {
    let config = ServerConfig {
        address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        access_token: None,
        store_path: directory.join("harness.db"),
        mcp_config_path: directory.join("mcp.json"),
        providers_config_path: directory.join("providers.json"),
    };
    Store::open(&config.store_path).unwrap().close().unwrap();
    let credential_store: Arc<dyn CredentialStore> = credentials.clone();
    let model_connections = Arc::new(Mutex::new(
        crate::model_connections::ModelConnectionStore::new(
            config.providers_config_path.clone(),
            Arc::clone(&credential_store),
        ),
    ));
    let runtimes = Arc::new(crate::agents::NativeRuntimes::new(
        Arc::clone(&model_connections),
        credential_store.clone(),
    ));
    start_with_prepared_services(config, runtimes, credential_store, model_connections).unwrap()
}

#[derive(Default)]
struct MemoryCredentials(Mutex<HashMap<String, String>>);

impl CredentialStore for MemoryCredentials {
    fn read(&self, reference: &str) -> harness_credentials::Result<String> {
        self.0
            .lock()
            .unwrap()
            .get(reference)
            .cloned()
            .ok_or_else(|| CredentialError::NotFound(reference.into()))
    }

    fn contains(&self, reference: &str) -> bool {
        self.0.lock().unwrap().contains_key(reference)
    }

    fn write(&self, reference: &str, value: &str) -> harness_credentials::Result<()> {
        self.0
            .lock()
            .unwrap()
            .insert(reference.into(), value.into());
        Ok(())
    }

    fn remove(&self, reference: &str) {
        self.0.lock().unwrap().remove(reference);
    }
}

fn connect_native(server: &ServerHandle, suffix: &str) -> ClientSocket {
    let (mut socket, _) = connect(format!("ws://{}{}", server.address(), suffix)).unwrap();
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
    }
    socket
}

fn read_value(socket: &mut ClientSocket) -> Value {
    loop {
        match socket.read().unwrap() {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(_) | Message::Pong(_) => continue,
            message => panic!("expected text frame, got {message:?}"),
        }
    }
}

fn send_request(socket: &mut ClientSocket, id: &str, method: &str, params: Value) {
    socket
        .send(Message::text(
            json!({ "id": id, "method": method, "params": params }).to_string(),
        ))
        .unwrap();
}

fn serve_json_once(
    body: Value,
) -> (
    String,
    std::sync::mpsc::Receiver<String>,
    std::thread::JoinHandle<()>,
) {
    use std::io::{BufRead as _, BufReader, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let join = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = String::new();
        {
            let mut reader = BufReader::new(&mut stream);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                request.push_str(&line);
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
        }
        sender.send(request).unwrap();
        let body = body.to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        stream.flush().unwrap();
    });
    (format!("http://{address}/v1"), receiver, join)
}

fn serve_sse_once(
    body: String,
) -> (
    String,
    std::sync::mpsc::Receiver<String>,
    std::thread::JoinHandle<()>,
) {
    serve_sse(vec![body])
}

fn serve_sse(
    bodies: Vec<String>,
) -> (
    String,
    std::sync::mpsc::Receiver<String>,
    std::thread::JoinHandle<()>,
) {
    use std::io::{BufRead as _, BufReader, Read as _, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let join = std::thread::spawn(move || {
        for body in bodies {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    request.push_str(&line);
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                let content_length = request
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(str::trim)
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut payload = vec![0; content_length];
                reader.read_exact(&mut payload).unwrap();
                request.push_str(&String::from_utf8_lossy(&payload));
            }
            sender.send(request).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            stream.flush().unwrap();
        }
    });
    (format!("http://{address}/v1"), receiver, join)
}

fn completed_message(id: &str, text: &str, created_at: f64) -> DomainEvent {
    DomainEvent::ItemCompleted {
        item: Item {
            id: id.into(),
            turn_id: id.into(),
            item_type: ItemType::Message,
            status: ItemStatus::Completed,
            role: Some(MessageRole::Assistant),
            text: Some(text.into()),
            command: None,
            exit_code: None,
            duration_ms: None,
            path: None,
            lines_added: None,
            lines_removed: None,
            created_at,
        },
    }
}

fn git(cwd: &std::path::Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}

fn assert_welcome(socket: &mut ClientSocket) {
    assert_eq!(
        read_value(socket),
        json!({
            "channel": "server.welcome",
            "sequence": 1,
            "data": { "serverVersion": "0.0.0", "protocolVersion": 2 }
        })
    );
}

fn record_terminal_push(
    frame: &Value,
    next_sequence: &mut u64,
    output: &mut String,
    exit: &mut Option<Value>,
) {
    assert_eq!(frame["sequence"], *next_sequence);
    *next_sequence += 1;
    match frame["channel"].as_str() {
        Some("terminal.output") => output.push_str(frame["data"]["data"].as_str().unwrap()),
        Some("terminal.exit") => *exit = Some(frame["data"].clone()),
        channel => panic!("unexpected push channel: {channel:?}"),
    }
}

fn read_response_with_terminal_pushes(
    socket: &mut ClientSocket,
    response_id: &str,
    next_sequence: &mut u64,
    output: &mut String,
    exit: &mut Option<Value>,
) -> Value {
    loop {
        let frame = read_value(socket);
        if frame["id"] == response_id {
            return frame;
        }
        record_terminal_push(&frame, next_sequence, output, exit);
    }
}

fn read_until_response(socket: &mut ClientSocket, response_id: &str) -> (Vec<Value>, Value) {
    let mut pushes = Vec::new();
    loop {
        let frame = read_value(socket);
        if frame["id"] == response_id {
            return (pushes, frame);
        }
        pushes.push(frame);
    }
}

fn read_until_matching(socket: &mut ClientSocket, matches: impl Fn(&Value) -> bool) -> Value {
    loop {
        let frame = read_value(socket);
        if matches(&frame) {
            return frame;
        }
    }
}

fn wait_for_sent_count(session: &FakeSession, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if session.sent_texts.lock().unwrap().len() >= expected {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!(
        "expected {expected} sent turns, got {}",
        session.sent_texts.lock().unwrap().len()
    );
}

#[test]
fn native_claude_runtime_exposes_the_captured_model_catalog() {
    let (_directory, server, _credentials) = start_test_server_with_native_runtimes();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "models",
        "models.list",
        json!({ "provider": "claude-code" }),
    );
    let models = read_value(&mut socket);
    assert_eq!(
        models["result"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "fable",
            "opus",
            "sonnet",
            "haiku",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
        ]
    );
    assert_eq!(models["result"]["models"][0]["isDefault"], true);

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn native_cursor_runtime_starts_and_persists_a_provider_thread() {
    let (directory, server, _credentials) = start_test_server_with_native_runtimes();
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "start",
        "thread.start",
        json!({
            "provider": "cursor",
            "workspacePath": workspace.to_string_lossy(),
            "model": "composer-2.5",
            "approval": "ask"
        }),
    );
    let (_, started) = read_until_response(&mut socket, "start");
    let thread_id = started["result"]["threadId"].as_str().unwrap();
    assert!(thread_id.starts_with("cursor-"));

    send_request(&mut socket, "projects", "projects.list", json!({}));
    let projects = read_value(&mut socket);
    let session = projects["result"]["projects"][0]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["id"] == thread_id)
        .unwrap();
    assert_eq!(session["provider"], "cursor");

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn native_opencode_runtime_is_registered_without_acp_or_api_routing() {
    let directory = tempfile::tempdir().unwrap();
    let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentials::default());
    let model_connections = Arc::new(Mutex::new(
        crate::model_connections::ModelConnectionStore::new(
            directory.path().join("providers.json"),
            Arc::clone(&credentials),
        ),
    ));
    let runtimes = crate::agents::NativeRuntimes::new(model_connections, credentials);
    let runtime =
        crate::agents::RuntimeRegistry::runtime(&runtimes, ProviderId::OpenCode, None, None)
            .unwrap();
    let control = runtime.open_control(ControlHandlers::default()).unwrap();
    let mcp = control.list_mcp_servers().unwrap();
    assert!(!mcp.capabilities.inventory);
    assert!(mcp.capabilities.add);
    assert!(mcp.capabilities.update);
    assert!(mcp.capabilities.remove);
    assert!(
        crate::agents::RuntimeRegistry::runtime(
            &runtimes,
            ProviderId::OpenCode,
            Some("agent"),
            None,
        )
        .is_err()
    );
    assert!(
        crate::agents::RuntimeRegistry::runtime(
            &runtimes,
            ProviderId::OpenCode,
            None,
            Some("connection"),
        )
        .is_err()
    );
}

#[test]
fn native_one_shot_runtimes_are_registered_without_acp_or_api_routing() {
    let directory = tempfile::tempdir().unwrap();
    let credentials: Arc<dyn CredentialStore> = Arc::new(MemoryCredentials::default());
    let model_connections = Arc::new(Mutex::new(
        crate::model_connections::ModelConnectionStore::new(
            directory.path().join("providers.json"),
            Arc::clone(&credentials),
        ),
    ));
    let runtimes = crate::agents::NativeRuntimes::new(model_connections, credentials);
    for provider in [ProviderId::Grok, ProviderId::Antigravity] {
        let _runtime =
            crate::agents::RuntimeRegistry::runtime(&runtimes, provider, None, None).unwrap();
        assert!(
            crate::agents::RuntimeRegistry::runtime(&runtimes, provider, Some("agent"), None)
                .is_err()
        );
        assert!(
            crate::agents::RuntimeRegistry::runtime(&runtimes, provider, None, Some("connection"),)
                .is_err()
        );
    }
}

#[test]
fn native_acp_runtime_routes_models_and_control_by_agent() {
    let (_directory, server, _credentials) = start_test_server_with_native_runtimes();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "models",
        "models.list",
        json!({ "provider": "acp", "agent": "gemini" }),
    );
    let models = read_value(&mut socket);
    assert_eq!(
        models["result"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "gemini-3-pro-preview",
            "gemini-3-flash-preview",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
        ]
    );

    send_request(
        &mut socket,
        "account",
        "auth.status",
        json!({ "provider": "acp", "agent": "gemini" }),
    );
    assert_eq!(
        read_value(&mut socket),
        json!({ "id": "account", "result": { "signedIn": false } })
    );

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_agent_routes_persist_stream_queue_and_resume_draining() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (directory, server) = start_test_server_with_runtimes(registry);
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let workspace = workspace.to_string_lossy().into_owned();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "models",
        "models.list",
        json!({ "provider": "codex" }),
    );
    let models = read_value(&mut socket);
    assert_eq!(models["result"]["models"][0]["id"], "fake-model");

    send_request(
        &mut socket,
        "start",
        "thread.start",
        json!({
            "provider": "codex",
            "workspacePath": workspace,
            "model": "fake-model",
            "effort": "high",
            "approval": "auto-review"
        }),
    );
    let (start_pushes, started) = read_until_response(&mut socket, "start");
    assert_eq!(started["result"]["threadId"], "thread-1");
    assert_eq!(start_pushes[0]["channel"], "thread.event");
    assert_eq!(start_pushes[0]["data"]["event"]["type"], "thread.started");
    let options = runtime.start_options.lock().unwrap().clone().unwrap();
    assert_eq!(options.model.as_deref(), Some("fake-model"));
    assert_eq!(options.effort.as_deref(), Some("high"));
    assert!(
        options
            .instructions
            .as_deref()
            .is_some_and(|instructions| instructions.contains("clear, capable teammate"))
    );

    send_request(
        &mut socket,
        "turn-1",
        "thread.sendTurn",
        json!({
            "threadId": "thread-1",
            "text": "First",
            "attachments": ["/repo/reference.png"],
            "serviceTier": "priority"
        }),
    );
    let (turn_pushes, first_turn) = read_until_response(&mut socket, "turn-1");
    assert_eq!(
        first_turn["result"],
        json!({ "queued": false, "turnId": "turn-1" })
    );
    assert!(turn_pushes.iter().any(|push| {
        push["channel"] == "thread.event" && push["data"]["event"]["type"] == "turn.started"
    }));

    send_request(
        &mut socket,
        "turn-2",
        "thread.sendTurn",
        json!({ "threadId": "thread-1", "text": "Second" }),
    );
    let (queue_pushes, queued) = read_until_response(&mut socket, "turn-2");
    assert_eq!(queued["result"]["queued"], true);
    assert_eq!(queued["result"]["queuedTurn"]["text"], "Second");
    let queued_id = queued["result"]["queuedTurn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(queue_pushes.iter().any(|push| {
        push["channel"] == "thread.queue" && push["data"]["items"][0]["text"] == "Second"
    }));

    send_request(&mut socket, "projects", "projects.list", json!({}));
    let projects = read_value(&mut socket);
    let session = &projects["result"]["projects"][0]["sessions"][0];
    assert_eq!(session["running"], true);
    assert_eq!(session["status"], "working");

    send_request(
        &mut socket,
        "approval",
        "thread.respondToApproval",
        json!({
            "threadId": "thread-1",
            "approvalId": "approval-1",
            "decision": "approve-session"
        }),
    );
    let (_, approval) = read_until_response(&mut socket, "approval");
    assert_eq!(approval["result"], json!({}));
    send_request(
        &mut socket,
        "input",
        "thread.respondToUserInput",
        json!({
            "threadId": "thread-1",
            "requestId": "input-1",
            "answers": { "palette": ["Blue"] }
        }),
    );
    let (_, input) = read_until_response(&mut socket, "input");
    assert_eq!(input["result"], json!({}));

    send_request(
        &mut socket,
        "steer",
        "thread.steerQueuedTurn",
        json!({ "threadId": "thread-1", "queuedTurnId": queued_id }),
    );
    let (_, steered) = read_until_response(&mut socket, "steer");
    assert_eq!(steered["result"], json!({}));
    send_request(
        &mut socket,
        "turn-3",
        "thread.sendTurn",
        json!({ "threadId": "thread-1", "text": "Third" }),
    );
    let (_, third) = read_until_response(&mut socket, "turn-3");
    assert_eq!(third["result"]["queued"], true);

    runtime.session().complete("turn-1");
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut second_started = false;
    while Instant::now() < deadline && !second_started {
        let frame = read_value(&mut socket);
        second_started = frame["channel"] == "thread.event"
            && frame["data"]["event"]["type"] == "turn.started"
            && frame["data"]["event"]["turn"]["id"] == "turn-2";
    }
    assert!(second_started, "queued turn did not start after completion");
    let session = runtime.session();
    assert_eq!(
        session.sent_texts.lock().unwrap().as_slice(),
        ["First", "Third"]
    );
    assert_eq!(session.steered_texts.lock().unwrap().as_slice(), ["Second"]);
    assert_eq!(
        session.approvals.lock().unwrap().as_slice(),
        [("approval-1".into(), ApprovalDecision::ApproveSession)]
    );
    assert_eq!(
        session.user_inputs.lock().unwrap()[0].1["palette"],
        ["Blue"]
    );

    send_request(
        &mut socket,
        "history",
        "thread.history",
        json!({ "threadId": "thread-1" }),
    );
    let (_, history) = read_until_response(&mut socket, "history");
    assert_eq!(history["result"]["running"], true);
    let events = history["result"]["events"].as_array().unwrap();
    assert!(
        events
            .iter()
            .any(|entry| entry["event"]["type"] == "turn.completed")
    );
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0]["seq"].as_u64() < pair[1]["seq"].as_u64())
    );

    send_request(
        &mut socket,
        "interrupt",
        "thread.interrupt",
        json!({ "threadId": "thread-1" }),
    );
    let (_, interrupted) = read_until_response(&mut socket, "interrupt");
    assert_eq!(interrupted["result"], json!({}));
    assert!(runtime.session().interrupted.load(Ordering::Acquire));

    send_request(
        &mut socket,
        "close",
        "thread.close",
        json!({ "threadId": "thread-1" }),
    );
    let (_, closed) = read_until_response(&mut socket, "close");
    assert_eq!(closed["result"], json!({}));
    assert!(runtime.session().disposed.load(Ordering::Acquire));
}

#[test]
fn queued_turn_routes_reorder_delete_and_preserve_the_selected_prompt() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (directory, server) = start_test_server_with_runtimes(registry);
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(
        &mut socket,
        "queue-start",
        "thread.start",
        json!({
            "provider": "codex",
            "workspacePath": workspace.to_string_lossy()
        }),
    );
    let _ = read_until_response(&mut socket, "queue-start");
    send_request(
        &mut socket,
        "queue-running",
        "thread.sendTurn",
        json!({"threadId": "thread-1", "text": "running"}),
    );
    let _ = read_until_response(&mut socket, "queue-running");
    send_request(
        &mut socket,
        "queue-first",
        "thread.sendTurn",
        json!({"threadId": "thread-1", "text": "first queued"}),
    );
    let (_, first) = read_until_response(&mut socket, "queue-first");
    let first_id = first["result"]["queuedTurn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    send_request(
        &mut socket,
        "queue-second",
        "thread.sendTurn",
        json!({
            "threadId": "thread-1",
            "text": "second queued",
            "attachments": ["/repo/reference.png"]
        }),
    );
    let (_, second) = read_until_response(&mut socket, "queue-second");
    let second_id = second["result"]["queuedTurn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    send_request(
        &mut socket,
        "queue-move",
        "thread.moveQueuedTurn",
        json!({
            "threadId": "thread-1",
            "queuedTurnId": second_id,
            "direction": "up"
        }),
    );
    let _ = read_until_response(&mut socket, "queue-move");
    send_request(
        &mut socket,
        "queue-after-move",
        "thread.queue",
        json!({"threadId": "thread-1"}),
    );
    let (_, moved) = read_until_response(&mut socket, "queue-after-move");
    assert_eq!(moved["result"]["items"][0]["text"], "second queued");
    assert_eq!(
        moved["result"]["items"][0]["attachments"],
        json!(["/repo/reference.png"])
    );
    assert_eq!(moved["result"]["items"][1]["text"], "first queued");

    send_request(
        &mut socket,
        "queue-delete",
        "thread.deleteQueuedTurn",
        json!({"threadId": "thread-1", "queuedTurnId": first_id}),
    );
    let _ = read_until_response(&mut socket, "queue-delete");
    send_request(
        &mut socket,
        "queue-after-delete",
        "thread.queue",
        json!({"threadId": "thread-1"}),
    );
    let (_, deleted) = read_until_response(&mut socket, "queue-after-delete");
    assert_eq!(deleted["result"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(deleted["result"]["items"][0]["text"], "second queued");

    send_request(
        &mut socket,
        "queue-invalid-direction",
        "thread.moveQueuedTurn",
        json!({
            "threadId": "thread-1",
            "queuedTurnId": second_id,
            "direction": "sideways"
        }),
    );
    let invalid = read_value(&mut socket);
    assert_eq!(invalid["error"]["code"], "bad_request");

    let session = runtime.session();
    session.complete("turn-1");
    wait_for_sent_count(&session, 2);
    assert_eq!(
        session.sent_texts.lock().unwrap().as_slice(),
        ["running", "second queued"]
    );
    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn panic_stop_interrupts_live_sessions_concurrently_and_drops_their_queues() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let workspace = tempfile::tempdir().unwrap();
    let workspace_path = workspace.path().to_string_lossy().into_owned();
    let stored_workspace = workspace_path.clone();
    let (directory, server) = start_test_server_with_runtimes_and_seed(registry, move |store| {
        store.add_project(&stored_workspace, None).unwrap();
        for thread_id in ["panic-one", "panic-two"] {
            store
                .add_thread(StoreNewThread {
                    id: thread_id.into(),
                    project_path: stored_workspace.clone(),
                    provider: ProviderId::Codex,
                    agent: None,
                    title: thread_id.into(),
                    created_at: Some(1_000),
                    worktree_path: None,
                    worktree_branch: None,
                })
                .unwrap();
        }
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    for (index, thread_id) in ["panic-one", "panic-two"].into_iter().enumerate() {
        send_request(
            &mut socket,
            &format!("panic-running-{index}"),
            "thread.sendTurn",
            json!({"threadId": thread_id, "text": format!("running {index}")}),
        );
        let _ = read_until_response(&mut socket, &format!("panic-running-{index}"));
        send_request(
            &mut socket,
            &format!("panic-queued-{index}"),
            "thread.sendTurn",
            json!({"threadId": thread_id, "text": "must not restart"}),
        );
        let (_, queued) = read_until_response(&mut socket, &format!("panic-queued-{index}"));
        assert_eq!(queued["result"]["queued"], true);
    }
    let sessions = runtime.sessions.lock().unwrap().clone();
    assert_eq!(sessions.len(), 2);
    sessions[0].interrupt_delay_ms.store(75, Ordering::Release);
    *sessions[1].interrupt_error.lock().unwrap() = Some("adapter did not respond".into());

    send_request(&mut socket, "panic-stop", "system.panicStop", json!({}));
    let (_, stopped) = read_until_response(&mut socket, "panic-stop");
    assert_eq!(
        stopped["result"],
        json!({
            "sessions": [
                {"threadId": "panic-one", "status": "interrupted"},
                {
                    "threadId": "panic-two",
                    "status": "failed",
                    "error": "adapter did not respond"
                }
            ]
        })
    );
    assert!(
        sessions
            .iter()
            .all(|session| session.interrupted.load(Ordering::Acquire))
    );
    assert!(!sessions[0].disposed.load(Ordering::Acquire));
    assert!(sessions[1].disposed.load(Ordering::Acquire));
    for (index, thread_id) in ["panic-one", "panic-two"].into_iter().enumerate() {
        send_request(
            &mut socket,
            &format!("panic-queue-check-{index}"),
            "thread.queue",
            json!({"threadId": thread_id}),
        );
        let (_, queue) = read_until_response(&mut socket, &format!("panic-queue-check-{index}"));
        assert_eq!(queue["result"]["items"], json!([]));
    }
    assert_eq!(
        sessions[0].sent_texts.lock().unwrap().as_slice(),
        ["running 0"]
    );

    socket.close(None).unwrap();
    server.close().unwrap();
    let store = Store::open(directory.path().join("harness.db")).unwrap();
    assert!(
        store
            .thread("panic-one")
            .unwrap()
            .unwrap()
            .closed_at
            .is_none()
    );
    assert!(
        store
            .thread("panic-two")
            .unwrap()
            .unwrap()
            .closed_at
            .is_none()
    );
    store.close().unwrap();
}

#[test]
fn design_mode_runs_native_artifact_pipeline_and_drains_queue() {
    let runtime = Arc::new(FakeRuntime::default());
    runtime.images_disabled.store(true, Ordering::Release);
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (directory, server) = start_test_server_with_runtimes(registry);
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let preview_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let preview_port = preview_listener.local_addr().unwrap().port();
    drop(preview_listener);
    fs::write(
        workspace.join("preview.mjs"),
        format!(
            "import {{ createServer }} from 'node:http';\ncreateServer((_request, response) => response.end('ready')).listen({preview_port}, '127.0.0.1');\n"
        ),
    )
    .unwrap();

    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(
        &mut socket,
        "start-design",
        "thread.start",
        json!({
            "provider": "codex",
            "workspacePath": workspace.to_string_lossy()
        }),
    );
    let _ = read_until_response(&mut socket, "start-design");
    send_request(
        &mut socket,
        "design-turn",
        "thread.sendTurn",
        json!({
            "threadId": "thread-1",
            "text": "Build a focused coffee landing page.",
            "attachments": [
                harness_design_agent::DESIGN_BRIEF_ATTACHMENT,
                "/repo/reference.png"
            ],
            "model": "design-model",
            "serviceTier": "priority",
            "effort": "xhigh"
        }),
    );
    let (_, started) = read_until_response(&mut socket, "design-turn");
    assert_eq!(started["result"]["turnId"], "turn-1");

    send_request(
        &mut socket,
        "after-design",
        "thread.sendTurn",
        json!({ "threadId": "thread-1", "text": "Continue normally." }),
    );
    let (_, queued) = read_until_response(&mut socket, "after-design");
    assert_eq!(queued["result"]["queued"], true);

    let outputs = vec![
        json!({
            "status": "complete",
            "message": "Brief complete.",
            "questions": [],
            "brief": {
                "originalRequest": "Build a focused coffee landing page.",
                "subject": "Coffee",
                "pageType": "Landing page",
                "scope": "One responsive page",
                "primaryGoal": "Sell coffee",
                "audience": "Home brewers",
                "offer": "Fresh roasted coffee",
                "primaryAction": "Buy coffee",
                "requiredContent": [],
                "constraints": [],
                "brandInputs": [],
                "creativeControl": "Agent decides",
                "explicitAnswers": [],
                "assumptions": [],
                "unresolved": []
            }
        }),
        json!({
            "version": 1,
            "creativeDirection": {
                "summary": "Warm precision.",
                "keywords": ["warm", "focused"],
                "avoid": ["generic gradients"]
            },
            "colorPalette": [{"name": "Ink", "value": "#171512", "usage": "Text"}],
            "typefaces": [{
                "family": "Inter",
                "source": "Project",
                "roles": ["UI"],
                "weights": [400, 600]
            }],
            "interfaceDirection": "Editorial commerce.",
            "imageDirection": {
                "summary": "Coffee in context.",
                "subjects": ["coffee"],
                "treatment": "Natural light.",
                "avoid": ["stock poses"]
            },
            "motionDirection": {
                "summary": "Fast tactile feedback.",
                "principles": ["interruptible"],
                "avoid": ["decorative loops"]
            },
            "voice": {"summary": "Direct.", "avoid": ["hype"]}
        }),
        json!({
            "version": 1,
            "page": {"title": "Fresh Coffee", "route": "/", "description": "Coffee."},
            "navigation": [{"label": "Shop", "target": "#shop"}],
            "sections": [{
                "id": "hero",
                "purpose": "Lead the offer.",
                "copy": {
                    "heading": "Fresh coffee, delivered.",
                    "body": ["Roasted for home brewers."],
                    "callsToAction": [{"label": "Buy coffee", "target": "#shop"}]
                },
                "layout": "Editorial split.",
                "componentNeeds": [],
                "assetNeeds": []
            }],
            "responsive": ["Stack the hero on narrow screens."],
            "interactions": ["Anchor navigation."],
            "acceptanceCriteria": ["The primary action is visible."]
        }),
        json!({"version": 1, "assets": []}),
        json!({
            "status": "complete",
            "summary": "Implemented the page.",
            "files": ["index.html"],
            "checks": ["local check passed"]
        }),
        json!({
            "version": 1,
            "command": "node",
            "args": ["preview.mjs"],
            "cwd": ".",
            "url": format!("http://127.0.0.1:{preview_port}"),
            "viewports": [{"name": "desktop", "width": 1440, "height": 1000}]
        }),
    ];
    let session = runtime.session();
    for (index, output) in outputs.iter().enumerate() {
        session.complete_with_output(&format!("turn-{}", index + 1), &output.to_string());
        if index + 1 < outputs.len() {
            wait_for_sent_count(&session, index + 2);
        }
    }

    let completion = read_until_matching(&mut socket, |frame| {
        frame["channel"] == "thread.event"
            && frame["data"]["event"]["type"] == "item.completed"
            && frame["data"]["event"]["item"]["text"]
                .as_str()
                .is_some_and(|text| text.starts_with("Website built."))
    });
    assert_eq!(
        completion["data"]["event"]["item"]["text"],
        format!(
            "Website built. Preview ready at http://127.0.0.1:{preview_port}/. Visual review skipped because the selected provider does not declare image support."
        )
    );
    wait_for_sent_count(&session, 7);

    let sent_texts = session.sent_texts.lock().unwrap().clone();
    assert!(sent_texts[0].contains("Personal Harness Design Briefing mode"));
    assert!(sent_texts[1].contains("Brand phase"));
    assert!(sent_texts[2].contains("Page Blueprint phase"));
    assert!(sent_texts[3].contains("Asset phase"));
    assert!(sent_texts[4].contains("Build phase"));
    assert!(sent_texts[5].contains("Preview Setup phase"));
    assert_eq!(sent_texts[6], "Continue normally.");
    let sent_options = session.sent_options.lock().unwrap();
    for options in &sent_options[..6] {
        assert_eq!(options.model.as_deref(), Some("design-model"));
        assert_eq!(options.service_tier.as_deref(), Some("priority"));
        assert_eq!(options.effort.as_deref(), Some("low"));
    }
    let sent_attachments = session.sent_attachments.lock().unwrap();
    assert_eq!(sent_attachments[0], ["/repo/reference.png"]);
    assert!(sent_attachments[1..6].iter().all(Vec::is_empty));

    send_request(
        &mut socket,
        "design-history",
        "thread.history",
        json!({ "threadId": "thread-1" }),
    );
    let (_, history) = read_until_response(&mut socket, "design-history");
    let events = history["result"]["events"].as_array().unwrap();
    let activities = events
        .iter()
        .filter_map(|entry| {
            let event = &entry["event"];
            (event["type"] == "item.started")
                .then(|| event["item"]["text"].as_str())
                .flatten()
                .filter(|text| text.starts_with("design:"))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        activities,
        [
            "design:brief",
            "design:brand",
            "design:page",
            "design:assets",
            "design:build",
            "design:preview"
        ]
    );
    for output in &outputs {
        let output = output.to_string();
        assert!(!events.iter().any(|entry| {
            entry["event"]["item"]["role"] == "assistant"
                && entry["event"]["item"]["text"] == output
        }));
    }

    let mut artifacts = fs::read_dir(workspace.join(".taste"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    artifacts.sort();
    assert_eq!(
        artifacts,
        ["assets.json", "brand.json", "brief.json", "page.json"]
    );

    socket.close(None).unwrap();
    server.close().unwrap();
    let store = Store::open(directory.path().join("harness.db")).unwrap();
    assert!(store.design_run("thread-1").unwrap().is_none());
    store.close().unwrap();
    assert!(std::net::TcpListener::bind(("127.0.0.1", preview_port)).is_ok());
}

#[test]
fn design_mode_recovers_questions_without_forwarding_them_to_the_provider() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (directory, server) = start_test_server_with_runtimes(registry);
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(
        &mut socket,
        "question-start",
        "thread.start",
        json!({
            "provider": "codex",
            "workspacePath": workspace.to_string_lossy()
        }),
    );
    let _ = read_until_response(&mut socket, "question-start");
    send_request(
        &mut socket,
        "question-design",
        "thread.sendTurn",
        json!({
            "threadId": "thread-1",
            "text": "Build a studio site.",
            "attachments": [harness_design_agent::DESIGN_BRIEF_ATTACHMENT],
            "model": "question-model",
            "effort": "xhigh"
        }),
    );
    let _ = read_until_response(&mut socket, "question-design");

    let session = runtime.session();
    session.complete_with_output("turn-1", "not json");
    wait_for_sent_count(&session, 2);
    assert!(session.sent_texts.lock().unwrap()[1].contains("failed validation"));
    session.complete_with_output(
        "turn-2",
        &json!({
            "status": "questions",
            "message": "Preparing questions.",
            "questions": [{
                "id": "audience",
                "header": "Audience",
                "question": "Who is this for?",
                "allowOther": true,
                "options": [{
                    "label": "Independent founders (Recommended)",
                    "description": "A focused commercial audience."
                }]
            }],
            "brief": null
        })
        .to_string(),
    );
    let question = read_until_matching(&mut socket, |frame| {
        frame["channel"] == "thread.event"
            && frame["data"]["event"]["type"] == "user_input.requested"
            && frame["data"]["event"]["request"]["questions"][0]["id"] == "audience"
    });
    let question_id = question["data"]["event"]["request"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    send_request(
        &mut socket,
        "answer-audience",
        "thread.respondToUserInput",
        json!({
            "threadId": "thread-1",
            "requestId": question_id,
            "answers": {"audience": ["Independent founders"]}
        }),
    );
    let _ = read_until_response(&mut socket, "answer-audience");
    wait_for_sent_count(&session, 3);
    assert!(session.sent_texts.lock().unwrap()[2].contains("Independent founders"));

    session.complete_with_output(
        "turn-3",
        &json!({
            "status": "complete",
            "message": "Brief complete.",
            "questions": [],
            "brief": {
                "originalRequest": "Build a studio site.",
                "subject": "Independent studio",
                "pageType": "Marketing site",
                "scope": "Single responsive page",
                "primaryGoal": "Generate enquiries",
                "audience": "Independent founders",
                "offer": "Design services",
                "primaryAction": "Start a project",
                "requiredContent": [],
                "constraints": [],
                "brandInputs": [],
                "creativeControl": "Agent-led",
                "explicitAnswers": [],
                "assumptions": [],
                "unresolved": []
            }
        })
        .to_string(),
    );
    let final_question = read_until_matching(&mut socket, |frame| {
        frame["channel"] == "thread.event"
            && frame["data"]["event"]["type"] == "user_input.requested"
            && frame["data"]["event"]["request"]["questions"][0]["id"] == "final_note"
    });
    let final_question_id = final_question["data"]["event"]["request"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    send_request(
        &mut socket,
        "answer-final",
        "thread.respondToUserInput",
        json!({
            "threadId": "thread-1",
            "requestId": final_question_id,
            "answers": {"final_note": ["No, that's everything (Recommended)"]}
        }),
    );
    let _ = read_until_response(&mut socket, "answer-final");
    wait_for_sent_count(&session, 4);
    assert!(session.sent_texts.lock().unwrap()[3].contains("Brand phase"));
    assert!(session.user_inputs.lock().unwrap().is_empty());
    assert!(
        session
            .sent_attachments
            .lock()
            .unwrap()
            .iter()
            .all(Vec::is_empty)
    );
    for options in session.sent_options.lock().unwrap().iter() {
        assert_eq!(options.model.as_deref(), Some("question-model"));
        assert_eq!(options.effort.as_deref(), Some("low"));
    }
    let brief: Value = serde_json::from_str(
        &fs::read_to_string(workspace.join(".taste").join("brief.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        brief["explicitAnswers"],
        json!([{"question": "Who is this for?", "answer": "Independent founders"}])
    );

    session.handlers.emit_event(DomainEvent::ThreadError {
        thread_id: "thread-1".into(),
        message: "provider failed".into(),
    });
    send_request(
        &mut socket,
        "normal-after-error",
        "thread.sendTurn",
        json!({"threadId": "thread-1", "text": "Continue normally."}),
    );
    let (_, normal) = read_until_response(&mut socket, "normal-after-error");
    assert_eq!(normal["result"]["queued"], false);
    wait_for_sent_count(&session, 5);
    assert_eq!(session.sent_texts.lock().unwrap()[4], "Continue normally.");

    socket.close(None).unwrap();
    server.close().unwrap();
    let store = Store::open(directory.path().join("harness.db")).unwrap();
    assert!(store.design_run("thread-1").unwrap().is_none());
    store.close().unwrap();
}

#[test]
fn design_mode_not_design_verdict_completes_activity_and_releases_the_thread() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (directory, server) = start_test_server_with_runtimes(registry);
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(
        &mut socket,
        "not-design-start",
        "thread.start",
        json!({
            "provider": "codex",
            "workspacePath": workspace.to_string_lossy()
        }),
    );
    let _ = read_until_response(&mut socket, "not-design-start");
    send_request(
        &mut socket,
        "not-design-turn",
        "thread.sendTurn",
        json!({
            "threadId": "thread-1",
            "text": "Explain this Rust type.",
            "attachments": [harness_design_agent::DESIGN_BRIEF_ATTACHMENT]
        }),
    );
    let _ = read_until_response(&mut socket, "not-design-turn");
    let session = runtime.session();
    session.complete_with_output(
        "turn-1",
        &json!({
            "status": "not_design",
            "message": "This is not a website design task.",
            "questions": [],
            "brief": null
        })
        .to_string(),
    );
    send_request(
        &mut socket,
        "after-not-design",
        "thread.sendTurn",
        json!({"threadId": "thread-1", "text": "Continue normally."}),
    );
    let (_, response) = read_until_response(&mut socket, "after-not-design");
    assert_eq!(response["result"]["queued"], false);
    wait_for_sent_count(&session, 2);

    send_request(
        &mut socket,
        "not-design-history",
        "thread.history",
        json!({"threadId": "thread-1"}),
    );
    let (_, history) = read_until_response(&mut socket, "not-design-history");
    let activities = history["result"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| {
            let item = &entry["event"]["item"];
            if item["text"] == "design:brief" {
                Some((entry["event"]["type"].as_str()?, item["status"].as_str()?))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(
        activities,
        [("item.started", "started"), ("item.completed", "completed")]
    );

    socket.close(None).unwrap();
    server.close().unwrap();
    let store = Store::open(directory.path().join("harness.db")).unwrap();
    assert!(store.design_run("thread-1").unwrap().is_none());
    store.close().unwrap();
}

#[test]
fn persisted_design_mode_resumes_before_a_new_prompt() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let workspace = tempfile::tempdir().unwrap();
    harness_design_agent::write_design_brief(
        workspace.path(),
        &json!({
            "originalRequest": "Build a studio site.",
            "subject": "Studio",
            "pageType": "Marketing site",
            "scope": "Single page",
            "primaryGoal": "Generate enquiries",
            "audience": "Prospective clients",
            "offer": "Design services",
            "primaryAction": "Start a project",
            "requiredContent": [],
            "constraints": [],
            "brandInputs": [],
            "creativeControl": "Agent-led",
            "explicitAnswers": [],
            "assumptions": [],
            "unresolved": []
        }),
    )
    .unwrap();
    let workspace_path = workspace.path().to_string_lossy().into_owned();
    let stored_workspace = workspace_path.clone();
    let (directory, server) = start_test_server_with_runtimes_and_seed(registry, move |store| {
        store.add_project(&stored_workspace, None).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "persisted-design".into(),
                project_path: stored_workspace,
                provider: ProviderId::Codex,
                agent: None,
                title: "Persisted design".into(),
                created_at: Some(1_000),
                worktree_path: None,
                worktree_branch: None,
            })
            .unwrap();
        store
            .set_design_run(
                "persisted-design",
                &json!({
                    "workspacePath": "ignored-stale-path",
                    "originalRequest": "Build a studio site.",
                    "options": {
                        "model": "shared-model",
                        "serviceTier": "priority",
                        "effort": "low"
                    },
                    "phase": "brand",
                    "askedQuestions": false,
                    "finalAsked": false,
                    "explicitAnswers": []
                }),
            )
            .unwrap();
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(
        &mut socket,
        "resume-design",
        "thread.sendTurn",
        json!({
            "threadId": "persisted-design",
            "text": "Do this after Design Mode."
        }),
    );
    let (_, response) = read_until_response(&mut socket, "resume-design");
    assert_eq!(response["result"]["queued"], true);
    assert_eq!(
        response["result"]["queuedTurn"]["text"],
        "Do this after Design Mode."
    );

    let session = runtime.session();
    wait_for_sent_count(&session, 1);
    assert_eq!(runtime.resume_count.load(Ordering::Acquire), 1);
    assert!(session.sent_texts.lock().unwrap()[0].contains("Brand phase"));
    assert_eq!(
        session.sent_options.lock().unwrap()[0],
        TurnOptions {
            model: Some("shared-model".into()),
            service_tier: Some("priority".into()),
            effort: Some("low".into())
        }
    );

    socket.close(None).unwrap();
    server.close().unwrap();
    let store = Store::open(directory.path().join("harness.db")).unwrap();
    let stored = store.design_run("persisted-design").unwrap().unwrap();
    assert_eq!(stored["phase"], "brand");
    assert_eq!(stored["workspacePath"], workspace_path);
    store.close().unwrap();
}

#[test]
fn turn_completion_before_start_response_does_not_leave_thread_running() {
    let runtime = Arc::new(FakeRuntime::default());
    runtime.complete_during_send.store(true, Ordering::Release);
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (directory, server) = start_test_server_with_runtimes(registry);
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(
        &mut socket,
        "start",
        "thread.start",
        json!({
            "provider": "codex",
            "workspacePath": workspace.to_string_lossy()
        }),
    );
    let _ = read_until_response(&mut socket, "start");
    send_request(
        &mut socket,
        "turn",
        "thread.sendTurn",
        json!({ "threadId": "thread-1", "text": "Finish synchronously" }),
    );
    let (_, response) = read_until_response(&mut socket, "turn");
    assert_eq!(response["result"]["turnId"], "turn-1");
    send_request(
        &mut socket,
        "history",
        "thread.history",
        json!({ "threadId": "thread-1" }),
    );
    let (_, history) = read_until_response(&mut socket, "history");
    assert_eq!(history["result"]["running"], false);
}

#[test]
fn concurrent_requests_resume_one_provider_session() {
    let runtime = Arc::new(FakeRuntime::default());
    runtime.resume_delay_ms.store(100, Ordering::Release);
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let workspace = tempfile::tempdir().unwrap();
    let workspace_path = workspace.path().to_string_lossy().into_owned();
    let stored_path = workspace_path.clone();
    let (_directory, server) = start_test_server_with_runtimes_and_seed(registry, move |store| {
        store.add_project(&stored_path, None).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "thread-resume".into(),
                project_path: stored_path,
                provider: ProviderId::Codex,
                agent: None,
                title: "Resume".into(),
                created_at: Some(1_000),
                worktree_path: None,
                worktree_branch: None,
            })
            .unwrap();
    });
    let mut first = connect_native(&server, "");
    let mut second = connect_native(&server, "");
    assert_welcome(&mut first);
    assert_welcome(&mut second);
    send_request(
        &mut first,
        "first",
        "thread.sendTurn",
        json!({ "threadId": "thread-resume", "text": "First" }),
    );
    send_request(
        &mut second,
        "second",
        "thread.sendTurn",
        json!({ "threadId": "thread-resume", "text": "Second" }),
    );
    let (_, first_response) = read_until_response(&mut first, "first");
    let (_, second_response) = read_until_response(&mut second, "second");
    assert_ne!(
        first_response["result"]["queued"],
        second_response["result"]["queued"]
    );
    assert_eq!(runtime.resume_count.load(Ordering::Acquire), 1);
    assert_eq!(runtime.sessions.lock().unwrap().len(), 1);
}

#[test]
fn live_auth_routes_reuse_control_and_preserve_login_event_order() {
    let runtime = Arc::new(FakeRuntime::default());
    runtime
        .complete_login_during_start
        .store(true, Ordering::Release);
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (_directory, server) = start_test_server_with_runtimes(registry);
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "status",
        "auth.status",
        json!({ "provider": "codex" }),
    );
    assert_eq!(
        read_value(&mut socket),
        json!({ "id": "status", "result": { "signedIn": false } })
    );

    send_request(
        &mut socket,
        "start",
        "auth.startLogin",
        json!({ "provider": "codex" }),
    );
    let (pushes, started) = read_until_response(&mut socket, "start");
    assert_eq!(pushes.len(), 1);
    assert_eq!(pushes[0]["channel"], "auth.event");
    assert_eq!(pushes[0]["data"]["provider"], "codex");
    assert_eq!(pushes[0]["data"]["loginId"], "login-1");
    assert_eq!(pushes[0]["data"]["success"], true);
    assert_eq!(started["result"]["loginId"], "login-1");
    assert_eq!(started["result"]["authUrl"], "https://auth.example/login-1");

    runtime
        .complete_login_during_start
        .store(false, Ordering::Release);
    send_request(
        &mut socket,
        "start-later",
        "auth.startLogin",
        json!({ "provider": "codex" }),
    );
    let (_, started_later) = read_until_response(&mut socket, "start-later");
    assert_eq!(started_later["result"]["loginId"], "login-2");
    runtime
        .control()
        .complete_login("login-2", false, Some("Login cancelled"));
    let later_push = read_value(&mut socket);
    assert_eq!(later_push["channel"], "auth.event");
    assert_eq!(later_push["data"]["loginId"], "login-2");
    assert_eq!(later_push["data"]["success"], false);
    assert_eq!(later_push["data"]["error"], "Login cancelled");

    send_request(
        &mut socket,
        "cancel",
        "auth.cancelLogin",
        json!({ "provider": "codex", "loginId": "login-2" }),
    );
    assert_eq!(
        read_value(&mut socket),
        json!({ "id": "cancel", "result": {} })
    );
    let test_key = "test-only-api-key";
    send_request(
        &mut socket,
        "api-key",
        "auth.useApiKey",
        json!({ "provider": "codex", "apiKey": test_key }),
    );
    assert_eq!(
        read_value(&mut socket)["result"],
        json!({ "signedIn": true, "plan": "API key" })
    );
    let control = runtime.control();
    assert_eq!(control.cancelled.lock().unwrap().as_slice(), ["login-2"]);
    assert_eq!(control.api_keys.lock().unwrap().as_slice(), [test_key]);

    send_request(
        &mut socket,
        "sign-out",
        "auth.signOut",
        json!({ "provider": "codex" }),
    );
    assert_eq!(
        read_value(&mut socket),
        json!({ "id": "sign-out", "result": {} })
    );
    assert_eq!(runtime.control_open_count.load(Ordering::Acquire), 1);

    send_request(
        &mut socket,
        "bad-agent",
        "auth.status",
        json!({ "provider": "codex", "agent": "" }),
    );
    assert_eq!(read_value(&mut socket)["error"]["code"], "bad_request");
    send_request(
        &mut socket,
        "bad-key",
        "auth.useApiKey",
        json!({ "provider": "codex", "apiKey": "" }),
    );
    assert_eq!(read_value(&mut socket)["error"]["code"], "bad_request");

    socket.close(None).unwrap();
    server.close().unwrap();
    assert!(control.disposed.load(Ordering::Acquire));
}

#[test]
fn concurrent_auth_requests_open_one_provider_control() {
    let runtime = Arc::new(FakeRuntime::default());
    runtime.control_delay_ms.store(100, Ordering::Release);
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (_directory, server) = start_test_server_with_runtimes(registry);
    let mut first = connect_native(&server, "");
    let mut second = connect_native(&server, "");
    assert_welcome(&mut first);
    assert_welcome(&mut second);

    send_request(
        &mut first,
        "first",
        "auth.status",
        json!({ "provider": "codex" }),
    );
    send_request(
        &mut second,
        "second",
        "auth.status",
        json!({ "provider": "codex" }),
    );
    assert_eq!(read_value(&mut first)["result"]["signedIn"], false);
    assert_eq!(read_value(&mut second)["result"]["signedIn"], false);
    assert_eq!(runtime.control_open_count.load(Ordering::Acquire), 1);
    assert_eq!(runtime.controls.lock().unwrap().len(), 1);
}

#[test]
fn one_slow_request_does_not_block_later_requests_on_the_same_connection() {
    let runtime = Arc::new(FakeRuntime::default());
    runtime.model_delay_ms.store(250, Ordering::Release);
    let runtimes = Arc::new(FakeRuntimes { runtime });
    let (_directory, server) = start_test_server_with_runtimes(runtimes);
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "models",
        "models.list",
        json!({ "provider": "codex" }),
    );
    send_request(&mut socket, "system", "system.info", json!({}));

    assert_eq!(read_value(&mut socket)["id"], "system");
    assert_eq!(read_value(&mut socket)["id"], "models");
    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_voice_routes_report_provider_support_and_cancel_on_the_same_connection() {
    let runtime = Arc::new(FakeRuntime::default());
    let runtimes = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (_directory, server) = start_test_server_with_runtimes(runtimes);
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "unsupported",
        "voice.status",
        json!({ "provider": "claude-code" }),
    );
    assert_eq!(
        read_value(&mut socket)["result"],
        json!({ "available": false, "reason": "provider_unsupported" })
    );
    send_request(
        &mut socket,
        "status",
        "voice.status",
        json!({ "provider": "codex" }),
    );
    assert_eq!(
        read_value(&mut socket)["result"],
        json!({ "available": true })
    );
    let control = runtime.control();
    let request_id = "00000000-0000-4000-8000-000000000001";
    send_request(
        &mut socket,
        "transcribe",
        "voice.transcribe",
        json!({
            "requestId": request_id,
            "provider": "codex",
            "audioBase64": "AA==",
            "mimeType": "audio/wav",
            "sampleRateHz": 24_000,
            "durationMs": 1
        }),
    );
    let deadline = Instant::now() + Duration::from_secs(1);
    while !control.voice_started.load(Ordering::Acquire) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(control.voice_started.load(Ordering::Acquire));
    send_request(
        &mut socket,
        "cancel",
        "voice.cancel",
        json!({ "requestId": request_id }),
    );

    let first = read_value(&mut socket);
    let second = read_value(&mut socket);
    let responses = HashMap::from([
        (first["id"].as_str().unwrap().to_owned(), first),
        (second["id"].as_str().unwrap().to_owned(), second),
    ]);
    assert_eq!(responses["cancel"]["result"], json!({}));
    assert_eq!(responses["transcribe"]["error"]["code"], "internal");
    assert_eq!(
        responses["transcribe"]["error"]["message"],
        "Voice transcription was cancelled."
    );

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_preview_capture_round_trips_through_the_capable_client() {
    let (_directory, server) = start_test_server(None, |_| {});
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(
        &mut socket,
        "capability",
        "client.capabilities",
        json!({ "previewCapture": true }),
    );
    assert_eq!(
        read_value(&mut socket),
        json!({ "id": "capability", "result": {} })
    );

    let state = Arc::clone(&server.state);
    let capture = std::thread::spawn(move || {
        state.preview_capture.capture(
            "http://127.0.0.1:5173/".into(),
            vec![harness_protocol::PreviewViewport {
                width: 390,
                height: 844,
            }],
        )
    });
    let requested = read_value(&mut socket);
    assert_eq!(requested["channel"], "preview.captureRequested");
    assert_eq!(requested["data"]["url"], "http://127.0.0.1:5173/");
    let request_id = requested["data"]["requestId"].as_str().unwrap();
    send_request(
        &mut socket,
        "capture-result",
        "preview.captureResult",
        json!({
            "status": "completed",
            "requestId": request_id,
            "screenshots": [{
                "path": "/tmp/preview-mobile.png",
                "width": 390,
                "height": 844
            }]
        }),
    );
    assert_eq!(
        read_value(&mut socket),
        json!({ "id": "capture-result", "result": {} })
    );
    assert_eq!(capture.join().unwrap().unwrap()[0].width, 390);

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_connection_routes_keep_api_keys_only_in_the_credential_store() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes { runtime });
    let credentials = Arc::new(MemoryCredentials::default());
    let (directory, server) = start_test_server_with_services(registry, credentials.clone());
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(&mut socket, "empty", "connections.list", json!({}));
    assert_eq!(read_value(&mut socket)["result"]["connections"], json!([]));
    send_request(
        &mut socket,
        "upsert",
        "connections.upsert",
        json!({
            "id": "work-openrouter",
            "displayName": "  Work OpenRouter  ",
            "preset": "openrouter",
            "transport": "openai-compatible",
            "baseUrl": "https://openrouter.ai/api/v1",
            "defaultModel": "openai/gpt-5.6",
            "enabled": true
        }),
    );
    let upserted = read_value(&mut socket);
    assert_eq!(
        upserted["result"]["connection"]["displayName"],
        "Work OpenRouter"
    );
    assert_eq!(
        upserted["result"]["connection"]["credentialConfigured"],
        false
    );
    assert_eq!(
        upserted["result"]["connection"]["capabilities"]["streaming"],
        true
    );

    send_request(
        &mut socket,
        "credential",
        "connections.setCredential",
        json!({
            "connectionId": "work-openrouter",
            "apiKey": "secret-test-key"
        }),
    );
    assert_eq!(
        read_value(&mut socket)["result"]["credentialConfigured"],
        true
    );
    let raw = std::fs::read_to_string(directory.path().join("providers.json")).unwrap();
    assert!(!raw.contains("secret-test-key"));
    assert!(raw.contains("model-connections/work-openrouter"));
    assert_eq!(
        credentials
            .read("model-connections/work-openrouter")
            .unwrap(),
        "secret-test-key"
    );

    let (model_base_url, model_request, model_server) = serve_json_once(json!({
        "data": [{ "id": "model-b" }, { "id": "model-a" }]
    }));
    send_request(
        &mut socket,
        "local-endpoint",
        "connections.upsert",
        json!({
            "id": "work-openrouter",
            "displayName": "Work OpenRouter",
            "preset": "openrouter",
            "transport": "openai-compatible",
            "baseUrl": model_base_url,
            "defaultModel": "model-b",
            "enabled": true
        }),
    );
    assert_eq!(
        read_value(&mut socket)["result"]["connection"]["credentialConfigured"],
        true
    );
    send_request(
        &mut socket,
        "models",
        "connections.models",
        json!({ "connectionId": "work-openrouter" }),
    );
    let models = read_value(&mut socket);
    assert_eq!(models["result"]["models"][0]["id"], "model-a");
    assert_eq!(models["result"]["models"][1]["isDefault"], true);
    assert!(
        model_request
            .recv()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization: bearer secret-test-key")
    );
    model_server.join().unwrap();

    send_request(&mut socket, "list", "connections.list", json!({}));
    assert_eq!(
        read_value(&mut socket)["result"]["connections"][0]["credentialConfigured"],
        true
    );
    send_request(
        &mut socket,
        "unsafe",
        "connections.upsert",
        json!({
            "id": "unsafe",
            "displayName": "Unsafe",
            "preset": "custom",
            "transport": "openai-compatible",
            "baseUrl": "http://example.com/v1",
            "enabled": true
        }),
    );
    assert_eq!(read_value(&mut socket)["error"]["code"], "bad_request");

    send_request(
        &mut socket,
        "remove",
        "connections.remove",
        json!({ "connectionId": "work-openrouter" }),
    );
    assert_eq!(read_value(&mut socket)["result"], json!({}));
    assert!(!credentials.contains("model-connections/work-openrouter"));

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_native_api_runtime_streams_through_the_shared_server() {
    let stream = concat!(
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Checking.\",\"content\":\"Hello from Rust.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"total_tokens\":14}}\n\n",
        "data: [DONE]\n\n"
    );
    let (base_url, provider_request, provider_server) = serve_sse_once(stream.into());
    let (directory, server, credentials) = start_test_server_with_native_runtimes();
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("README.md"), "# Native\n").unwrap();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "upsert",
        "connections.upsert",
        json!({
            "id": "local-compatible",
            "displayName": "Local Compatible",
            "preset": "custom",
            "transport": "openai-compatible",
            "baseUrl": base_url,
            "defaultModel": "test-model",
            "enabled": true
        }),
    );
    assert_eq!(
        read_value(&mut socket)["result"]["connection"]["id"],
        "local-compatible"
    );
    send_request(
        &mut socket,
        "credential",
        "connections.setCredential",
        json!({
            "connectionId": "local-compatible",
            "apiKey": "secret-live-key"
        }),
    );
    assert_eq!(
        read_value(&mut socket)["result"]["credentialConfigured"],
        true
    );
    assert_eq!(
        credentials
            .read("model-connections/local-compatible")
            .unwrap(),
        "secret-live-key"
    );

    send_request(
        &mut socket,
        "start",
        "thread.start",
        json!({
            "provider": "api",
            "connectionId": "local-compatible",
            "workspacePath": workspace.to_string_lossy(),
            "approval": "full"
        }),
    );
    let (_, started) = read_until_response(&mut socket, "start");
    let thread_id = started["result"]["threadId"].as_str().unwrap().to_owned();
    assert!(thread_id.starts_with("api-"));

    send_request(
        &mut socket,
        "turn",
        "thread.sendTurn",
        json!({ "threadId": thread_id, "text": "Say hello" }),
    );
    let (mut pushes, turn) = read_until_response(&mut socket, "turn");
    let turn_id = turn["result"]["turnId"].as_str().unwrap().to_owned();
    while !pushes.iter().any(|push| {
        push["channel"] == "thread.event"
            && push["data"]["event"]["type"] == "turn.completed"
            && push["data"]["event"]["turnId"] == turn_id
    }) {
        pushes.push(read_value(&mut socket));
    }
    let message_id = pushes
        .iter()
        .find(|push| {
            push["channel"] == "thread.event"
                && push["data"]["event"]["type"] == "item.completed"
                && push["data"]["event"]["item"]["type"] == "message"
        })
        .and_then(|push| push["data"]["event"]["item"]["id"].as_str())
        .unwrap();
    let streamed = pushes
        .iter()
        .filter(|push| {
            push["channel"] == "thread.event"
                && push["data"]["event"]["type"] == "item.delta"
                && push["data"]["event"]["itemId"] == message_id
        })
        .filter_map(|push| push["data"]["event"]["textDelta"].as_str())
        .collect::<String>();
    assert_eq!(streamed, "Hello from Rust.");
    assert!(pushes.iter().any(|push| {
        push["channel"] == "thread.event"
            && push["data"]["event"]["type"] == "usage.updated"
            && push["data"]["event"]["usage"]["totalTokens"].as_f64() == Some(14.0)
    }));

    let request = provider_request
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer secret-live-key")
    );
    let request_body = request.split("\r\n\r\n").nth(1).unwrap();
    assert!(!request_body.contains("secret-live-key"));
    let request_body: Value = serde_json::from_str(request_body).unwrap();
    assert_eq!(request_body["model"], "test-model");
    assert_eq!(request_body["tools"].as_array().unwrap().len(), 4);
    assert!(
        request_body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("Say hello")
    );
    provider_server.join().unwrap();

    send_request(
        &mut socket,
        "history",
        "thread.history",
        json!({ "threadId": thread_id }),
    );
    let (_, history) = read_until_response(&mut socket, "history");
    assert!(
        history["result"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["event"]["type"] == "item.completed"
                    && entry["event"]["item"]["text"] == "Hello from Rust."
            })
    );

    send_request(
        &mut socket,
        "close",
        "thread.close",
        json!({ "threadId": thread_id }),
    );
    let (_, closed) = read_until_response(&mut socket, "close");
    assert_eq!(closed["result"], json!({}));
    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn native_api_sessions_resume_identity_history_and_permissions_after_restart() {
    let first_response = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"First response.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let write_response = concat!(
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-resume\",\"type\":\"function\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"resumed.txt\\\",\\\"content\\\":\\\"restored state\\\\n\\\",\\\"expectedSha256\\\":null}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let final_response = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Resumed successfully.\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let (base_url, provider_requests, provider_server) = serve_sse(vec![
        first_response.into(),
        write_response.into(),
        final_response.into(),
    ]);
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let credentials = Arc::new(MemoryCredentials::default());

    let bootstrap_server = start_native_server_in(directory.path(), Arc::clone(&credentials));
    let mut bootstrap_socket = connect_native(&bootstrap_server, "");
    assert_welcome(&mut bootstrap_socket);
    send_request(
        &mut bootstrap_socket,
        "upsert",
        "connections.upsert",
        json!({
            "id": "restart-compatible",
            "displayName": "Restart Compatible",
            "preset": "custom",
            "transport": "openai-compatible",
            "baseUrl": base_url,
            "defaultModel": "connection-default",
            "enabled": true
        }),
    );
    assert_eq!(
        read_value(&mut bootstrap_socket)["result"]["connection"]["id"],
        "restart-compatible"
    );
    send_request(
        &mut bootstrap_socket,
        "credential",
        "connections.setCredential",
        json!({
            "connectionId": "restart-compatible",
            "apiKey": "restart-secret-key"
        }),
    );
    assert_eq!(
        read_value(&mut bootstrap_socket)["result"]["credentialConfigured"],
        true
    );
    send_request(
        &mut bootstrap_socket,
        "start",
        "thread.start",
        json!({
            "provider": "api",
            "connectionId": "restart-compatible",
            "workspacePath": workspace.to_string_lossy(),
            "model": "persisted-model",
            "approval": "full"
        }),
    );
    let (_, started) = read_until_response(&mut bootstrap_socket, "start");
    let thread_id = started["result"]["threadId"].as_str().unwrap().to_owned();
    bootstrap_socket.close(None).unwrap();
    bootstrap_server.close().unwrap();

    let initial = Store::open(directory.path().join("harness.db")).unwrap();
    let initial_state = initial.provider_session_state(&thread_id).unwrap().unwrap();
    assert_eq!(initial_state["turn_counter"], 0);
    assert_eq!(initial_state["instructions_pending"], true);
    assert!(
        initial_state["instructions"]
            .as_str()
            .unwrap()
            .contains("Lead with the useful answer")
    );
    initial.close().unwrap();

    let first_server = start_native_server_in(directory.path(), Arc::clone(&credentials));
    let mut first_socket = connect_native(&first_server, "");
    assert_welcome(&mut first_socket);
    send_request(
        &mut first_socket,
        "first-turn",
        "thread.sendTurn",
        json!({ "threadId": thread_id, "text": "Remember this first turn" }),
    );
    let (mut first_pushes, first_turn) = read_until_response(&mut first_socket, "first-turn");
    let first_turn_id = first_turn["result"]["turnId"].as_str().unwrap().to_owned();
    while !first_pushes.iter().any(|push| {
        push["channel"] == "thread.event"
            && push["data"]["event"]["type"] == "turn.completed"
            && push["data"]["event"]["turnId"] == first_turn_id
    }) {
        first_pushes.push(read_value(&mut first_socket));
    }
    let first_request = provider_requests
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let first_body: Value =
        serde_json::from_str(first_request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(first_body["model"], "persisted-model");
    assert!(
        first_body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("Lead with the useful answer")
    );

    first_socket.close(None).unwrap();
    first_server.close().unwrap();

    let persisted = Store::open(directory.path().join("harness.db")).unwrap();
    assert_eq!(
        persisted.thread_connection_id(&thread_id).unwrap(),
        Some("restart-compatible".into())
    );
    let persisted_state = persisted
        .provider_session_state(&thread_id)
        .unwrap()
        .unwrap();
    assert_eq!(persisted_state["version"], 1);
    assert_eq!(persisted_state["model"], "persisted-model");
    assert_eq!(persisted_state["approval"], "full");
    assert_eq!(persisted_state["turn_counter"], 1);
    assert_eq!(persisted_state["instructions_pending"], false);
    persisted.close().unwrap();

    let second_server = start_native_server_in(directory.path(), Arc::clone(&credentials));
    let mut second_socket = connect_native(&second_server, "");
    assert_welcome(&mut second_socket);
    send_request(
        &mut second_socket,
        "change-default",
        "connections.upsert",
        json!({
            "id": "restart-compatible",
            "displayName": "Restart Compatible",
            "preset": "custom",
            "transport": "openai-compatible",
            "baseUrl": base_url,
            "defaultModel": "changed-default",
            "enabled": true
        }),
    );
    assert_eq!(
        read_value(&mut second_socket)["result"]["connection"]["defaultModel"],
        "changed-default"
    );
    send_request(
        &mut second_socket,
        "second-turn",
        "thread.sendTurn",
        json!({ "threadId": thread_id, "text": "Continue after restart" }),
    );
    let (mut second_pushes, second_turn) = read_until_response(&mut second_socket, "second-turn");
    let second_turn_id = second_turn["result"]["turnId"].as_str().unwrap().to_owned();
    assert!(second_turn_id.ends_with("-turn-2"));
    while !second_pushes.iter().any(|push| {
        push["channel"] == "thread.event"
            && push["data"]["event"]["type"] == "turn.completed"
            && push["data"]["event"]["turnId"] == second_turn_id
    }) {
        second_pushes.push(read_value(&mut second_socket));
    }
    assert!(!second_pushes.iter().any(|push| {
        push["channel"] == "thread.event" && push["data"]["event"]["type"] == "approval.requested"
    }));
    assert_eq!(
        fs::read_to_string(workspace.join("resumed.txt")).unwrap(),
        "restored state\n"
    );

    let resumed_request = provider_requests
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let resumed_body: Value =
        serde_json::from_str(resumed_request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(resumed_body["model"], "persisted-model");
    assert!(
        resumed_body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("Remember this first turn")
    );
    assert_eq!(resumed_body["messages"][1]["content"], "First response.");
    assert_eq!(
        resumed_body["messages"][2]["content"],
        "Continue after restart"
    );
    let tool_result_request = provider_requests
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let tool_result_body: Value =
        serde_json::from_str(tool_result_request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(tool_result_body["model"], "persisted-model");
    assert_eq!(
        tool_result_body["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["role"],
        "tool"
    );

    send_request(
        &mut second_socket,
        "close",
        "thread.close",
        json!({ "threadId": thread_id }),
    );
    let (_, closed) = read_until_response(&mut second_socket, "close");
    assert_eq!(closed["result"], json!({}));
    second_socket.close(None).unwrap();
    second_server.close().unwrap();
    provider_server.join().unwrap();
}

#[test]
fn live_mcp_and_skills_routes_share_control_and_push_invalidations() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (directory, server) = start_test_server_with_runtimes(registry);
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "mcp",
        "mcp.list",
        json!({ "provider": "codex", "projectPath": "/repo" }),
    );
    let mcp = read_value(&mut socket);
    assert_eq!(mcp["result"]["servers"][0]["id"], "docs");
    assert_eq!(mcp["result"]["capabilities"]["startOAuth"], true);

    send_request(
        &mut socket,
        "disable-docs",
        "mcp.add",
        json!({
            "provider": "codex",
            "projectPath": "/repo",
            "server": { "id": "docs", "enabled": false }
        }),
    );
    let (pushes, disabled) = read_until_response(&mut socket, "disable-docs");
    assert_eq!(pushes[0]["channel"], "mcp.changed");
    assert_eq!(pushes[0]["data"]["projectPath"], "/repo");
    assert_eq!(disabled["result"], json!({}));
    send_request(
        &mut socket,
        "mcp-disabled",
        "mcp.list",
        json!({ "provider": "codex", "projectPath": "/repo" }),
    );
    let disabled_inventory = read_value(&mut socket);
    let docs = &disabled_inventory["result"]["servers"][0];
    assert_eq!(docs["scope"], "project");
    assert_eq!(docs["enabled"], false);
    assert_eq!(docs["startup"]["state"], "stopped");

    let custom_server = json!({
        "id": "custom",
        "enabled": true,
        "displayName": "Custom",
        "transport": { "type": "http", "url": "https://example.com/mcp" }
    });
    send_request(
        &mut socket,
        "add-custom",
        "mcp.add",
        json!({
            "provider": "codex",
            "projectPath": "/repo",
            "server": custom_server
        }),
    );
    let _ = read_until_response(&mut socket, "add-custom");
    send_request(
        &mut socket,
        "duplicate",
        "mcp.add",
        json!({
            "provider": "codex",
            "projectPath": "/repo",
            "server": custom_server
        }),
    );
    assert_eq!(read_value(&mut socket)["error"]["code"], "internal");
    send_request(
        &mut socket,
        "bad-server",
        "mcp.add",
        json!({
            "provider": "codex",
            "projectPath": "/repo",
            "server": { "id": "missing-transport", "enabled": true }
        }),
    );
    assert_eq!(read_value(&mut socket)["error"]["code"], "bad_request");
    send_request(
        &mut socket,
        "update-custom",
        "mcp.update",
        json!({
            "provider": "codex",
            "projectPath": "/repo",
            "server": {
                "id": "custom",
                "enabled": true,
                "displayName": "Updated",
                "transport": { "type": "http", "url": "https://example.com/v2" }
            }
        }),
    );
    let _ = read_until_response(&mut socket, "update-custom");
    send_request(
        &mut socket,
        "mcp-updated",
        "mcp.list",
        json!({ "provider": "codex", "projectPath": "/repo" }),
    );
    let updated = read_value(&mut socket);
    let custom = updated["result"]["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|server| server["id"] == "custom")
        .unwrap();
    assert_eq!(custom["displayName"], "Updated");
    assert_eq!(custom["transport"]["url"], "https://example.com/v2");
    send_request(
        &mut socket,
        "remove-custom",
        "mcp.remove",
        json!({
            "provider": "codex",
            "projectPath": "/repo",
            "serverId": "custom"
        }),
    );
    let _ = read_until_response(&mut socket, "remove-custom");
    let config = std::fs::read_to_string(directory.path().join("mcp.json")).unwrap();
    assert!(config.contains("docs"));
    assert!(!config.contains("custom"));

    send_request(
        &mut socket,
        "skills",
        "skills.list",
        json!({ "provider": "codex", "projectPath": "/repo" }),
    );
    let skills = read_value(&mut socket);
    assert_eq!(skills["result"]["skills"][0]["name"], "docs");

    let skill_id = "/repo/.agents/skills/docs/SKILL.md";
    send_request(
        &mut socket,
        "toggle",
        "skills.setEnabled",
        json!({
            "provider": "codex",
            "projectPath": "/repo",
            "skillId": skill_id,
            "enabled": false
        }),
    );
    let (pushes, toggled) = read_until_response(&mut socket, "toggle");
    assert_eq!(pushes.len(), 1);
    assert_eq!(pushes[0]["channel"], "skills.changed");
    assert_eq!(pushes[0]["data"]["projectPath"], "/repo");
    assert_eq!(toggled["result"]["enabled"], false);
    assert_eq!(
        runtime.control().skill_toggles.lock().unwrap().as_slice(),
        [(skill_id.into(), false)]
    );
    assert_eq!(runtime.control_open_count.load(Ordering::Acquire), 1);

    let project = directory.path().join("skills-project");
    let source = directory.path().join("skill-source/review-skill");
    std::fs::create_dir_all(source.join("references")).unwrap();
    std::fs::create_dir(&project).unwrap();
    std::fs::write(source.join("SKILL.md"), "---\nname: review-skill\n---\n").unwrap();
    std::fs::write(source.join("references/notes.md"), "notes").unwrap();
    send_request(
        &mut socket,
        "install-skill",
        "skills.installFromFolder",
        json!({
            "provider": "codex",
            "projectPath": project,
            "folderPath": source
        }),
    );
    let (pushes, installed) = read_until_response(&mut socket, "install-skill");
    assert_eq!(pushes[0]["channel"], "skills.changed");
    assert_eq!(installed["result"]["skill"]["name"], "review-skill");
    assert_eq!(
        std::fs::read_to_string(project.join(".agents/skills/review-skill/references/notes.md"))
            .unwrap(),
        "notes"
    );
    send_request(
        &mut socket,
        "install-conflict",
        "skills.installFromFolder",
        json!({
            "provider": "codex",
            "projectPath": project,
            "folderPath": source
        }),
    );
    assert!(
        read_value(&mut socket)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("already exists")
    );

    send_request(
        &mut socket,
        "bad-project",
        "skills.list",
        json!({ "provider": "codex", "projectPath": "" }),
    );
    assert_eq!(read_value(&mut socket)["error"]["code"], "bad_request");
}

#[test]
fn unsupported_provider_management_is_typed_and_does_not_write_config() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (directory, server) = start_test_server_with_runtimes(registry);
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "mcp",
        "mcp.list",
        json!({ "provider": "claude-code", "projectPath": "/repo" }),
    );
    let mcp = read_value(&mut socket);
    assert_eq!(mcp["result"]["servers"], json!([]));
    assert_eq!(
        mcp["result"]["capabilities"],
        json!({
            "inventory": false,
            "add": false,
            "update": false,
            "remove": false,
            "reload": false,
            "startOAuth": false,
            "cancelOAuth": false
        })
    );

    send_request(
        &mut socket,
        "skills",
        "skills.list",
        json!({ "provider": "acp", "projectPath": "/repo" }),
    );
    let skills = read_value(&mut socket);
    assert_eq!(skills["result"]["skills"], json!([]));
    assert_eq!(skills["result"]["errors"], json!([]));
    assert_eq!(
        skills["result"]["capabilities"],
        json!({ "inventory": false, "configure": false, "install": false })
    );

    send_request(
        &mut socket,
        "add",
        "mcp.add",
        json!({
            "provider": "claude-code",
            "projectPath": "/repo",
            "server": {
                "id": "forbidden",
                "enabled": true,
                "transport": { "type": "http", "url": "https://example.com/mcp" }
            }
        }),
    );
    let add = read_value(&mut socket);
    assert_eq!(add["error"]["code"], "internal");
    assert!(
        add["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cannot add MCP servers")
    );
    assert_eq!(runtime.control_open_count.load(Ordering::Acquire), 0);
    assert!(!directory.path().join("mcp.json").exists());

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_transport_sends_welcome_drops_malformed_frames_and_reports_typed_errors() {
    let (_directory, server) = start_test_server(None, |_| {});
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    socket.send(Message::text("{not-json")).unwrap();
    send_request(&mut socket, "system", "system.info", json!({}));
    let system = read_value(&mut socket);
    assert_eq!(system["id"], "system");
    assert_eq!(system["result"]["serverVersion"], "0.0.0");
    assert_eq!(system["result"]["protocolVersion"], 2);
    assert!(matches!(
        system["result"]["platform"].as_str(),
        Some("darwin" | "linux" | "win32")
    ));

    send_request(&mut socket, "unknown", "constructor", json!({}));
    assert_eq!(
        read_value(&mut socket),
        json!({
            "id": "unknown",
            "error": {
                "code": "bad_request",
                "message": "unknown method: constructor"
            }
        })
    );
    send_request(
        &mut socket,
        "invalid",
        "search.sessions",
        json!({ "query": "   " }),
    );
    let invalid = read_value(&mut socket);
    assert_eq!(invalid["id"], "invalid");
    assert_eq!(invalid["error"]["code"], "bad_request");
    assert_eq!(
        invalid["error"]["message"],
        "invalid params for search.sessions"
    );

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_mcp_session_routes_apply_config_reload_and_preserve_oauth_push_order() {
    let runtime = Arc::new(FakeRuntime::default());
    runtime
        .complete_mcp_o_auth_during_start
        .store(true, Ordering::Release);
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let credentials = Arc::new(MemoryCredentials::default());
    credentials.write("mcp/custom/token", "mcp-secret").unwrap();
    let (directory, server) = start_test_server_with_services(registry, credentials);
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let workspace = workspace.to_string_lossy().into_owned();
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "add",
        "mcp.add",
        json!({
            "provider": "codex",
            "projectPath": workspace,
            "server": {
                "id": "custom",
                "enabled": true,
                "transport": {
                    "type": "http",
                    "url": "https://example.com/mcp",
                    "headers": {
                        "Authorization": {
                            "source": "credential",
                            "credentialRef": "mcp/custom/token"
                        }
                    }
                }
            }
        }),
    );
    let _ = read_until_response(&mut socket, "add");

    send_request(
        &mut socket,
        "start",
        "thread.start",
        json!({ "provider": "codex", "workspacePath": workspace }),
    );
    let _ = read_until_response(&mut socket, "start");
    let options = runtime.start_options.lock().unwrap().clone().unwrap();
    assert_eq!(options.mcp_servers.len(), 1);
    assert_eq!(options.mcp_servers[0].id, "custom");
    assert_eq!(
        options.mcp_credentials.get("mcp/custom/token"),
        Some("mcp-secret")
    );
    assert!(
        !std::fs::read_to_string(directory.path().join("mcp.json"))
            .unwrap()
            .contains("mcp-secret")
    );

    send_request(
        &mut socket,
        "reload",
        "mcp.reload",
        json!({ "provider": "codex", "projectPath": workspace }),
    );
    let (reload_pushes, reload) = read_until_response(&mut socket, "reload");
    assert_eq!(reload["result"], json!({}));
    assert_eq!(reload_pushes.len(), 1);
    assert_eq!(reload_pushes[0]["channel"], "mcp.changed");
    assert_eq!(reload_pushes[0]["data"]["projectPath"], workspace);
    let session = runtime.session();
    let reloads = session.mcp_reloads.lock().unwrap();
    assert_eq!(reloads[0].0, "thread-1");
    assert_eq!(reloads[0].1[0].id, "custom");
    drop(reloads);
    assert_eq!(
        session
            .mcp_reload_has_credentials
            .lock()
            .unwrap()
            .as_slice(),
        [true]
    );

    send_request(
        &mut socket,
        "list-live",
        "mcp.list",
        json!({ "provider": "codex", "projectPath": workspace }),
    );
    let listed = read_value(&mut socket);
    assert_eq!(
        listed["result"]["servers"][0]["displayName"],
        "Session documentation"
    );
    assert_eq!(runtime.control_open_count.load(Ordering::Acquire), 0);

    send_request(
        &mut socket,
        "oauth",
        "mcp.startOAuth",
        json!({
            "provider": "codex",
            "projectPath": workspace,
            "serverId": "docs"
        }),
    );
    let (oauth_pushes, oauth) = read_until_response(&mut socket, "oauth");
    assert_eq!(oauth_pushes.len(), 1);
    assert_eq!(oauth_pushes[0]["channel"], "mcp.oauth");
    assert_eq!(oauth_pushes[0]["data"]["serverId"], "docs");
    assert_eq!(
        oauth_pushes[0]["data"]["loginId"],
        oauth["result"]["loginId"]
    );
    assert_eq!(oauth_pushes[0]["data"]["success"], true);

    send_request(
        &mut socket,
        "cancel-oauth",
        "mcp.cancelOAuth",
        json!({
            "provider": "codex",
            "projectPath": workspace,
            "serverId": "docs",
            "loginId": oauth["result"]["loginId"]
        }),
    );
    let cancelled = read_value(&mut socket);
    assert_eq!(cancelled["error"]["code"], "internal");
    assert!(
        cancelled["error"]["message"]
            .as_str()
            .unwrap()
            .contains("close the browser flow instead")
    );

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn resumed_sessions_receive_current_project_mcp_config() {
    let runtime = Arc::new(FakeRuntime::default());
    let registry = Arc::new(FakeRuntimes {
        runtime: Arc::clone(&runtime),
    });
    let (_directory, server) = start_test_server_with_runtimes_and_seed(registry, |store| {
        store.add_project("/repo", None).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "thread-resume-mcp".into(),
                project_path: "/repo".into(),
                provider: ProviderId::Codex,
                agent: None,
                title: "Resume MCP".into(),
                created_at: Some(10),
                worktree_path: None,
                worktree_branch: None,
            })
            .unwrap();
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(
        &mut socket,
        "add",
        "mcp.add",
        json!({
            "provider": "codex",
            "projectPath": "/repo",
            "server": {
                "id": "files",
                "enabled": true,
                "transport": { "type": "stdio", "command": "server.exe" }
            }
        }),
    );
    let _ = read_until_response(&mut socket, "add");
    send_request(
        &mut socket,
        "turn",
        "thread.sendTurn",
        json!({ "threadId": "thread-resume-mcp", "text": "Resume" }),
    );
    let _ = read_until_response(&mut socket, "turn");

    let options = runtime.resume_options.lock().unwrap().clone().unwrap();
    assert_eq!(options.mcp_servers.len(), 1);
    assert_eq!(options.mcp_servers[0].id, "files");
    assert!(options.mcp_credentials.is_empty());

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_provider_routes_report_the_catalog_and_refuse_client_selected_commands() {
    let (_directory, server) = start_test_server(None, |_| {});
    let mut socket = connect_native(&server, "");
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        stream
            .set_read_timeout(Some(Duration::from_secs(8)))
            .unwrap();
    }
    assert_welcome(&mut socket);

    send_request(&mut socket, "providers", "providers.list", json!({}));
    let providers = read_value(&mut socket);
    assert_eq!(providers["id"], "providers");
    assert_eq!(
        providers["result"]["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|provider| provider["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["codex", "claude-code", "grok"]
    );
    assert!(
        providers["result"]["providers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|provider| provider["auth"] == "unknown")
    );

    send_request(&mut socket, "agents", "acp.agents", json!({}));
    assert_eq!(
        read_value(&mut socket)["result"]["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|agent| agent["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["kimi"]
    );

    send_request(
        &mut socket,
        "no-script",
        "providers.install",
        json!({
            "provider": "cursor",
            "columns": 80,
            "rows": 24,
            "command": "touch should-never-run"
        }),
    );
    let no_script = read_value(&mut socket);
    assert_eq!(no_script["error"]["code"], "internal");
    assert!(
        no_script["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no scripted install")
    );

    send_request(
        &mut socket,
        "app-login",
        "providers.launch",
        json!({ "provider": "codex", "columns": 80, "rows": 24 }),
    );
    let app_login = read_value(&mut socket);
    assert!(
        app_login["error"]["message"]
            .as_str()
            .unwrap()
            .contains("through the app")
    );
    send_request(
        &mut socket,
        "empty-agent",
        "providers.launch",
        json!({ "provider": "acp", "agent": "", "columns": 80, "rows": 24 }),
    );
    assert_eq!(read_value(&mut socket)["error"]["code"], "bad_request");

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_terminal_routes_stream_the_thread_checkout_and_preserve_push_order() {
    let checkout = tempfile::tempdir().unwrap();
    let checkout_path = checkout.path().to_string_lossy().into_owned();
    let (_directory, server) = start_test_server(None, |store| {
        store.add_project(&checkout_path, None).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "thread-terminal".into(),
                project_path: checkout_path.clone(),
                provider: ProviderId::Api,
                agent: None,
                title: "Terminal".into(),
                created_at: Some(10),
                worktree_path: None,
                worktree_branch: None,
            })
            .unwrap();
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    let mut next_sequence = 2;
    let mut output = String::new();
    let mut exit = None;

    send_request(
        &mut socket,
        "open",
        "terminal.open",
        json!({ "threadId": "thread-terminal", "columns": 80, "rows": 24 }),
    );
    let opened = read_response_with_terminal_pushes(
        &mut socket,
        "open",
        &mut next_sequence,
        &mut output,
        &mut exit,
    );
    let terminal_id = opened["result"]["terminalId"].as_str().unwrap().to_owned();

    send_request(
        &mut socket,
        "reattach",
        "terminal.open",
        json!({ "threadId": "thread-terminal", "columns": 100, "rows": 30 }),
    );
    let reattached = read_response_with_terminal_pushes(
        &mut socket,
        "reattach",
        &mut next_sequence,
        &mut output,
        &mut exit,
    );
    assert_eq!(reattached["result"]["terminalId"], terminal_id);

    #[cfg(target_os = "windows")]
    let cwd_command = "cd\r";
    #[cfg(not(target_os = "windows"))]
    let cwd_command = "pwd\r";
    send_request(
        &mut socket,
        "cwd",
        "terminal.input",
        json!({ "terminalId": terminal_id, "data": cwd_command }),
    );
    let response = read_response_with_terminal_pushes(
        &mut socket,
        "cwd",
        &mut next_sequence,
        &mut output,
        &mut exit,
    );
    assert_eq!(response["result"], json!({}));
    while !output.contains(&checkout_path) {
        let frame = read_value(&mut socket);
        record_terminal_push(&frame, &mut next_sequence, &mut output, &mut exit);
    }

    send_request(
        &mut socket,
        "resize",
        "terminal.resize",
        json!({ "terminalId": terminal_id, "columns": 120, "rows": 40 }),
    );
    assert_eq!(
        read_response_with_terminal_pushes(
            &mut socket,
            "resize",
            &mut next_sequence,
            &mut output,
            &mut exit,
        )["result"],
        json!({})
    );

    send_request(
        &mut socket,
        "exit",
        "terminal.input",
        json!({ "terminalId": terminal_id, "data": "exit\r" }),
    );
    let _ = read_response_with_terminal_pushes(
        &mut socket,
        "exit",
        &mut next_sequence,
        &mut output,
        &mut exit,
    );
    while exit.is_none() {
        let frame = read_value(&mut socket);
        record_terminal_push(&frame, &mut next_sequence, &mut output, &mut exit);
    }
    assert_eq!(
        exit,
        Some(json!({ "terminalId": terminal_id, "exitCode": 0 }))
    );

    send_request(
        &mut socket,
        "gone",
        "terminal.input",
        json!({ "terminalId": terminal_id, "data": "after exit" }),
    );
    let gone = read_value(&mut socket);
    assert_eq!(gone["id"], "gone");
    assert_eq!(gone["error"]["code"], "internal");
    assert!(
        gone["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no such terminal")
    );

    send_request(
        &mut socket,
        "bad-size",
        "terminal.open",
        json!({ "threadId": "thread-terminal", "columns": 0, "rows": 24 }),
    );
    assert_eq!(read_value(&mut socket)["error"]["code"], "bad_request");
    send_request(
        &mut socket,
        "bad-input",
        "terminal.input",
        json!({ "terminalId": "missing", "data": "😀".repeat(32_769) }),
    );
    assert_eq!(read_value(&mut socket)["error"]["code"], "bad_request");

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_transport_serves_existing_project_history_search_usage_and_checkpoints() {
    let (_directory, server) = start_test_server(None, |store| {
        store.add_project("/repo", Some("Repository")).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "thread-1".into(),
                project_path: "/repo".into(),
                provider: ProviderId::Codex,
                agent: None,
                title: "Native core".into(),
                created_at: Some(10),
                worktree_path: None,
                worktree_branch: None,
            })
            .unwrap();
        store.touch_thread("thread-1", true, Some(20)).unwrap();
        let seq = store
            .append_at(
                "thread-1",
                &DomainEvent::ItemCompleted {
                    item: Item {
                        id: "item-1".into(),
                        turn_id: "turn-1".into(),
                        item_type: ItemType::Message,
                        status: ItemStatus::Completed,
                        role: Some(MessageRole::Assistant),
                        text: Some("durable regression marker".into()),
                        command: None,
                        exit_code: None,
                        duration_ms: None,
                        path: None,
                        lines_added: None,
                        lines_removed: None,
                        created_at: 30.0,
                    },
                },
                30,
            )
            .unwrap();
        store
            .add_checkpoint_at(
                NewCheckpoint {
                    thread_id: "thread-1".into(),
                    seq,
                    commit: "abc123".into(),
                    label: "After native core".into(),
                },
                40,
            )
            .unwrap();
        store
            .append_at(
                "thread-1",
                &DomainEvent::ThreadError {
                    thread_id: "thread-1".into(),
                    message: "provider stopped".into(),
                },
                50,
            )
            .unwrap();
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(&mut socket, "projects", "projects.list", json!({}));
    let projects = read_value(&mut socket);
    assert_eq!(projects["result"]["projects"][0]["name"], "Repository");
    assert_eq!(
        projects["result"]["projects"][0]["sessions"][0]["provider"],
        "codex"
    );
    assert_eq!(
        projects["result"]["projects"][0]["sessions"][0]["status"],
        "failed"
    );

    send_request(
        &mut socket,
        "history",
        "thread.history",
        json!({ "threadId": "thread-1", "afterSeq": 0 }),
    );
    let history = read_value(&mut socket);
    assert_eq!(history["result"]["events"].as_array().unwrap().len(), 2);
    assert_eq!(
        history["result"]["events"][0]["event"]["item"]["text"],
        "durable regression marker"
    );
    assert_eq!(history["result"]["running"], false);

    send_request(
        &mut socket,
        "search",
        "search.sessions",
        json!({ "query": "regression" }),
    );
    let search = read_value(&mut socket);
    assert_eq!(search["result"]["results"].as_array().unwrap().len(), 1);
    assert_eq!(search["result"]["results"][0]["threadId"], "thread-1");

    send_request(
        &mut socket,
        "checkpoints",
        "thread.checkpoints",
        json!({ "threadId": "thread-1" }),
    );
    let checkpoints = read_value(&mut socket);
    assert_eq!(
        checkpoints["result"]["checkpoints"][0]["label"],
        "After native core"
    );

    send_request(
        &mut socket,
        "usage",
        "usage.summary",
        json!({ "threadId": "thread-1" }),
    );
    let usage = read_value(&mut socket);
    assert_eq!(usage["result"]["session"]["totalTokens"], 0.0);
    assert_eq!(usage["result"]["limits"], json!([]));

    send_request(&mut socket, "projects-again", "projects.list", json!({}));
    let projects = read_value(&mut socket);
    assert_eq!(
        projects["result"]["projects"][0]["sessions"][0]["unread"],
        false
    );
    assert_eq!(
        projects["result"]["projects"][0]["sessions"][0]["status"],
        "failed"
    );

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn sidebar_and_lifecycle_pushes_are_ordered_per_connection_before_the_response() {
    let (_directory, server) = start_test_server(None, |store| {
        store.add_project("/repo", None).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "thread-1".into(),
                project_path: "/repo".into(),
                provider: ProviderId::Api,
                agent: None,
                title: "Lifecycle".into(),
                created_at: Some(10),
                worktree_path: None,
                worktree_branch: None,
            })
            .unwrap();
    });
    let mut first = connect_native(&server, "");
    let mut second = connect_native(&server, "");
    assert_welcome(&mut first);
    assert_welcome(&mut second);

    send_request(
        &mut first,
        "sidebar",
        "sidebar.updateSettings",
        json!({ "mode": "classic", "autoSettleDays": null }),
    );
    assert_eq!(
        read_value(&mut first),
        json!({
            "channel": "sidebar.settings",
            "sequence": 2,
            "data": { "mode": "classic", "autoSettleDays": null }
        })
    );
    assert_eq!(
        read_value(&mut first),
        json!({
            "id": "sidebar",
            "result": { "mode": "classic", "autoSettleDays": null }
        })
    );
    assert_eq!(
        read_value(&mut second),
        json!({
            "channel": "sidebar.settings",
            "sequence": 2,
            "data": { "mode": "classic", "autoSettleDays": null }
        })
    );

    send_request(
        &mut first,
        "settle",
        "thread.settle",
        json!({ "threadId": "thread-1" }),
    );
    let lifecycle_push = read_value(&mut first);
    assert_eq!(lifecycle_push["channel"], "thread.lifecycle");
    assert_eq!(lifecycle_push["sequence"], 3);
    assert_eq!(lifecycle_push["data"]["lifecycle"]["state"], "settled");
    let lifecycle_response = read_value(&mut first);
    assert_eq!(lifecycle_response["id"], "settle");
    assert_eq!(
        lifecycle_response["result"]["lifecycle"]["state"],
        "settled"
    );
    let second_push = read_value(&mut second);
    assert_eq!(second_push["sequence"], 3);
    assert_eq!(second_push["channel"], "thread.lifecycle");

    first.close(None).unwrap();
    second.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_workspace_routes_report_and_switch_only_local_branches() {
    let repository = tempfile::tempdir().unwrap();
    git(repository.path(), &["init", "--initial-branch=main"]);
    git(
        repository.path(),
        &["config", "user.email", "test@example.com"],
    );
    git(repository.path(), &["config", "user.name", "Test"]);
    std::fs::write(repository.path().join("file.txt"), "initial\n").unwrap();
    git(repository.path(), &["add", "file.txt"]);
    git(repository.path(), &["commit", "-m", "initial"]);
    git(repository.path(), &["branch", "feature/native"]);

    let (_directory, server) = start_test_server(None, |_| {});
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    let path = repository.path().to_string_lossy();

    send_request(
        &mut socket,
        "branches",
        "workspace.branches",
        json!({ "path": path }),
    );
    assert_eq!(
        read_value(&mut socket)["result"]["branches"],
        json!(["main", "feature/native"])
    );
    send_request(
        &mut socket,
        "switch",
        "workspace.switchBranch",
        json!({ "path": path, "branch": "feature/native" }),
    );
    let switched = read_value(&mut socket);
    assert_eq!(switched["result"]["branch"], "feature/native");
    assert_eq!(switched["result"]["dirtyFiles"], 0);

    send_request(
        &mut socket,
        "revision",
        "workspace.switchBranch",
        json!({ "path": path, "branch": "HEAD~1" }),
    );
    let rejected = read_value(&mut socket);
    assert_eq!(rejected["error"]["code"], "internal");
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknown local branch")
    );

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_worktree_routes_refuse_unsaved_work_and_forced_discard_keeps_the_branch() {
    let repository_root = tempfile::tempdir().unwrap();
    let repository = repository_root.path().join("repo");
    let worktree_root = repository_root.path().join("worktrees");
    let output = Command::new("git")
        .args(["init", "-b", "main"])
        .arg(&repository)
        .output()
        .unwrap();
    assert!(output.status.success());
    git(&repository, &["config", "user.email", "test@example.com"]);
    git(&repository, &["config", "user.name", "Test"]);
    std::fs::write(repository.join("file.txt"), "initial\n").unwrap();
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "initial"]);
    let worktree =
        harness_workspace::create_worktree(&repository, "thread-aaaaaaaaaaaa", &worktree_root)
            .unwrap();
    let worktree_path = worktree.path.clone();
    let worktree_branch = worktree.branch.clone();
    let repository_text = repository.to_string_lossy().into_owned();
    let worktree_text = worktree.path.to_string_lossy().into_owned();

    let (_directory, server) = start_test_server(None, |store| {
        store.add_project(&repository_text, None).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "thread-1".into(),
                project_path: repository_text.clone(),
                provider: ProviderId::Codex,
                agent: None,
                title: "Isolated".into(),
                created_at: Some(10),
                worktree_path: Some(worktree_text.clone()),
                worktree_branch: Some(worktree_branch.clone()),
            })
            .unwrap();
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "clean",
        "thread.unsavedWork",
        json!({ "threadId": "thread-1" }),
    );
    assert_eq!(
        read_value(&mut socket)["result"],
        json!({ "isolated": true, "uncommitted": false })
    );
    std::fs::write(worktree_path.join("untracked.txt"), "unsaved\n").unwrap();
    send_request(
        &mut socket,
        "dirty",
        "thread.unsavedWork",
        json!({ "threadId": "thread-1" }),
    );
    assert_eq!(read_value(&mut socket)["result"]["uncommitted"], true);

    send_request(
        &mut socket,
        "refuse",
        "thread.discardWorktree",
        json!({ "threadId": "thread-1" }),
    );
    let refused = read_value(&mut socket);
    assert_eq!(refused["error"]["code"], "internal");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("uncommitted changes")
    );
    assert!(worktree_path.exists());

    send_request(
        &mut socket,
        "discard",
        "thread.discardWorktree",
        json!({ "threadId": "thread-1", "force": true }),
    );
    assert_eq!(
        read_value(&mut socket),
        json!({ "id": "discard", "result": {} })
    );
    assert!(!worktree_path.exists());
    assert!(git(&repository, &["branch", "--list", &worktree_branch]).contains(&worktree_branch));

    send_request(
        &mut socket,
        "forgotten",
        "thread.unsavedWork",
        json!({ "threadId": "thread-1" }),
    );
    assert_eq!(
        read_value(&mut socket)["result"],
        json!({ "isolated": false, "uncommitted": false })
    );

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn startup_forgets_only_worktrees_whose_directories_are_already_gone() {
    let repository_root = tempfile::tempdir().unwrap();
    let repository = repository_root.path().join("repo");
    let worktree_root = repository_root.path().join("worktrees");
    let output = Command::new("git")
        .args(["init", "-b", "main"])
        .arg(&repository)
        .output()
        .unwrap();
    assert!(output.status.success());
    git(&repository, &["config", "user.email", "test@example.com"]);
    git(&repository, &["config", "user.name", "Test"]);
    std::fs::write(repository.join("file.txt"), "initial\n").unwrap();
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "initial"]);
    let missing =
        harness_workspace::create_worktree(&repository, "thread-aaaaaaaaaaaa", &worktree_root)
            .unwrap();
    let present =
        harness_workspace::create_worktree(&repository, "thread-bbbbbbbbbbbb", &worktree_root)
            .unwrap();
    std::fs::write(present.path.join("uncommitted.txt"), "keep\n").unwrap();
    std::fs::remove_dir_all(&missing.path).unwrap();
    let repository_text = repository.to_string_lossy().into_owned();

    let (_directory, server) = start_test_server(None, |store| {
        store.add_project(&repository_text, None).unwrap();
        for (id, worktree) in [("missing", &missing), ("present", &present)] {
            store
                .add_thread(StoreNewThread {
                    id: id.into(),
                    project_path: repository_text.clone(),
                    provider: ProviderId::Codex,
                    agent: None,
                    title: id.into(),
                    created_at: Some(if id == "missing" { 10 } else { 20 }),
                    worktree_path: Some(worktree.path.to_string_lossy().into_owned()),
                    worktree_branch: Some(worktree.branch.clone()),
                })
                .unwrap();
        }
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(&mut socket, "projects", "projects.list", json!({}));
    let projects = read_value(&mut socket);
    let sessions = projects["result"]["projects"][0]["sessions"]
        .as_array()
        .unwrap();
    let missing_session = sessions
        .iter()
        .find(|session| session["id"] == "missing")
        .unwrap();
    let present_session = sessions
        .iter()
        .find(|session| session["id"] == "present")
        .unwrap();
    assert!(missing_session.get("worktreeBranch").is_none());
    assert_eq!(present_session["worktreeBranch"], present.branch);
    assert!(present.path.join("uncommitted.txt").exists());

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_checkpoint_restore_keeps_files_and_conversation_reversible_together() {
    let repository = tempfile::tempdir().unwrap();
    git(repository.path(), &["init", "--initial-branch=main"]);
    git(
        repository.path(),
        &["config", "user.email", "test@example.com"],
    );
    git(repository.path(), &["config", "user.name", "Test"]);
    std::fs::write(repository.path().join("tracked.txt"), "original\n").unwrap();
    git(repository.path(), &["add", "."]);
    git(repository.path(), &["commit", "-m", "initial"]);
    let before = harness_workspace::take_snapshot(repository.path()).unwrap();
    std::fs::write(repository.path().join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repository.path().join("added.txt"), "temporary\n").unwrap();
    let repository_text = repository.path().to_string_lossy().into_owned();

    let (_directory, server) = start_test_server(None, |store| {
        store.add_project(&repository_text, None).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "thread-1".into(),
                project_path: repository_text.clone(),
                provider: ProviderId::Codex,
                agent: None,
                title: "Restore".into(),
                created_at: Some(10),
                worktree_path: None,
                worktree_branch: None,
            })
            .unwrap();
        let checkpoint_seq = store
            .append_at(
                "thread-1",
                &completed_message("keep", "keep this", 10.0),
                10,
            )
            .unwrap();
        store
            .add_checkpoint_at(
                NewCheckpoint {
                    thread_id: "thread-1".into(),
                    seq: checkpoint_seq,
                    commit: before.commit.clone(),
                    label: "Before change".into(),
                },
                20,
            )
            .unwrap();
        store
            .append_at(
                "thread-1",
                &completed_message("tail", "temporary tail", 30.0),
                30,
            )
            .unwrap();
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "changed",
        "thread.changedSince",
        json!({ "threadId": "thread-1", "checkpointId": 1 }),
    );
    let mut files = read_value(&mut socket)["result"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(files, ["added.txt", "tracked.txt"]);

    send_request(
        &mut socket,
        "restore",
        "thread.restore",
        json!({ "threadId": "thread-1", "checkpointId": 1 }),
    );
    let restored = read_value(&mut socket);
    let undo = restored["result"]["undo"].as_str().unwrap().to_owned();
    assert_eq!(
        std::fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
        "original\n"
    );
    assert!(!repository.path().join("added.txt").exists());

    send_request(
        &mut socket,
        "truncated",
        "thread.history",
        json!({ "threadId": "thread-1" }),
    );
    assert_eq!(
        read_value(&mut socket)["result"]["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    send_request(
        &mut socket,
        "undo",
        "thread.undoRestore",
        json!({ "threadId": "thread-1", "undo": undo }),
    );
    assert_eq!(
        read_value(&mut socket),
        json!({ "id": "undo", "result": {} })
    );
    assert_eq!(
        std::fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
        "changed\n"
    );
    assert_eq!(
        std::fs::read_to_string(repository.path().join("added.txt")).unwrap(),
        "temporary\n"
    );
    send_request(
        &mut socket,
        "history",
        "thread.history",
        json!({ "threadId": "thread-1" }),
    );
    assert_eq!(
        read_value(&mut socket)["result"]["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    send_request(
        &mut socket,
        "spent",
        "thread.undoRestore",
        json!({ "threadId": "thread-1", "undo": undo }),
    );
    let spent = read_value(&mut socket);
    assert_eq!(spent["error"]["code"], "internal");
    assert_eq!(spent["error"]["message"], "restore can no longer be undone");

    socket.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn live_diff_review_rejects_one_hunk_and_detects_stale_snapshots() {
    let repository = tempfile::tempdir().unwrap();
    git(repository.path(), &["init", "--initial-branch=main"]);
    git(
        repository.path(),
        &["config", "user.email", "test@example.com"],
    );
    git(repository.path(), &["config", "user.name", "Test"]);
    let lines = |second: &str, eighteenth: &str| {
        (1..=20)
            .map(|line| match line {
                2 => second.into(),
                18 => eighteenth.into(),
                _ => format!("line {line}"),
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    };
    fs::write(
        repository.path().join("file.txt"),
        lines("line 2", "line 18"),
    )
    .unwrap();
    git(repository.path(), &["add", "."]);
    git(repository.path(), &["commit", "-m", "initial"]);
    fs::write(
        repository.path().join("file.txt"),
        lines("reject me", "keep me"),
    )
    .unwrap();
    let repository_text = repository.path().to_string_lossy().into_owned();

    let (_directory, server) = start_test_server(None, |store| {
        store.add_project(&repository_text, None).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "thread-1".into(),
                project_path: repository_text.clone(),
                provider: ProviderId::Codex,
                agent: None,
                title: "Review".into(),
                created_at: Some(10),
                worktree_path: Some(repository_text.clone()),
                worktree_branch: Some("main".into()),
            })
            .unwrap();
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);

    send_request(
        &mut socket,
        "diff",
        "thread.diff",
        json!({ "threadId": "thread-1" }),
    );
    let initial = read_value(&mut socket)["result"].clone();
    assert_eq!(initial["files"][0]["path"], "file.txt");
    assert_eq!(initial["files"][0]["hunks"].as_array().unwrap().len(), 2);
    let version = initial["version"].as_str().unwrap();
    let first_hunk = initial["files"][0]["hunks"][0]["id"].as_str().unwrap();
    send_request(
        &mut socket,
        "reject",
        "thread.reviewHunk",
        json!({
            "threadId": "thread-1",
            "version": version,
            "path": "file.txt",
            "hunkId": first_hunk,
            "decision": "reject"
        }),
    );
    let reviewed = read_value(&mut socket);
    assert_eq!(
        reviewed["result"]["diff"]["files"][0]["hunks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let content = fs::read_to_string(repository.path().join("file.txt")).unwrap();
    assert!(content.contains("line 2"));
    assert!(content.contains("keep me"));

    let current = &reviewed["result"]["diff"];
    let stale_version = current["version"].as_str().unwrap();
    let remaining_hunk = current["files"][0]["hunks"][0]["id"].as_str().unwrap();
    fs::write(
        repository.path().join("file.txt"),
        lines("line 2", "changed again"),
    )
    .unwrap();
    send_request(
        &mut socket,
        "stale",
        "thread.reviewHunk",
        json!({
            "threadId": "thread-1",
            "version": stale_version,
            "path": "file.txt",
            "hunkId": remaining_hunk,
            "decision": "reject"
        }),
    );
    let stale = read_value(&mut socket);
    assert_eq!(stale["error"]["code"], "stale_snapshot");
    assert_eq!(stale["error"]["message"], "Refresh the diff and try again.");
    assert!(
        fs::read_to_string(repository.path().join("file.txt"))
            .unwrap()
            .contains("changed again")
    );

    socket.close(None).unwrap();
    server.close().unwrap();
}

struct FakeRuntimes {
    runtime: Arc<FakeRuntime>,
}

impl crate::agents::RuntimeRegistry for FakeRuntimes {
    fn runtime(
        &self,
        provider: ProviderId,
        _agent: Option<&str>,
        _connection_id: Option<&str>,
    ) -> Result<Arc<dyn AgentRuntime>, AgentError> {
        if provider != ProviderId::Codex {
            return Err(AgentError::Failed("unsupported fake provider".into()));
        }
        Ok(self.runtime.clone())
    }

    fn mcp_capabilities(&self, provider: ProviderId) -> harness_protocol::McpCapabilities {
        if provider == ProviderId::Codex {
            harness_adapter_codex::CODEX_MCP_CAPABILITIES
        } else {
            harness_protocol::McpCapabilities {
                inventory: false,
                add: false,
                update: false,
                remove: false,
                reload: false,
                start_o_auth: false,
                cancel_o_auth: false,
            }
        }
    }

    fn skill_capabilities(&self, provider: ProviderId) -> harness_protocol::SkillCapabilities {
        if provider == ProviderId::Codex {
            harness_adapter_codex::CODEX_SKILL_CAPABILITIES
        } else {
            harness_protocol::SkillCapabilities {
                inventory: false,
                configure: false,
                install: false,
            }
        }
    }
}

#[derive(Default)]
struct FakeRuntime {
    start_options: Mutex<Option<StartOptions>>,
    resume_options: Mutex<Option<StartOptions>>,
    sessions: Mutex<Vec<Arc<FakeSession>>>,
    controls: Mutex<Vec<Arc<FakeControl>>>,
    complete_during_send: Arc<AtomicBool>,
    complete_login_during_start: Arc<AtomicBool>,
    complete_mcp_o_auth_during_start: Arc<AtomicBool>,
    images_disabled: Arc<AtomicBool>,
    resume_count: AtomicU64,
    resume_delay_ms: AtomicU64,
    control_open_count: AtomicU64,
    control_delay_ms: AtomicU64,
    model_delay_ms: AtomicU64,
}

impl FakeRuntime {
    fn session(&self) -> Arc<FakeSession> {
        self.sessions
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("fake session was not started")
    }

    fn control(&self) -> Arc<FakeControl> {
        self.controls
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("fake control was not opened")
    }
}

impl AgentRuntime for FakeRuntime {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        *self.start_options.lock().unwrap() = Some(options.clone());
        let thread = Thread {
            id: "thread-1".into(),
            provider: ProviderId::Codex,
            connection_id: None,
            workspace_path: workspace_path.into(),
            title: None,
            created_at: 1_000.0,
        };
        handlers.emit_event(DomainEvent::ThreadStarted {
            thread: thread.clone(),
        });
        let session = Arc::new(FakeSession {
            handlers,
            next_turn: AtomicU64::new(1),
            complete_during_send: Arc::clone(&self.complete_during_send),
            interrupted: AtomicBool::new(false),
            interrupt_delay_ms: AtomicU64::new(0),
            interrupt_error: Mutex::new(None),
            disposed: AtomicBool::new(false),
            approvals: Mutex::new(Vec::new()),
            user_inputs: Mutex::new(Vec::new()),
            sent_texts: Mutex::new(Vec::new()),
            sent_attachments: Mutex::new(Vec::new()),
            sent_options: Mutex::new(Vec::new()),
            steered_texts: Mutex::new(Vec::new()),
            mcp_reloads: Mutex::new(Vec::new()),
            mcp_reload_has_credentials: Mutex::new(Vec::new()),
            next_mcp_login: AtomicU64::new(1),
            complete_mcp_o_auth_during_start: Arc::clone(&self.complete_mcp_o_auth_during_start),
            images_disabled: Arc::clone(&self.images_disabled),
        });
        self.sessions.lock().unwrap().push(Arc::clone(&session));
        Ok((thread, session))
    }

    fn resume(
        &self,
        thread_id: &str,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        self.resume_count.fetch_add(1, Ordering::AcqRel);
        *self.resume_options.lock().unwrap() = Some(options.clone());
        let delay = self.resume_delay_ms.load(Ordering::Acquire);
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
        let thread = Thread {
            id: thread_id.into(),
            provider: ProviderId::Codex,
            connection_id: None,
            workspace_path: workspace_path.into(),
            title: None,
            created_at: 1_000.0,
        };
        let session = Arc::new(FakeSession {
            handlers,
            next_turn: AtomicU64::new(1),
            complete_during_send: Arc::clone(&self.complete_during_send),
            interrupted: AtomicBool::new(false),
            interrupt_delay_ms: AtomicU64::new(0),
            interrupt_error: Mutex::new(None),
            disposed: AtomicBool::new(false),
            approvals: Mutex::new(Vec::new()),
            user_inputs: Mutex::new(Vec::new()),
            sent_texts: Mutex::new(Vec::new()),
            sent_attachments: Mutex::new(Vec::new()),
            sent_options: Mutex::new(Vec::new()),
            steered_texts: Mutex::new(Vec::new()),
            mcp_reloads: Mutex::new(Vec::new()),
            mcp_reload_has_credentials: Mutex::new(Vec::new()),
            next_mcp_login: AtomicU64::new(1),
            complete_mcp_o_auth_during_start: Arc::clone(&self.complete_mcp_o_auth_during_start),
            images_disabled: Arc::clone(&self.images_disabled),
        });
        self.sessions.lock().unwrap().push(Arc::clone(&session));
        Ok((thread, session))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        let delay = self.model_delay_ms.load(Ordering::Acquire);
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
        Ok(vec![Model {
            id: "fake-model".into(),
            display_name: "Fake Model".into(),
            description: Some("Fixture model".into()),
            is_default: true,
            reasoning_efforts: vec!["medium".into(), "high".into()],
            default_reasoning_effort: Some("medium".into()),
            service_tiers: vec![ServiceTier {
                id: "priority".into(),
                name: "Fast".into(),
                description: "Priority processing".into(),
            }],
            default_service_tier: Some("priority".into()),
        }])
    }

    fn open_control(&self, handlers: ControlHandlers) -> AgentResult<Arc<dyn ProviderControl>> {
        self.control_open_count.fetch_add(1, Ordering::AcqRel);
        let delay = self.control_delay_ms.load(Ordering::Acquire);
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
        let control = Arc::new(FakeControl {
            handlers,
            account: Mutex::new(Account {
                signed_in: false,
                email: None,
                plan: None,
            }),
            next_login: AtomicU64::new(1),
            complete_during_start: Arc::clone(&self.complete_login_during_start),
            cancelled: Mutex::new(Vec::new()),
            api_keys: Mutex::new(Vec::new()),
            skill_toggles: Mutex::new(Vec::new()),
            voice_started: AtomicBool::new(false),
            disposed: AtomicBool::new(false),
        });
        self.controls.lock().unwrap().push(Arc::clone(&control));
        Ok(control)
    }
}

struct FakeControl {
    handlers: ControlHandlers,
    account: Mutex<Account>,
    next_login: AtomicU64,
    complete_during_start: Arc<AtomicBool>,
    cancelled: Mutex<Vec<String>>,
    api_keys: Mutex<Vec<String>>,
    skill_toggles: Mutex<Vec<(String, bool)>>,
    voice_started: AtomicBool,
    disposed: AtomicBool,
}

impl FakeControl {
    fn complete_login(&self, login_id: &str, success: bool, error: Option<&str>) {
        if success {
            *self.account.lock().unwrap() = Account {
                signed_in: true,
                email: Some("developer@example.com".into()),
                plan: Some("Pro".into()),
            };
        }
        self.handlers.emit_login(LoginEvent {
            login_id: Some(login_id.into()),
            success,
            error: error.map(str::to_owned),
        });
    }
}

impl ProviderControl for FakeControl {
    fn account(&self) -> AgentResult<Account> {
        Ok(self.account.lock().unwrap().clone())
    }

    fn start_login(&self) -> AgentResult<AuthStartLoginResult> {
        let index = self.next_login.fetch_add(1, Ordering::AcqRel);
        let login_id = format!("login-{index}");
        if self.complete_during_start.load(Ordering::Acquire) {
            self.complete_login(&login_id, true, None);
        }
        Ok(AuthStartLoginResult {
            auth_url: Some(format!("https://auth.example/{login_id}")),
            login_id,
        })
    }

    fn cancel_login(&self, login_id: &str) -> AgentResult<()> {
        self.cancelled.lock().unwrap().push(login_id.into());
        Ok(())
    }

    fn use_api_key(&self, api_key: &str) -> AgentResult<Account> {
        self.api_keys.lock().unwrap().push(api_key.into());
        let account = Account {
            signed_in: true,
            email: None,
            plan: Some("API key".into()),
        };
        *self.account.lock().unwrap() = account.clone();
        Ok(account)
    }

    fn sign_out(&self) -> AgentResult<()> {
        *self.account.lock().unwrap() = Account {
            signed_in: false,
            email: None,
            plan: None,
        };
        Ok(())
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        Ok(Vec::new())
    }

    fn list_mcp_servers(&self) -> AgentResult<harness_protocol::McpListResult> {
        Ok(serde_json::from_value(json!({
            "capabilities": {
                "inventory": true,
                "add": true,
                "update": true,
                "remove": true,
                "reload": true,
                "startOAuth": true,
                "cancelOAuth": false
            },
            "servers": [{
                "id": "docs",
                "displayName": "Documentation",
                "scope": "global",
                "enabled": true,
                "auth": { "status": "not_required" },
                "startup": { "state": "ready" },
                "tools": [],
                "resources": [],
                "resourceTemplates": []
            }]
        }))
        .unwrap())
    }

    fn list_skills(&self, project_path: &str) -> AgentResult<harness_protocol::SkillsListResult> {
        let mut skills = vec![json!({
            "id": format!("{project_path}/.agents/skills/docs/SKILL.md"),
            "name": "docs",
            "displayName": "Docs",
            "description": "Read docs",
            "source": {
                "type": "folder",
                "path": format!("{project_path}/.agents/skills/docs")
            },
            "scope": "project",
            "enabled": true,
            "dependencyErrors": []
        })];
        let managed = std::path::Path::new(project_path).join(".agents/skills");
        if let Ok(entries) = std::fs::read_dir(managed) {
            for entry in entries.filter_map(Result::ok) {
                let folder = entry.path();
                if !folder.join("SKILL.md").is_file() {
                    continue;
                }
                let Some(name) = folder.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                skills.push(json!({
                    "id": folder.join("SKILL.md"),
                    "name": name,
                    "description": format!("Installed {name}"),
                    "source": { "type": "folder", "path": folder },
                    "scope": "project",
                    "enabled": true,
                    "dependencyErrors": []
                }));
            }
        }
        Ok(serde_json::from_value(json!({
            "capabilities": { "inventory": true, "configure": true, "install": true },
            "skills": skills,
            "errors": []
        }))
        .unwrap())
    }

    fn set_skill_enabled(&self, skill_id: &str, enabled: bool) -> AgentResult<bool> {
        self.skill_toggles
            .lock()
            .unwrap()
            .push((skill_id.into(), enabled));
        Ok(enabled)
    }

    fn voice_status(&self) -> AgentResult<VoiceStatusResult> {
        Ok(VoiceStatusResult {
            available: true,
            reason: None,
        })
    }

    fn transcribe_voice(
        &self,
        _input: &VoiceTranscribeParams,
        cancellation: &CancellationToken,
    ) -> AgentResult<String> {
        self.voice_started.store(true, Ordering::Release);
        while !cancellation.is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        Err(AgentError::Failed(
            "Voice transcription was cancelled.".into(),
        ))
    }

    fn dispose(&self) {
        self.disposed.store(true, Ordering::Release);
    }
}

type FakeUserInputResponses = Vec<(String, HashMap<String, Vec<String>>)>;

struct FakeSession {
    handlers: AgentHandlers,
    next_turn: AtomicU64,
    complete_during_send: Arc<AtomicBool>,
    interrupted: AtomicBool,
    interrupt_delay_ms: AtomicU64,
    interrupt_error: Mutex<Option<String>>,
    disposed: AtomicBool,
    approvals: Mutex<Vec<(String, ApprovalDecision)>>,
    user_inputs: Mutex<FakeUserInputResponses>,
    sent_texts: Mutex<Vec<String>>,
    sent_attachments: Mutex<Vec<Vec<String>>>,
    sent_options: Mutex<Vec<TurnOptions>>,
    steered_texts: Mutex<Vec<String>>,
    mcp_reloads: Mutex<Vec<(String, Vec<McpServerConfig>)>>,
    mcp_reload_has_credentials: Mutex<Vec<bool>>,
    next_mcp_login: AtomicU64,
    complete_mcp_o_auth_during_start: Arc<AtomicBool>,
    images_disabled: Arc<AtomicBool>,
}

impl FakeSession {
    fn complete(&self, turn_id: &str) {
        self.handlers.emit_event(DomainEvent::TurnCompleted {
            turn_id: turn_id.into(),
            status: TurnStatus::Completed,
        });
    }

    fn complete_with_output(&self, turn_id: &str, text: &str) {
        let item = Item {
            id: format!("assistant-{turn_id}"),
            turn_id: turn_id.into(),
            item_type: ItemType::Message,
            status: ItemStatus::Started,
            role: Some(MessageRole::Assistant),
            text: Some(String::new()),
            command: None,
            exit_code: None,
            duration_ms: None,
            path: None,
            lines_added: None,
            lines_removed: None,
            created_at: 1_000.0,
        };
        self.handlers
            .emit_event(DomainEvent::ItemStarted { item: item.clone() });
        self.handlers.emit_event(DomainEvent::ItemDelta {
            turn_id: turn_id.into(),
            item_id: item.id.clone(),
            text_delta: text.into(),
        });
        self.handlers.emit_event(DomainEvent::ItemCompleted {
            item: Item {
                status: ItemStatus::Completed,
                text: Some(text.into()),
                ..item
            },
        });
        self.complete(turn_id);
    }

    fn complete_mcp_o_auth(
        &self,
        server_id: &str,
        login_id: &str,
        success: bool,
        error: Option<&str>,
    ) {
        self.handlers.emit_mcp_o_auth(McpOAuthEvent {
            server_id: server_id.into(),
            login_id: login_id.into(),
            success,
            error: error.map(str::to_owned),
        });
    }
}

impl AgentSession for FakeSession {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            steer: true,
            fork: false,
            interrupt: true,
            reasoning_items: true,
            approvals: true,
            user_input: Some(true),
            auto_review: Some(false),
            images: !self.images_disabled.load(Ordering::Acquire),
        }
    }

    fn send_turn(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        options: &TurnOptions,
    ) -> AgentResult<String> {
        self.sent_texts.lock().unwrap().push(text.into());
        self.sent_attachments
            .lock()
            .unwrap()
            .push(attachments.to_vec());
        self.sent_options.lock().unwrap().push(options.clone());
        let index = self.next_turn.fetch_add(1, Ordering::AcqRel);
        let turn_id = format!("turn-{index}");
        self.handlers.emit_event(DomainEvent::TurnStarted {
            turn: Turn {
                id: turn_id.clone(),
                thread_id: thread_id.into(),
                status: TurnStatus::Running,
                created_at: index as f64,
            },
        });
        if self.complete_during_send.load(Ordering::Acquire) {
            self.complete(&turn_id);
        }
        Ok(turn_id)
    }

    fn steer(&self, _thread_id: &str, text: &str, _attachments: &[String]) -> AgentResult<()> {
        self.steered_texts.lock().unwrap().push(text.into());
        Ok(())
    }

    fn interrupt(&self, _thread_id: &str) -> AgentResult<()> {
        self.interrupted.store(true, Ordering::Release);
        let delay = self.interrupt_delay_ms.load(Ordering::Acquire);
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
        match self.interrupt_error.lock().unwrap().clone() {
            Some(error) => Err(AgentError::Failed(error)),
            None => Ok(()),
        }
    }

    fn respond_to_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> AgentResult<bool> {
        self.approvals
            .lock()
            .unwrap()
            .push((approval_id.into(), decision));
        Ok(true)
    }

    fn respond_to_user_input(
        &self,
        request_id: &str,
        answers: &HashMap<String, Vec<String>>,
    ) -> AgentResult<bool> {
        self.user_inputs
            .lock()
            .unwrap()
            .push((request_id.into(), answers.clone()));
        Ok(true)
    }

    fn list_mcp_servers(&self, _thread_id: &str) -> AgentResult<harness_protocol::McpListResult> {
        Ok(serde_json::from_value(json!({
            "capabilities": {
                "inventory": true,
                "add": true,
                "update": true,
                "remove": true,
                "reload": true,
                "startOAuth": true,
                "cancelOAuth": false
            },
            "servers": [{
                "id": "docs",
                "displayName": "Session documentation",
                "scope": "global",
                "enabled": true,
                "auth": { "status": "not_required" },
                "startup": { "state": "ready" },
                "tools": [],
                "resources": [],
                "resourceTemplates": []
            }]
        }))
        .unwrap())
    }

    fn reload_mcp_servers(
        &self,
        thread_id: &str,
        servers: &[McpServerConfig],
        credentials: &CredentialValues,
    ) -> AgentResult<()> {
        self.mcp_reload_has_credentials
            .lock()
            .unwrap()
            .push(!credentials.is_empty());
        self.mcp_reloads
            .lock()
            .unwrap()
            .push((thread_id.into(), servers.to_vec()));
        self.handlers.emit_mcp_changed(Some(thread_id.into()));
        Ok(())
    }

    fn start_mcp_o_auth(
        &self,
        server_id: &str,
        _thread_id: &str,
    ) -> AgentResult<McpOAuthStartResult> {
        let index = self.next_mcp_login.fetch_add(1, Ordering::AcqRel);
        let login_id = format!("mcp-login-{index}");
        if self
            .complete_mcp_o_auth_during_start
            .load(Ordering::Acquire)
        {
            self.complete_mcp_o_auth(server_id, &login_id, true, None);
        }
        Ok(McpOAuthStartResult {
            login_id: login_id.clone(),
            auth_url: format!("https://auth.example/{login_id}"),
        })
    }

    fn dispose(&self) {
        self.disposed.store(true, Ordering::Release);
    }
}

#[test]
fn live_handshake_closes_untrusted_origins_and_missing_access_tokens() {
    let (_directory, server) = start_test_server(Some("correct token"), |_| {});

    let mut missing = connect_native(&server, "");
    match missing.read().unwrap() {
        Message::Close(Some(frame)) => {
            assert_eq!(frame.code, CloseCode::Policy);
            assert_eq!(frame.reason, "Access denied");
        }
        frame => panic!("expected access denial, got {frame:?}"),
    }

    let mut request = format!("ws://{}/?token=correct%20token", server.address())
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", HeaderValue::from_static("https://evil.example"));
    let (mut hostile, _) = connect(request).unwrap();
    match hostile.read().unwrap() {
        Message::Close(Some(frame)) => {
            assert_eq!(frame.code, CloseCode::Policy);
            assert_eq!(frame.reason, "Origin not allowed");
        }
        frame => panic!("expected origin denial, got {frame:?}"),
    }

    let mut allowed = connect_native(&server, "/?token=correct%20token");
    assert_welcome(&mut allowed);
    allowed.close(None).unwrap();
    server.close().unwrap();
}

#[test]
fn shutdown_closes_open_clients_and_joins_connection_workers() {
    let checkout = tempfile::tempdir().unwrap();
    let checkout_path = checkout.path().to_string_lossy().into_owned();
    let (_directory, server) = start_test_server(None, |store| {
        store.add_project(&checkout_path, None).unwrap();
        store
            .add_thread(StoreNewThread {
                id: "shutdown-terminal".into(),
                project_path: checkout_path,
                provider: ProviderId::Api,
                agent: None,
                title: "Shutdown".into(),
                created_at: Some(10),
                worktree_path: None,
                worktree_branch: None,
            })
            .unwrap();
    });
    let mut socket = connect_native(&server, "");
    assert_welcome(&mut socket);
    send_request(
        &mut socket,
        "open",
        "terminal.open",
        json!({ "threadId": "shutdown-terminal", "columns": 80, "rows": 24 }),
    );
    let mut next_sequence = 2;
    let mut output = String::new();
    let mut exit = None;
    let opened = read_response_with_terminal_pushes(
        &mut socket,
        "open",
        &mut next_sequence,
        &mut output,
        &mut exit,
    );
    assert!(opened["result"]["terminalId"].is_string());

    let started = Instant::now();
    server.close().unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(matches!(socket.read().unwrap(), Message::Close(_)));
}
