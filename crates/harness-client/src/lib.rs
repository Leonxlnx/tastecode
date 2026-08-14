//! Native TasteCode protocol transport.
//!
//! The transport owns reconnect and sequence tracking, while callers own
//! application-level resync. No provider behavior belongs in this crate.

use async_channel::{Receiver as EventReceiver, Sender as EventSender};
use harness_protocol::{InboundFrame, Push, Request, Response};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error as WebSocketError, Message, WebSocket, connect};
use url::Url;

const READ_POLL_INTERVAL: Duration = Duration::from_millis(40);
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_millis(500);
const INITIAL_RECONNECT_DELAY: Duration = Duration::ZERO;
const FIRST_BACKOFF_DELAY: Duration = Duration::from_millis(100);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint(String);

impl Endpoint {
    pub fn loopback(port: u16) -> Self {
        Self(format!("ws://127.0.0.1:{port}"))
    }

    pub fn parse(value: &str) -> Result<Self, ClientError> {
        let url = Url::parse(value).map_err(|_| ClientError::InvalidEndpoint)?;
        if url.scheme() != "ws"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || url.username() != ""
            || url.password().is_some()
        {
            return Err(ClientError::InvalidEndpoint);
        }
        Ok(Self(url.to_string()))
    }

    pub fn from_environment() -> Result<Self, ClientError> {
        match std::env::var("HARNESS_SERVER_URL") {
            Ok(value) => Self::parse(&value),
            Err(_) => Ok(Self::loopback(4311)),
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    Open,
    Reconnecting,
    Closed,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClientEvent {
    StateChanged(ConnectionState),
    Response(Response<Value>),
    Push(Push<Value>),
    SequenceGap { expected: u64, received: u64 },
    RequestAborted { id: String },
    DecodeFailed { reason: String },
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("the TasteCode server URL must be ws://127.0.0.1:<port>")]
    InvalidEndpoint,
    #[error("the TasteCode transport is closed")]
    Closed,
    #[error("request serialization failed")]
    Serialize(#[source] serde_json::Error),
    #[error("failed to start the TasteCode transport")]
    Start(#[source] std::io::Error),
}

#[derive(Clone)]
pub struct ClientHandle {
    inner: Arc<ClientInner>,
}

struct ClientInner {
    commands: Sender<Command>,
    next_id: AtomicU64,
}

impl Drop for ClientInner {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
    }
}

enum Command {
    Send(Outbound),
    Probe(Outbound),
    Shutdown,
}

struct Outbound {
    id: String,
    text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionExit {
    Shutdown,
    Reconnect { server_spoke: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackoffExit {
    Elapsed,
    Probe,
    Shutdown,
}

impl ClientHandle {
    pub fn start(endpoint: Endpoint) -> Result<(Self, EventReceiver<ClientEvent>), ClientError> {
        let (command_tx, command_rx) = mpsc::channel();
        let (event_tx, event_rx) = async_channel::unbounded();
        thread::Builder::new()
            .name("harness-protocol".into())
            .spawn(move || run_transport(endpoint, command_rx, event_tx))
            .map_err(ClientError::Start)?;

        Ok((
            Self {
                inner: Arc::new(ClientInner {
                    commands: command_tx,
                    next_id: AtomicU64::new(1),
                }),
            },
            event_rx,
        ))
    }

    pub fn request<P: Serialize>(&self, method: &str, params: P) -> Result<String, ClientError> {
        let number = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let id = format!("native-{number}");
        let request = Request::new(id.clone(), method, params);
        let text = serde_json::to_string(&request).map_err(ClientError::Serialize)?;
        self.inner
            .commands
            .send(Command::Send(Outbound {
                id: id.clone(),
                text,
            }))
            .map_err(|_| ClientError::Closed)?;
        Ok(id)
    }

    pub fn ensure_healthy(&self) -> Result<(), ClientError> {
        let number = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let id = format!("native-health-{number}");
        let request = Request::new(id.clone(), "system.info", serde_json::json!({}));
        let text = serde_json::to_string(&request).map_err(ClientError::Serialize)?;
        self.inner
            .commands
            .send(Command::Probe(Outbound { id, text }))
            .map_err(|_| ClientError::Closed)
    }
}

fn run_transport(
    endpoint: Endpoint,
    commands: Receiver<Command>,
    events: EventSender<ClientEvent>,
) {
    let mut pending: VecDeque<Outbound> = VecDeque::new();
    let mut state = ConnectionState::Connecting;
    let mut reconnect_delay = INITIAL_RECONNECT_DELAY;
    emit(&events, ClientEvent::StateChanged(state));

    loop {
        if drain_commands(&commands, &mut pending) {
            break;
        }

        match connect(endpoint.as_str()) {
            Ok((mut socket, _response)) => {
                configure_socket(&mut socket);
                state = ConnectionState::Open;
                emit(&events, ClientEvent::StateChanged(state));
                match run_connection(&mut socket, &commands, &events, &mut pending) {
                    ConnectionExit::Shutdown => break,
                    ConnectionExit::Reconnect { server_spoke } => {
                        if server_spoke {
                            reconnect_delay = INITIAL_RECONNECT_DELAY;
                        }
                    }
                }
            }
            Err(_error) => {}
        }

        if state != ConnectionState::Reconnecting {
            state = ConnectionState::Reconnecting;
            emit(&events, ClientEvent::StateChanged(state));
        }
        match collect_during_backoff(&commands, &mut pending, reconnect_delay) {
            BackoffExit::Shutdown => break,
            BackoffExit::Elapsed => {
                reconnect_delay = next_reconnect_delay(reconnect_delay);
            }
            BackoffExit::Probe => {}
        }
    }

    emit(&events, ClientEvent::StateChanged(ConnectionState::Closed));
}

fn configure_socket(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) {
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(READ_POLL_INTERVAL));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    }
}

/// Returns true when the transport should shut down rather than reconnect.
fn run_connection(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    commands: &Receiver<Command>,
    events: &EventSender<ClientEvent>,
    pending: &mut VecDeque<Outbound>,
) -> ConnectionExit {
    let mut sequence = SequenceTracker::default();
    let mut in_flight = HashSet::new();
    let mut health_check: Option<(String, Instant)> = None;
    let mut server_spoke = false;

    loop {
        match commands.try_recv() {
            Ok(Command::Send(outbound)) => pending.push_back(outbound),
            Ok(Command::Probe(outbound)) if health_check.is_none() => {
                health_check = Some((outbound.id.clone(), Instant::now() + HEALTH_CHECK_TIMEOUT));
                pending.push_back(outbound);
            }
            Ok(Command::Probe(_)) => {}
            Ok(Command::Shutdown) | Err(TryRecvError::Disconnected) => {
                let _ = socket.close(None);
                return ConnectionExit::Shutdown;
            }
            Err(TryRecvError::Empty) => {}
        }

        while let Some(outbound) = pending.pop_front() {
            if socket.send(Message::text(outbound.text)).is_err() {
                emit(events, ClientEvent::RequestAborted { id: outbound.id });
                abort_in_flight(events, &mut in_flight);
                return ConnectionExit::Reconnect { server_spoke };
            }
            in_flight.insert(outbound.id);
        }

        let response_id = match socket.read() {
            Ok(Message::Text(text)) => {
                server_spoke = true;
                decode_frame(text.as_str(), events, &mut sequence, &mut in_flight)
            }
            Ok(Message::Close(_)) => {
                abort_in_flight(events, &mut in_flight);
                return ConnectionExit::Reconnect { server_spoke };
            }
            Ok(Message::Ping(_) | Message::Pong(_)) => {
                let _ = socket.flush();
                None
            }
            Ok(Message::Binary(_) | Message::Frame(_)) => {
                server_spoke = true;
                emit(
                    events,
                    ClientEvent::DecodeFailed {
                        reason: "expected a text WebSocket frame".into(),
                    },
                );
                None
            }
            Err(error) if is_read_timeout(&error) => None,
            Err(_) => {
                abort_in_flight(events, &mut in_flight);
                return ConnectionExit::Reconnect { server_spoke };
            }
        };
        if response_id.as_ref().is_some_and(|response_id| {
            health_check
                .as_ref()
                .is_some_and(|(health_id, _)| response_id == health_id)
        }) {
            health_check = None;
        }
        if health_check
            .as_ref()
            .is_some_and(|(_, deadline)| Instant::now() >= *deadline)
        {
            abort_in_flight(events, &mut in_flight);
            return ConnectionExit::Reconnect { server_spoke };
        }
    }
}

fn decode_frame(
    text: &str,
    events: &EventSender<ClientEvent>,
    sequence: &mut SequenceTracker,
    in_flight: &mut HashSet<String>,
) -> Option<String> {
    match serde_json::from_str::<InboundFrame>(text) {
        Ok(InboundFrame::Response(response)) => {
            let id = response.id().to_owned();
            in_flight.remove(&id);
            emit(events, ClientEvent::Response(response));
            Some(id)
        }
        Ok(InboundFrame::Push(push)) => {
            if let Some((expected, received)) = sequence.observe(push.sequence) {
                emit(events, ClientEvent::SequenceGap { expected, received });
            }
            emit(events, ClientEvent::Push(push));
            None
        }
        Err(error) => {
            emit(
                events,
                ClientEvent::DecodeFailed {
                    reason: error.to_string(),
                },
            );
            None
        }
    }
}

fn is_read_timeout(error: &WebSocketError) -> bool {
    matches!(
        error,
        WebSocketError::Io(io_error)
            if matches!(io_error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
    )
}

fn drain_commands(commands: &Receiver<Command>, pending: &mut VecDeque<Outbound>) -> bool {
    loop {
        match commands.try_recv() {
            Ok(Command::Send(outbound)) => pending.push_back(outbound),
            Ok(Command::Probe(_)) => {}
            Ok(Command::Shutdown) | Err(TryRecvError::Disconnected) => return true,
            Err(TryRecvError::Empty) => return false,
        }
    }
}

fn collect_during_backoff(
    commands: &Receiver<Command>,
    pending: &mut VecDeque<Outbound>,
    delay: Duration,
) -> BackoffExit {
    let deadline = Instant::now() + delay;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return BackoffExit::Elapsed;
        }
        match commands.recv_timeout(remaining) {
            Ok(Command::Send(outbound)) => pending.push_back(outbound),
            Ok(Command::Probe(_)) => return BackoffExit::Probe,
            Ok(Command::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                return BackoffExit::Shutdown;
            }
            Err(RecvTimeoutError::Timeout) => return BackoffExit::Elapsed,
        }
    }
}

fn next_reconnect_delay(current: Duration) -> Duration {
    if current.is_zero() {
        FIRST_BACKOFF_DELAY
    } else {
        (current * 2).min(MAX_RECONNECT_DELAY)
    }
}

fn emit(events: &EventSender<ClientEvent>, event: ClientEvent) {
    let _ = events.send_blocking(event);
}

fn abort_in_flight(events: &EventSender<ClientEvent>, in_flight: &mut HashSet<String>) {
    for id in in_flight.drain() {
        emit(events, ClientEvent::RequestAborted { id });
    }
}

#[derive(Default)]
struct SequenceTracker {
    last: Option<u64>,
}

impl SequenceTracker {
    fn observe(&mut self, sequence: u64) -> Option<(u64, u64)> {
        let gap = self
            .last
            .and_then(|last| (sequence != last.saturating_add(1)).then_some((last + 1, sequence)));
        self.last = Some(sequence);
        gap
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn endpoint_is_explicitly_loopback_only() {
        assert!(Endpoint::parse("ws://127.0.0.1:4311").is_ok());
        assert!(Endpoint::parse("ws://localhost:4311").is_err());
        assert!(Endpoint::parse("ws://192.168.1.20:4311").is_err());
        assert!(Endpoint::parse("wss://127.0.0.1:4311").is_err());
        assert!(Endpoint::parse("ws://127.0.0.1").is_err());
    }

    #[test]
    fn sequence_tracker_reports_duplicates_and_gaps() {
        let mut tracker = SequenceTracker::default();
        assert_eq!(tracker.observe(1), None);
        assert_eq!(tracker.observe(2), None);
        assert_eq!(tracker.observe(4), Some((3, 4)));
        assert_eq!(tracker.observe(4), Some((5, 4)));
    }

    #[test]
    fn request_ids_are_stable_and_monotonic_before_connection() {
        let endpoint = Endpoint::loopback(9);
        let (client, _events) = ClientHandle::start(endpoint).unwrap();
        let first = client.request("system.info", json!({})).unwrap();
        let second = client.request("projects.list", json!({})).unwrap();
        assert_eq!(first, "native-1");
        assert_eq!(second, "native-2");
    }

    #[test]
    fn health_probe_uses_a_private_system_info_request() {
        let (commands, receiver) = mpsc::channel();
        let client = ClientHandle {
            inner: Arc::new(ClientInner {
                commands,
                next_id: AtomicU64::new(7),
            }),
        };

        client.ensure_healthy().unwrap();

        let Command::Probe(outbound) = receiver.recv().unwrap() else {
            panic!("expected a health probe");
        };
        let payload = serde_json::from_str::<Value>(&outbound.text).unwrap();
        assert_eq!(outbound.id, "native-health-7");
        assert_eq!(payload["id"], "native-health-7");
        assert_eq!(payload["method"], "system.info");
        assert_eq!(payload["params"], json!({}));
    }

    #[test]
    fn reconnect_backoff_starts_immediately_and_caps_at_one_second() {
        let first = next_reconnect_delay(Duration::ZERO);
        let second = next_reconnect_delay(first);
        let third = next_reconnect_delay(second);

        assert_eq!(first, Duration::from_millis(100));
        assert_eq!(second, Duration::from_millis(200));
        assert_eq!(third, Duration::from_millis(400));
        assert_eq!(
            next_reconnect_delay(Duration::from_millis(800)),
            MAX_RECONNECT_DELAY
        );
        assert_eq!(
            next_reconnect_delay(MAX_RECONNECT_DELAY),
            MAX_RECONNECT_DELAY
        );
    }

    #[test]
    fn focus_probe_interrupts_backoff_without_advancing_it() {
        let (sender, commands) = mpsc::channel();
        sender
            .send(Command::Probe(Outbound {
                id: "native-health-1".into(),
                text: "probe".into(),
            }))
            .unwrap();
        let mut pending = VecDeque::new();

        assert_eq!(
            collect_during_backoff(&commands, &mut pending, MAX_RECONNECT_DELAY),
            BackoffExit::Probe
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn disconnect_aborts_every_request_that_was_actually_sent() {
        let (events, receiver) = async_channel::unbounded();
        let mut in_flight = HashSet::from(["native-2".into(), "native-7".into()]);

        abort_in_flight(&events, &mut in_flight);

        let mut ids = vec![];
        while let Ok(ClientEvent::RequestAborted { id }) = receiver.try_recv() {
            ids.push(id);
        }
        ids.sort();
        assert_eq!(ids, ["native-2", "native-7"]);
        assert!(in_flight.is_empty());
    }
}
