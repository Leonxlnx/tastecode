use crate::{DEFAULT_MAX_NDJSON_LINE, NdjsonFrame, SpawnedChild, read_ndjson};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::process::{ChildStdin, ExitStatus};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::thread;
use std::time::{Duration, Instant};
use thiserror::Error;

const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);

type CallResult = Result<Value, JsonRpcError>;
type NotificationHandler = dyn Fn(String, Value) + Send + Sync;
type ServerRequestHandler = dyn Fn(String, Value, RpcResponder) + Send + Sync;
type StderrHandler = dyn Fn(String) + Send + Sync;

#[derive(Clone, Debug, Error, PartialEq)]
pub enum JsonRpcError {
    #[error("JSON-RPC error {code}: {message}")]
    Protocol {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    #[error("{0}")]
    Transport(String),
    #[error("transport disposed")]
    Disposed,
    #[error("JSON-RPC request timed out")]
    TimedOut,
}

struct RpcState {
    pending: HashMap<u64, Sender<CallResult>>,
    failure: Option<JsonRpcError>,
    stdout_closed: bool,
}

struct RpcInner {
    label: String,
    next_id: AtomicU64,
    state: Mutex<RpcState>,
    writer: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<SpawnedChild>>,
    on_notification: RwLock<Arc<NotificationHandler>>,
    on_server_request: RwLock<Arc<ServerRequestHandler>>,
    on_stderr: RwLock<Arc<StderrHandler>>,
}

#[derive(Clone)]
pub struct StdioJsonRpc {
    inner: Arc<RpcInner>,
}

pub struct JsonRpcCall {
    id: u64,
    receiver: Receiver<CallResult>,
    inner: Weak<RpcInner>,
    finished: bool,
}

#[derive(Clone)]
pub struct RpcResponder {
    id: Value,
    inner: Weak<RpcInner>,
    responded: Arc<AtomicBool>,
}

impl StdioJsonRpc {
    pub fn new(mut child: SpawnedChild, label: impl Into<String>) -> Result<Self, JsonRpcError> {
        let label = label.into();
        let writer = child
            .take_stdin()
            .ok_or_else(|| JsonRpcError::Transport(format!("{label} stdin is unavailable")))?;
        let stdout = child
            .take_stdout()
            .ok_or_else(|| JsonRpcError::Transport(format!("{label} stdout is unavailable")))?;
        let stderr = child
            .take_stderr()
            .ok_or_else(|| JsonRpcError::Transport(format!("{label} stderr is unavailable")))?;
        let inner = Arc::new(RpcInner {
            label,
            next_id: AtomicU64::new(1),
            state: Mutex::new(RpcState {
                pending: HashMap::new(),
                failure: None,
                stdout_closed: false,
            }),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(Some(child)),
            on_notification: RwLock::new(Arc::new(|_, _| {})),
            on_server_request: RwLock::new(Arc::new(|_, _, responder| {
                let _ = responder.respond(Value::Null);
            })),
            on_stderr: RwLock::new(Arc::new(|_| {})),
        });
        let peer = Self { inner };
        peer.start_worker("harness-jsonrpc-stdout", move |inner| {
            let result = read_ndjson(stdout, DEFAULT_MAX_NDJSON_LINE, |frame| {
                if let Some(inner) = inner.upgrade() {
                    handle_frame(&inner, frame);
                }
            });
            if let Some(inner) = inner.upgrade() {
                if let Err(error) = result {
                    inner.finish(JsonRpcError::Transport(format!(
                        "{} stdout failed: {error}",
                        inner.label
                    )));
                    inner.stop_child();
                } else {
                    inner.mark_stdout_closed();
                }
            }
        })?;
        peer.start_worker("harness-jsonrpc-stderr", move |inner| {
            read_stderr(stderr, inner);
        })?;
        peer.start_worker("harness-jsonrpc-exit", monitor_child)?;
        Ok(peer)
    }

    pub fn on_notification(&self, handler: impl Fn(String, Value) + Send + Sync + 'static) {
        *write_lock(&self.inner.on_notification) = Arc::new(handler);
    }

    pub fn on_server_request(
        &self,
        handler: impl Fn(String, Value, RpcResponder) + Send + Sync + 'static,
    ) {
        *write_lock(&self.inner.on_server_request) = Arc::new(handler);
    }

    pub fn on_stderr(&self, handler: impl Fn(String) + Send + Sync + 'static) {
        *write_lock(&self.inner.on_stderr) = Arc::new(handler);
    }

    pub fn begin_request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<JsonRpcCall, JsonRpcError> {
        let method = method.into();
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        {
            let mut state = lock(&self.inner.state);
            if let Some(failure) = &state.failure {
                return Err(failure.clone());
            }
            state.pending.insert(id, sender);
        }
        if let Err(error) = self.inner.write_message(
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        ) {
            self.inner.finish(error.clone());
            return Err(error);
        }
        Ok(JsonRpcCall {
            id,
            receiver,
            inner: Arc::downgrade(&self.inner),
            finished: false,
        })
    }

    pub fn request(
        &self,
        method: impl Into<String>,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, JsonRpcError> {
        self.begin_request(method, params)?.wait_timeout(timeout)
    }

    pub fn notify(&self, method: impl Into<String>, params: Value) -> Result<(), JsonRpcError> {
        self.inner.write_message(&json!({
            "jsonrpc": "2.0",
            "method": method.into(),
            "params": params,
        }))
    }

    pub fn dispose(&self) {
        self.inner.finish(JsonRpcError::Disposed);
        self.inner.stop_child();
    }

    pub fn failure(&self) -> Option<JsonRpcError> {
        lock(&self.inner.state).failure.clone()
    }

    fn start_worker(
        &self,
        name: &str,
        worker: impl FnOnce(Weak<RpcInner>) + Send + 'static,
    ) -> Result<(), JsonRpcError> {
        let inner = Arc::downgrade(&self.inner);
        thread::Builder::new()
            .name(name.into())
            .spawn(move || worker(inner))
            .map(|_| ())
            .map_err(|error| {
                self.dispose();
                JsonRpcError::Transport(format!("could not start {name}: {error}"))
            })
    }
}

impl Drop for RpcInner {
    fn drop(&mut self) {
        if let Ok(writer) = self.writer.get_mut() {
            writer.take();
        }
        if let Ok(child) = self.child.get_mut()
            && let Some(child) = child.as_mut()
        {
            let _ = child.kill_tree();
        }
    }
}

impl JsonRpcCall {
    pub fn wait(mut self) -> Result<Value, JsonRpcError> {
        let result = self
            .receiver
            .recv()
            .unwrap_or_else(|_| Err(JsonRpcError::Transport("JSON-RPC call dropped".into())));
        self.remove_pending();
        self.finished = true;
        result
    }

    pub fn wait_timeout(mut self, timeout: Duration) -> Result<Value, JsonRpcError> {
        let result = match self.receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(JsonRpcError::TimedOut),
            Err(RecvTimeoutError::Disconnected) => {
                Err(JsonRpcError::Transport("JSON-RPC call dropped".into()))
            }
        };
        self.remove_pending();
        self.finished = true;
        result
    }

    fn remove_pending(&self) {
        if let Some(inner) = self.inner.upgrade() {
            lock(&inner.state).pending.remove(&self.id);
        }
    }
}

impl Drop for JsonRpcCall {
    fn drop(&mut self) {
        if !self.finished {
            self.remove_pending();
        }
    }
}

impl RpcResponder {
    pub fn respond(&self, result: Value) -> Result<(), JsonRpcError> {
        self.send_once(json!({ "jsonrpc": "2.0", "id": self.id, "result": result }))
    }

    pub fn respond_error(&self, error: JsonRpcError) -> Result<(), JsonRpcError> {
        let JsonRpcError::Protocol {
            code,
            message,
            data,
        } = error
        else {
            return self.respond_error(JsonRpcError::Protocol {
                code: -32_603,
                message: error.to_string(),
                data: None,
            });
        };
        self.send_once(json!({
            "jsonrpc": "2.0",
            "id": self.id,
            "error": { "code": code, "message": message, "data": data },
        }))
    }

    fn send_once(&self, message: Value) -> Result<(), JsonRpcError> {
        if self.responded.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.inner
            .upgrade()
            .ok_or(JsonRpcError::Disposed)?
            .write_message(&message)
    }
}

impl RpcInner {
    fn write_message(&self, message: &Value) -> Result<(), JsonRpcError> {
        if let Some(failure) = &lock(&self.state).failure {
            return Err(failure.clone());
        }
        let mut bytes = serde_json::to_vec(message).map_err(|error| {
            JsonRpcError::Transport(format!("could not encode JSON-RPC: {error}"))
        })?;
        bytes.push(b'\n');
        let result = {
            let mut writer = lock(&self.writer);
            match writer.as_mut() {
                Some(writer) => writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .map_err(|error| {
                        JsonRpcError::Transport(format!("{} stdin failed: {error}", self.label))
                    }),
                None => Err(lock(&self.state).failure.clone().unwrap_or_else(|| {
                    JsonRpcError::Transport(format!("{} stdin is closed", self.label))
                })),
            }
        };
        if let Err(error) = &result {
            self.finish(error.clone());
            self.stop_child();
        }
        result
    }

    fn settle(&self, id: u64, result: CallResult) {
        let sender = lock(&self.state).pending.remove(&id);
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }

    fn finish(&self, error: JsonRpcError) {
        let pending = {
            let mut state = lock(&self.state);
            if state.failure.is_some() {
                return;
            }
            state.failure = Some(error.clone());
            state
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        };
        lock(&self.writer).take();
        for sender in pending {
            let _ = sender.send(Err(error.clone()));
        }
        *write_lock(&self.on_notification) = Arc::new(|_, _| {});
        *write_lock(&self.on_server_request) = Arc::new(|_, _, responder| {
            let _ = responder.respond(Value::Null);
        });
        *write_lock(&self.on_stderr) = Arc::new(|_| {});
    }

    fn mark_stdout_closed(&self) {
        lock(&self.state).stdout_closed = true;
    }

    fn stop_child(&self) {
        let mut child = lock(&self.child);
        if let Some(child) = child.as_mut() {
            let _ = child.kill_tree();
        }
        child.take();
    }

    fn report_stderr(&self, text: String) {
        let handler = Arc::clone(&read_lock(&self.on_stderr));
        let _ = catch_unwind(AssertUnwindSafe(|| handler(text)));
    }
}

fn handle_frame(inner: &Arc<RpcInner>, frame: NdjsonFrame) {
    if lock(&inner.state).failure.is_some() {
        return;
    }
    match frame {
        NdjsonFrame::Unparsable(line) => {
            inner.report_stderr(format!("non-JSON on stdout: {line}"));
        }
        NdjsonFrame::Oversized { max_bytes } => {
            inner.report_stderr(format!("JSON-RPC line exceeded {max_bytes} bytes"));
        }
        NdjsonFrame::Value(Value::Object(message)) => handle_message(inner, message),
        NdjsonFrame::Value(_) => inner.report_stderr("non-object JSON-RPC frame".into()),
    }
}

fn handle_message(inner: &Arc<RpcInner>, message: serde_json::Map<String, Value>) {
    let id = message.get("id").cloned();
    let method_value = message.get("method");
    if method_value.is_none() {
        if let Some(id) = id.and_then(|id| id.as_u64()) {
            let result = match message.get("error") {
                Some(Value::Object(error)) => Err(JsonRpcError::Protocol {
                    code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .into(),
                    data: error.get("data").cloned(),
                }),
                Some(error) if !error.is_null() => Err(JsonRpcError::Protocol {
                    code: 0,
                    message: "unknown error".into(),
                    data: Some(error.clone()),
                }),
                _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            inner.settle(id, result);
        }
        return;
    }
    let Some(method) = method_value.and_then(Value::as_str).map(str::to_owned) else {
        inner.report_stderr("JSON-RPC method must be a string".into());
        return;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    if let Some(id) = id {
        let responder = RpcResponder {
            id,
            inner: Arc::downgrade(inner),
            responded: Arc::new(AtomicBool::new(false)),
        };
        let handler = Arc::clone(&read_lock(&inner.on_server_request));
        let result = catch_unwind(AssertUnwindSafe(|| {
            handler(method.clone(), params, responder)
        }));
        if result.is_err() {
            inner.report_stderr(format!("handler failed for {method}: panic"));
        }
        return;
    }
    let handler = Arc::clone(&read_lock(&inner.on_notification));
    if catch_unwind(AssertUnwindSafe(|| handler(method.clone(), params))).is_err() {
        inner.report_stderr(format!("handler failed for {method}: panic"));
    }
}

fn read_stderr(mut reader: impl Read, inner: Weak<RpcInner>) {
    let mut bytes = [0_u8; 8192];
    loop {
        match reader.read(&mut bytes) {
            Ok(0) => return,
            Ok(read) => {
                if let Some(inner) = inner.upgrade() {
                    inner.report_stderr(String::from_utf8_lossy(&bytes[..read]).into_owned());
                } else {
                    return;
                }
            }
            Err(error) => {
                if let Some(inner) = inner.upgrade() {
                    inner.report_stderr(format!("stderr failed: {error}"));
                }
                return;
            }
        }
    }
}

fn monitor_child(inner: Weak<RpcInner>) {
    loop {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let status = {
            let mut child = lock(&inner.child);
            let Some(child) = child.as_mut() else {
                return;
            };
            match child.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    inner.finish(JsonRpcError::Transport(error.to_string()));
                    return;
                }
            }
        };
        if let Some(status) = status {
            wait_for_stdout_drain(&inner);
            inner.finish(exit_error(&inner.label, status));
            lock(&inner.child).take();
            return;
        }
        if lock(&inner.state).stdout_closed {
            inner.finish(JsonRpcError::Transport(format!(
                "{} stdout closed",
                inner.label
            )));
            inner.stop_child();
            return;
        }
        drop(inner);
        thread::sleep(EXIT_POLL_INTERVAL);
    }
}

fn wait_for_stdout_drain(inner: &RpcInner) {
    let deadline = Instant::now() + OUTPUT_DRAIN_TIMEOUT;
    while !lock(&inner.state).stdout_closed && Instant::now() < deadline {
        thread::sleep(EXIT_POLL_INTERVAL);
    }
}

fn exit_error(label: &str, status: ExitStatus) -> JsonRpcError {
    let code = status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "null".into());
    JsonRpcError::Transport(format!("{label} exited (code {code})"))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn read_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn write_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SpawnOptions, spawn_cli};
    use std::ffi::OsStr;
    use std::io::{BufRead, BufReader};

    const RPC_HELPER: &str = "HARNESS_PROC_RPC_HELPER";

    #[test]
    fn routes_responses_notifications_and_colliding_server_request_ids() {
        let peer = rpc_peer();
        let (notification_tx, notification_rx) = mpsc::channel();
        let (stderr_tx, stderr_rx) = mpsc::channel();
        peer.on_notification(move |method, params| {
            let _ = notification_tx.send((method, params));
        });
        peer.on_stderr(move |text| {
            let _ = stderr_tx.send(text);
        });
        peer.on_server_request(|method, params, responder| {
            assert_eq!(method, "permission");
            assert_eq!(params, json!({ "path": "file.txt" }));
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(20));
                responder.respond(json!({ "allow": true })).unwrap();
                responder.respond(json!({ "allow": false })).unwrap();
            });
        });

        assert_eq!(
            peer.request("echo", json!({ "value": 7 }), Duration::from_secs(2))
                .unwrap(),
            json!({ "value": 7 })
        );
        assert_eq!(
            notification_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap(),
            ("ready".into(), json!({ "ok": true }))
        );
        assert!(
            stderr_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .contains("non-JSON on stdout")
        );

        assert_eq!(
            peer.request("ask_server", json!({}), Duration::from_secs(2))
                .unwrap(),
            json!({ "allowed": true })
        );
        assert_eq!(
            peer.request("protocol_error", json!({}), Duration::from_secs(2)),
            Err(JsonRpcError::Protocol {
                code: -32_000,
                message: "provider refused".into(),
                data: Some(json!({ "retry": false })),
            })
        );
        peer.dispose();
    }

    #[test]
    fn contains_panicking_handlers_and_remains_usable_after_a_call_timeout() {
        let peer = rpc_peer();
        let (stderr_tx, stderr_rx) = mpsc::channel();
        peer.on_stderr(move |text| {
            let _ = stderr_tx.send(text);
        });
        peer.on_notification(|method, _params| {
            if method == "panic-now" {
                panic!("adapter handler panic");
            }
        });

        assert_eq!(
            peer.request("notify_panic", json!({}), Duration::from_secs(2))
                .unwrap(),
            json!({ "survived": true })
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut handler_failure = false;
        while Instant::now() < deadline && !handler_failure {
            if let Ok(text) = stderr_rx.recv_timeout(Duration::from_millis(50)) {
                handler_failure = text.contains("handler failed for panic-now");
            }
        }
        assert!(handler_failure);

        assert_eq!(
            peer.request("hang", json!({}), Duration::from_millis(50)),
            Err(JsonRpcError::TimedOut)
        );
        assert_eq!(
            peer.request("echo", json!({ "value": 8 }), Duration::from_secs(2))
                .unwrap(),
            json!({ "value": 8 })
        );
        peer.dispose();
    }

    #[test]
    fn drains_a_final_unterminated_response_before_reporting_child_exit() {
        let peer = rpc_peer();
        assert_eq!(
            peer.request("final", json!({}), Duration::from_secs(2))
                .unwrap(),
            json!({ "last": true })
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while peer.failure().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(peer.failure(), Some(JsonRpcError::Transport(_))));
        assert!(matches!(
            peer.begin_request("late", json!({})),
            Err(JsonRpcError::Transport(_))
        ));
    }

    #[test]
    fn dispose_fails_every_pending_call_without_waiting_for_the_child() {
        let peer = rpc_peer();
        let first = peer.begin_request("hang", json!({})).unwrap();
        let second = peer.begin_request("hang", json!({})).unwrap();
        peer.dispose();
        assert_eq!(first.wait(), Err(JsonRpcError::Disposed));
        assert_eq!(second.wait(), Err(JsonRpcError::Disposed));
        assert_eq!(peer.failure(), Some(JsonRpcError::Disposed));
    }

    #[test]
    fn rpc_helper() {
        if std::env::var_os(RPC_HELPER).is_none() {
            return;
        }
        let stdin = std::io::stdin();
        let mut lines = BufReader::new(stdin.lock()).lines();
        let stdout = std::io::stdout();
        let mut stdout = stdout.lock();
        while let Some(Ok(line)) = lines.next() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let id = request["id"].clone();
            match request["method"].as_str().unwrap_or_default() {
                "echo" => {
                    writeln!(stdout, "adapter startup warning").unwrap();
                    writeln!(
                        stdout,
                        "{}",
                        json!({ "jsonrpc": "2.0", "method": "ready", "params": { "ok": true } })
                    )
                    .unwrap();
                    writeln!(
                        stdout,
                        "{}",
                        json!({ "jsonrpc": "2.0", "id": id, "result": request["params"] })
                    )
                    .unwrap();
                    stdout.flush().unwrap();
                }
                "ask_server" => {
                    writeln!(
                        stdout,
                        "{}",
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "method": "permission",
                            "params": { "path": "file.txt" }
                        })
                    )
                    .unwrap();
                    stdout.flush().unwrap();
                    let response: Value =
                        serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
                    writeln!(
                        stdout,
                        "{}",
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "allowed": response["result"]["allow"] }
                        })
                    )
                    .unwrap();
                    stdout.flush().unwrap();
                }
                "protocol_error" => {
                    writeln!(
                        stdout,
                        "{}",
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32_000,
                                "message": "provider refused",
                                "data": { "retry": false }
                            }
                        })
                    )
                    .unwrap();
                    stdout.flush().unwrap();
                }
                "notify_panic" => {
                    writeln!(
                        stdout,
                        "{}",
                        json!({ "jsonrpc": "2.0", "method": "panic-now", "params": {} })
                    )
                    .unwrap();
                    writeln!(
                        stdout,
                        "{}",
                        json!({ "jsonrpc": "2.0", "id": id, "result": { "survived": true } })
                    )
                    .unwrap();
                    stdout.flush().unwrap();
                }
                "hang" => {}
                "final" => {
                    write!(
                        stdout,
                        "{}",
                        json!({ "jsonrpc": "2.0", "id": id, "result": { "last": true } })
                    )
                    .unwrap();
                    stdout.flush().unwrap();
                    std::process::exit(0);
                }
                method => panic!("unexpected helper method: {method}"),
            }
        }
    }

    fn rpc_peer() -> StdioJsonRpc {
        let executable = std::env::current_exe().unwrap();
        let child = spawn_cli(
            executable.as_os_str(),
            &[
                OsStr::new("--exact"),
                OsStr::new("jsonrpc::tests::rpc_helper"),
                OsStr::new("--nocapture"),
            ],
            &SpawnOptions::default().env(RPC_HELPER, "1"),
        )
        .unwrap();
        StdioJsonRpc::new(child, "fake agent").unwrap()
    }
}
