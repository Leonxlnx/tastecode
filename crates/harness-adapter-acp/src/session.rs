use crate::agents::AcpAgentSpec;
use crate::approvals::{PermissionOption, option_for};
use crate::events::AcpEventMapper;
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentSession, AgentSessionState, StartOptions,
    TurnOptions,
};
use harness_proc::{JsonRpcError, RpcResponder, SpawnOptions, StdioJsonRpc, spawn_cli};
use harness_protocol::{
    ApprovalDecision, ApprovalKind, ApprovalMode, ApprovalRequest, Capabilities, DomainEvent,
    ProviderId, Thread, Turn, TurnStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const PROTOCOL_VERSION: u64 = 1;
const SESSION_STATE_VERSION: u32 = 1;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

pub const ACP_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: true,
    approvals: true,
    user_input: None,
    auto_review: None,
    // ACP can advertise images, but this adapter still sends text prompt
    // blocks only. Reporting false keeps the end-to-end capability honest.
    images: false,
};

#[derive(Clone, Debug)]
pub(crate) struct AcpCommand {
    pub(crate) program: OsString,
    pub(crate) prefix_args: Vec<OsString>,
    pub(crate) environment: Vec<(OsString, OsString)>,
    pub(crate) append_agent_args: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AcpSessionState {
    pub version: u32,
    pub thread: Thread,
    pub agent_id: String,
    pub model: Option<String>,
    pub approval: ApprovalMode,
    pub instructions: Option<String>,
    pub instructions_pending: bool,
    pub session_id: String,
    pub turn_counter: u64,
}

pub struct AcpSession {
    inner: Arc<SessionInner>,
}

struct SessionInner {
    spec: &'static AcpAgentSpec,
    thread: Thread,
    model: Option<String>,
    approval: ApprovalMode,
    instructions: Option<String>,
    session_id: String,
    rpc: StdioJsonRpc,
    handlers: AgentHandlers,
    state: Mutex<LiveState>,
    disposed: AtomicBool,
}

struct LiveState {
    turn_counter: u64,
    instructions_pending: bool,
    active: Option<ActiveTurn>,
    pending_approvals: Vec<PendingApproval>,
}

struct ActiveTurn {
    id: String,
    mapper: AcpEventMapper,
}

struct PendingApproval {
    id: String,
    responder: RpcResponder,
    options: Vec<PermissionOption>,
}

struct CallbackBridge {
    agent_name: &'static str,
    handlers: AgentHandlers,
    session: Mutex<Option<Weak<SessionInner>>>,
}

struct Connection {
    rpc: StdioJsonRpc,
    bridge: Arc<CallbackBridge>,
    load_session: bool,
}

impl AcpSession {
    pub(crate) fn start(
        spec: &'static AcpAgentSpec,
        command: AcpCommand,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        validate_workspace(workspace_path)?;
        validate_approval(options.approval)?;
        let connection = connect(
            spec,
            &command,
            workspace_path,
            options.model.as_deref(),
            &handlers,
        )?;
        let session = connection
            .rpc
            .request(
                "session/new",
                json!({ "cwd": workspace_path, "mcpServers": [] }),
                HANDSHAKE_TIMEOUT,
            )
            .map_err(|error| new_session_error(spec, error))?;
        let session_id = session
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AgentError::Failed(format!("{} started no session", spec.name)))?
            .to_owned();
        select_session_model(&connection.rpc, spec, &session_id, options.model.as_deref())?;
        let thread = Thread {
            id: format!("acp-{}-{session_id}", spec.id),
            provider: ProviderId::Acp,
            connection_id: None,
            workspace_path: workspace_path.into(),
            title: None,
            created_at: now_ms(),
        };
        let session = Arc::new(Self {
            inner: Arc::new(SessionInner {
                spec,
                thread: thread.clone(),
                model: options.model.clone(),
                approval: options.approval.unwrap_or(ApprovalMode::Ask),
                instructions: options.instructions.clone(),
                session_id,
                rpc: connection.rpc,
                handlers,
                state: Mutex::new(LiveState {
                    turn_counter: 0,
                    instructions_pending: options
                        .instructions
                        .as_deref()
                        .is_some_and(|text| !text.is_empty()),
                    active: None,
                    pending_approvals: Vec::new(),
                }),
                disposed: AtomicBool::new(false),
            }),
        });
        connection.bridge.attach(&session.inner);
        Ok((thread, session))
    }

    pub(crate) fn resume(
        spec: &'static AcpAgentSpec,
        command: AcpCommand,
        state: AcpSessionState,
        _options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        validate_state(spec, &state)?;
        let connection = connect(
            spec,
            &command,
            &state.thread.workspace_path,
            state.model.as_deref(),
            &handlers,
        )?;
        if !connection.load_session {
            connection.rpc.dispose();
            return Err(AgentError::Failed(format!(
                "{} does not support session resume",
                spec.name
            )));
        }
        connection
            .rpc
            .request(
                "session/load",
                json!({
                    "sessionId": state.session_id,
                    "cwd": state.thread.workspace_path,
                    "mcpServers": []
                }),
                HANDSHAKE_TIMEOUT,
            )
            .map_err(|error| rpc_failed(spec, "session resume", error))?;
        select_session_model(
            &connection.rpc,
            spec,
            &state.session_id,
            state.model.as_deref(),
        )?;
        let thread = state.thread.clone();
        let session = Arc::new(Self {
            inner: Arc::new(SessionInner {
                spec,
                thread: thread.clone(),
                model: state.model,
                approval: state.approval,
                instructions: state.instructions,
                session_id: state.session_id,
                rpc: connection.rpc,
                handlers,
                state: Mutex::new(LiveState {
                    turn_counter: state.turn_counter,
                    instructions_pending: state.instructions_pending,
                    active: None,
                    pending_approvals: Vec::new(),
                }),
                disposed: AtomicBool::new(false),
            }),
        });
        connection.bridge.attach(&session.inner);
        Ok((thread, session))
    }

    pub fn snapshot(&self) -> AcpSessionState {
        let state = lock(&self.inner.state);
        AcpSessionState {
            version: SESSION_STATE_VERSION,
            thread: self.inner.thread.clone(),
            agent_id: self.inner.spec.id.into(),
            model: self.inner.model.clone(),
            approval: self.inner.approval,
            instructions: self.inner.instructions.clone(),
            instructions_pending: state.instructions_pending,
            session_id: self.inner.session_id.clone(),
            turn_counter: state.turn_counter,
        }
    }

    fn send_turn_inner(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
    ) -> AgentResult<String> {
        self.require_thread(thread_id)?;
        if !attachments.is_empty() {
            return Err(AgentError::Failed(
                "ACP image prompt blocks are not supported yet".into(),
            ));
        }
        if self.inner.disposed.load(Ordering::Acquire) {
            return Err(AgentError::Failed("ACP session is closed".into()));
        }
        let (turn_id, prompt) = {
            let mut state = lock(&self.inner.state);
            if state.active.is_some() {
                return Err(AgentError::Failed("an ACP turn is already running".into()));
            }
            state.turn_counter = state.turn_counter.saturating_add(1);
            let suffix = Uuid::new_v4().simple().to_string();
            let turn_id = format!(
                "{}-turn-{}-{}",
                self.inner.thread.id,
                state.turn_counter,
                &suffix[..8]
            );
            let prompt = if state.instructions_pending {
                state.instructions_pending = false;
                self.inner
                    .instructions
                    .as_deref()
                    .filter(|instructions| !instructions.is_empty())
                    .map(|instructions| {
                        format!(
                            "<system-instructions>\n{instructions}\n</system-instructions>\n\n{text}"
                        )
                    })
                    .unwrap_or_else(|| text.into())
            } else {
                text.into()
            };
            state.active = Some(ActiveTurn {
                id: turn_id.clone(),
                mapper: AcpEventMapper::new(&turn_id),
            });
            (turn_id, prompt)
        };

        self.inner.handlers.emit_event(DomainEvent::TurnStarted {
            turn: Turn {
                id: turn_id.clone(),
                thread_id: self.inner.thread.id.clone(),
                status: TurnStatus::Running,
                created_at: now_ms(),
            },
        });
        let call = match self.inner.rpc.begin_request(
            "session/prompt",
            json!({
                "sessionId": self.inner.session_id,
                "prompt": [{ "type": "text", "text": prompt }]
            }),
        ) {
            Ok(call) => call,
            Err(error) => {
                fail_turn(&self.inner, &turn_id, error.to_string());
                return Ok(turn_id);
            }
        };
        let inner = Arc::downgrade(&self.inner);
        let worker_turn_id = turn_id.clone();
        if thread::Builder::new()
            .name("harness-acp-prompt".into())
            .spawn(move || {
                let result = call.wait();
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                if inner.disposed.load(Ordering::Acquire) {
                    return;
                }
                match result {
                    Ok(result) => finish_turn(
                        &inner,
                        &worker_turn_id,
                        result.get("stopReason").and_then(Value::as_str),
                    ),
                    Err(error) => fail_turn(&inner, &worker_turn_id, error.to_string()),
                }
            })
            .is_err()
        {
            fail_turn(
                &self.inner,
                &turn_id,
                "could not start the ACP prompt worker".into(),
            );
        }
        Ok(turn_id)
    }

    fn interrupt_inner(&self, thread_id: &str) -> AgentResult<()> {
        self.require_thread(thread_id)?;
        self.inner
            .rpc
            .notify(
                "session/cancel",
                json!({ "sessionId": self.inner.session_id }),
            )
            .map_err(|error| rpc_failed(self.inner.spec, "turn cancellation", error))
    }

    fn respond_to_approval_inner(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> AgentResult<bool> {
        let pending = {
            let mut state = lock(&self.inner.state);
            state
                .pending_approvals
                .iter()
                .position(|pending| pending.id == approval_id)
                .map(|index| state.pending_approvals.remove(index))
        };
        let Some(pending) = pending else {
            return Ok(false);
        };
        let option_id = option_for(&pending.options, decision).map(str::to_owned);
        let response = option_id.map_or_else(
            || json!({ "outcome": { "outcome": "cancelled" } }),
            |option_id| json!({ "outcome": { "outcome": "selected", "optionId": option_id } }),
        );
        if pending.responder.respond(response).is_err() {
            self.inner
                .handlers
                .emit_log("ACP permission response failed");
        }
        self.inner
            .handlers
            .emit_event(DomainEvent::ApprovalResolved {
                id: approval_id.into(),
            });
        if decision == ApprovalDecision::Abort {
            self.interrupt_inner(&self.inner.thread.id)?;
        }
        Ok(true)
    }

    fn dispose_inner(&self) {
        if self.inner.disposed.swap(true, Ordering::AcqRel) {
            return;
        }
        let pending = {
            let mut state = lock(&self.inner.state);
            state.active = None;
            std::mem::take(&mut state.pending_approvals)
        };
        cancel_approvals(&self.inner, pending, false);
        self.inner.rpc.dispose();
    }

    fn require_thread(&self, thread_id: &str) -> AgentResult<()> {
        if self.inner.thread.id != thread_id {
            return Err(AgentError::Failed("no such ACP thread".into()));
        }
        Ok(())
    }
}

impl AgentSession for AcpSession {
    fn capabilities(&self) -> Capabilities {
        ACP_CAPABILITIES
    }

    fn send_turn(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        _options: &TurnOptions,
    ) -> AgentResult<String> {
        self.send_turn_inner(thread_id, text, attachments)
    }

    fn interrupt(&self, thread_id: &str) -> AgentResult<()> {
        self.interrupt_inner(thread_id)
    }

    fn respond_to_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> AgentResult<bool> {
        self.respond_to_approval_inner(approval_id, decision)
    }

    fn export_state(&self) -> AgentResult<Option<AgentSessionState>> {
        serde_json::to_value(self.snapshot())
            .map(AgentSessionState::new)
            .map(Some)
            .map_err(|_| AgentError::Failed("could not encode ACP session state".into()))
    }

    fn dispose(&self) {
        self.dispose_inner();
    }
}

impl Drop for AcpSession {
    fn drop(&mut self) {
        self.dispose_inner();
    }
}

impl CallbackBridge {
    fn attach(&self, session: &Arc<SessionInner>) {
        *lock(&self.session) = Some(Arc::downgrade(session));
    }

    fn session(&self) -> Option<Arc<SessionInner>> {
        lock(&self.session).as_ref().and_then(Weak::upgrade)
    }

    fn notification(&self, method: String, params: Value) {
        if let Some(session) = self.session() {
            handle_notification(&session, &method, &params);
        }
    }

    fn request(&self, method: String, params: Value, responder: RpcResponder) {
        if let Some(session) = self.session() {
            handle_request(&session, &method, &params, responder);
        } else {
            self.handlers.emit_log(format!(
                "unhandled request from {} before session start: {method}",
                self.agent_name
            ));
            let _ = responder.respond(Value::Null);
        }
    }
}

fn connect(
    spec: &'static AcpAgentSpec,
    command: &AcpCommand,
    workspace_path: &str,
    model: Option<&str>,
    handlers: &AgentHandlers,
) -> AgentResult<Connection> {
    let mut args = command.prefix_args.clone();
    if command.append_agent_args {
        args.extend(spec.args.iter().map(OsString::from));
        if let (Some(model), Some(model_arg)) = (model, spec.model_arg) {
            args.push(OsString::from(model_arg));
            args.push(OsString::from(model));
        }
    }
    let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
    let child = spawn_cli(
        command.program.as_os_str(),
        &arg_refs,
        &SpawnOptions {
            cwd: Some(workspace_path.into()),
            environment: command.environment.clone(),
            ..SpawnOptions::default()
        },
    )
    .map_err(|_| unavailable(spec))?;
    let rpc = StdioJsonRpc::new(child, spec.name).map_err(|_| unavailable(spec))?;
    let bridge = Arc::new(CallbackBridge {
        agent_name: spec.name,
        handlers: handlers.clone(),
        session: Mutex::new(None),
    });
    let notification_bridge = Arc::clone(&bridge);
    rpc.on_notification(move |method, params| notification_bridge.notification(method, params));
    let request_bridge = Arc::clone(&bridge);
    rpc.on_server_request(move |method, params, responder| {
        request_bridge.request(method, params, responder);
    });
    let stderr_handlers = handlers.clone();
    rpc.on_stderr(move |text| {
        let text = text.trim_end();
        if !text.is_empty() {
            stderr_handlers.emit_log(text);
        }
    });
    let initialize = rpc
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false }
                },
                "clientInfo": { "name": "personal-harness", "version": "0.0.0" }
            }),
            HANDSHAKE_TIMEOUT,
        )
        .map_err(|error| rpc_failed(spec, "initialization", error))?;
    if let Some(version) = initialize.get("protocolVersion").and_then(Value::as_u64)
        && version != PROTOCOL_VERSION
    {
        handlers.emit_log(format!(
            "{} speaks ACP {version}, this adapter was written for {PROTOCOL_VERSION}",
            spec.name
        ));
    }
    if let (Some(version), Some(supported)) = (
        initialize
            .get("agentInfo")
            .and_then(|info| info.get("version"))
            .and_then(Value::as_str),
        spec.supported_version,
    ) && !version.starts_with(supported)
    {
        handlers.emit_log(format!(
            "{} {version} is outside verified {supported}.x",
            spec.name
        ));
    }
    let load_session = initialize
        .get("agentCapabilities")
        .and_then(|capabilities| capabilities.get("loadSession"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(Connection {
        rpc,
        bridge,
        load_session,
    })
}

fn select_session_model(
    rpc: &StdioJsonRpc,
    spec: &AcpAgentSpec,
    session_id: &str,
    model: Option<&str>,
) -> AgentResult<()> {
    let (Some(model), Some(config_id)) = (model, spec.model_config_id) else {
        return Ok(());
    };
    rpc.request(
        "session/set_config_option",
        json!({ "sessionId": session_id, "configId": config_id, "value": model }),
        HANDSHAKE_TIMEOUT,
    )
    .map(|_| ())
    .map_err(|error| rpc_failed(spec, "model selection", error))
}

fn handle_notification(inner: &Arc<SessionInner>, method: &str, params: &Value) {
    if method != "session/update" || inner.disposed.load(Ordering::Acquire) {
        return;
    }
    if params
        .get("sessionId")
        .and_then(Value::as_str)
        .is_some_and(|session_id| session_id != inner.session_id)
    {
        return;
    }
    let Some(update) = params.get("update") else {
        return;
    };
    if matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some("available_commands" | "current_mode_update")
    ) {
        return;
    }
    let events = {
        let mut state = lock(&inner.state);
        state
            .active
            .as_mut()
            .map(|active| active.mapper.translate(update, now_ms()))
            .unwrap_or_default()
    };
    for event in events {
        inner.handlers.emit_event(event);
    }
}

fn handle_request(
    inner: &Arc<SessionInner>,
    method: &str,
    params: &Value,
    responder: RpcResponder,
) {
    if inner.disposed.load(Ordering::Acquire) {
        let _ = responder.respond(cancelled_outcome());
        return;
    }
    if method != "session/request_permission" {
        inner.handlers.emit_log(format!(
            "unhandled request from {}: {method}",
            inner.spec.name
        ));
        let _ = responder.respond(Value::Null);
        return;
    }
    if params
        .get("sessionId")
        .and_then(Value::as_str)
        .is_some_and(|session_id| session_id != inner.session_id)
    {
        let _ = responder.respond(cancelled_outcome());
        return;
    }
    let call = params.get("toolCall").unwrap_or(&Value::Null);
    let tool_call_id = call.get("toolCallId").and_then(Value::as_str);
    let kind = call.get("kind").and_then(Value::as_str);
    let title = call.get("title").and_then(Value::as_str);
    let options = permission_options(params);
    let automatic_option = auto_option_kind(inner.approval, kind).and_then(|wanted| {
        options
            .iter()
            .find(|option| option.kind.as_deref() == Some(wanted))
            .and_then(|option| option.option_id.as_deref())
            .map(str::to_owned)
    });
    let mut state = lock(&inner.state);
    let Some(active) = state.active.as_mut() else {
        drop(state);
        let _ = responder.respond(cancelled_outcome());
        return;
    };
    if let Some(tool_call_id) = tool_call_id {
        active.mapper.note(tool_call_id, kind, title);
    }
    if let Some(option_id) = automatic_option {
        drop(state);
        if responder.respond(selected_outcome(option_id)).is_err() {
            inner.handlers.emit_log("ACP permission response failed");
        }
        return;
    }

    let base = tool_call_id
        .map(str::to_owned)
        .unwrap_or_else(|| format!("approval-{}", Uuid::new_v4().simple()));
    let approval_id = if state
        .pending_approvals
        .iter()
        .any(|pending| pending.id == base)
    {
        format!("{base}-{}", Uuid::new_v4().simple())
    } else {
        base
    };
    state.pending_approvals.push(PendingApproval {
        id: approval_id.clone(),
        responder,
        options,
    });
    drop(state);
    let command = kind == Some("execute");
    let file_change = matches!(kind, Some("edit" | "delete" | "move"));
    inner.handlers.emit_event(DomainEvent::ApprovalRequested {
        request: ApprovalRequest {
            id: approval_id,
            kind: if file_change {
                ApprovalKind::FileChange
            } else {
                ApprovalKind::Command
            },
            reason: None,
            command: command.then(|| title.unwrap_or_default().into()),
            cwd: None,
            path: (!command).then(|| title.unwrap_or_default().into()),
            created_at: now_ms(),
        },
    });
}

fn permission_options(params: &Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|option| PermissionOption {
            option_id: option
                .get("optionId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            kind: option
                .get("kind")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
        .collect()
}

fn auto_option_kind(approval: ApprovalMode, kind: Option<&str>) -> Option<&'static str> {
    if approval == ApprovalMode::Full {
        return Some("allow_always");
    }
    if approval == ApprovalMode::Auto && matches!(kind, Some("read" | "search" | "think")) {
        return Some("allow_once");
    }
    None
}

fn finish_turn(inner: &SessionInner, expected_turn_id: &str, stop_reason: Option<&str>) {
    let status = match stop_reason {
        Some("cancelled") => TurnStatus::Interrupted,
        Some("refusal") => TurnStatus::Failed,
        _ => TurnStatus::Completed,
    };
    let (turn_id, item_events, approvals) = {
        let mut state = lock(&inner.state);
        let Some(active) = state.active.as_ref() else {
            return;
        };
        if active.id != expected_turn_id {
            return;
        }
        let mut active = state.active.take().expect("active ACP turn disappeared");
        let item_events = active.mapper.finish(status);
        let approvals = std::mem::take(&mut state.pending_approvals);
        (active.id, item_events, approvals)
    };
    for event in item_events {
        inner.handlers.emit_event(event);
    }
    cancel_approvals(inner, approvals, true);
    match stop_reason {
        Some("refusal") => inner.handlers.emit_event(DomainEvent::ThreadError {
            thread_id: inner.thread.id.clone(),
            message: "The agent refused to continue this turn.".into(),
        }),
        Some("max_tokens" | "max_turn_requests") => {
            let reason = stop_reason.unwrap_or_default().replace('_', " ");
            inner.handlers.emit_event(DomainEvent::ThreadError {
                thread_id: inner.thread.id.clone(),
                message: format!("The turn stopped early ({reason})."),
            });
        }
        Some(reason) if !matches!(reason, "end_turn" | "cancelled") => {
            inner.handlers.emit_log(format!("turn ended: {reason}"));
        }
        _ => {}
    }
    inner
        .handlers
        .emit_event(DomainEvent::TurnCompleted { turn_id, status });
}

fn fail_turn(inner: &SessionInner, expected_turn_id: &str, message: String) {
    let (turn_id, item_events, approvals) = {
        let mut state = lock(&inner.state);
        let Some(active) = state.active.as_ref() else {
            return;
        };
        if active.id != expected_turn_id {
            return;
        }
        let mut active = state.active.take().expect("active ACP turn disappeared");
        let item_events = active.mapper.finish(TurnStatus::Failed);
        let approvals = std::mem::take(&mut state.pending_approvals);
        (active.id, item_events, approvals)
    };
    for event in item_events {
        inner.handlers.emit_event(event);
    }
    cancel_approvals(inner, approvals, true);
    inner.handlers.emit_event(DomainEvent::ThreadError {
        thread_id: inner.thread.id.clone(),
        message,
    });
    inner.handlers.emit_event(DomainEvent::TurnCompleted {
        turn_id,
        status: TurnStatus::Failed,
    });
}

fn cancel_approvals(inner: &SessionInner, approvals: Vec<PendingApproval>, emit: bool) {
    for pending in approvals {
        if pending.responder.respond(cancelled_outcome()).is_err() {
            inner.handlers.emit_log("ACP permission response failed");
        }
        if emit {
            inner
                .handlers
                .emit_event(DomainEvent::ApprovalResolved { id: pending.id });
        }
    }
}

fn selected_outcome(option_id: String) -> Value {
    json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
}

fn cancelled_outcome() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

pub fn parse_acp_thread_id<'a>(thread_id: &'a str, agent_id: &str) -> AgentResult<&'a str> {
    let prefix = format!("acp-{agent_id}-");
    thread_id
        .strip_prefix(&prefix)
        .filter(|session_id| !session_id.is_empty())
        .ok_or_else(|| {
            AgentError::Failed(format!(
                "thread does not belong to ACP agent \"{agent_id}\""
            ))
        })
}

fn validate_state(spec: &AcpAgentSpec, state: &AcpSessionState) -> AgentResult<()> {
    if state.version != SESSION_STATE_VERSION {
        return Err(AgentError::Failed(
            "ACP session state version is unsupported".into(),
        ));
    }
    if state.thread.provider != ProviderId::Acp || state.thread.connection_id.is_some() {
        return Err(AgentError::Failed(
            "only ACP threads can resume here".into(),
        ));
    }
    if state.agent_id != spec.id
        || parse_acp_thread_id(&state.thread.id, spec.id)? != state.session_id
    {
        return Err(AgentError::Failed("ACP session id is invalid".into()));
    }
    validate_workspace(&state.thread.workspace_path)?;
    validate_approval(Some(state.approval))
}

fn validate_approval(approval: Option<ApprovalMode>) -> AgentResult<()> {
    if approval == Some(ApprovalMode::AutoReview) {
        return Err(AgentError::Failed(
            "ACP agents do not support automatic approval review".into(),
        ));
    }
    Ok(())
}

fn validate_workspace(workspace_path: &str) -> AgentResult<()> {
    if !PathBuf::from(workspace_path).is_dir() {
        return Err(AgentError::Failed("ACP workspace is unavailable".into()));
    }
    Ok(())
}

fn new_session_error(spec: &AcpAgentSpec, error: JsonRpcError) -> AgentError {
    if error.to_string().to_ascii_lowercase().contains("auth") {
        return AgentError::Failed(format!(
            "{} is not signed in. Run `{}` once in a terminal and sign in there. Personal Harness never handles its credentials.",
            spec.name, spec.command
        ));
    }
    rpc_failed(spec, "session start", error)
}

fn rpc_failed(spec: &AcpAgentSpec, operation: &str, error: JsonRpcError) -> AgentError {
    AgentError::Failed(format!("{} {operation} failed: {error}", spec.name))
}

fn unavailable(spec: &AcpAgentSpec) -> AgentError {
    AgentError::Failed(format!(
        "{} is unavailable. Install it and run `{}` once to sign in.",
        spec.name, spec.command
    ))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::AcpRuntime;
    use harness_agent::{AgentRuntime, TurnOptions};
    use harness_protocol::{ItemType, PlanStepStatus};
    use std::io::{BufRead as _, BufReader, Write};
    use std::sync::mpsc::{self, Receiver};
    use std::time::Instant;

    const HELPER_MODE: &str = "HARNESS_ACP_AGENT_HELPER";
    const HELPER_WORKSPACE: &str = "HARNESS_ACP_HELPER_WORKSPACE";
    const WAIT: Duration = Duration::from_secs(3);

    #[test]
    fn parses_native_ids_and_never_auto_approves_mutations() {
        assert_eq!(
            parse_acp_thread_id("acp-kimi-session_abc-123", "kimi").unwrap(),
            "session_abc-123"
        );
        assert!(parse_acp_thread_id("acp-gemini-session_abc", "kimi").is_err());
        assert_eq!(
            auto_option_kind(ApprovalMode::Full, Some("execute")),
            Some("allow_always")
        );
        for kind in ["read", "search", "think"] {
            assert_eq!(
                auto_option_kind(ApprovalMode::Auto, Some(kind)),
                Some("allow_once")
            );
        }
        for kind in ["execute", "edit", "delete", "move", "fetch"] {
            assert_eq!(auto_option_kind(ApprovalMode::Auto, Some(kind)), None);
        }
        assert_eq!(auto_option_kind(ApprovalMode::Ask, Some("read")), None);
    }

    #[test]
    fn runs_resumes_permissions_and_cancellation_over_the_captured_wire() {
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().to_str().unwrap();
        let runtime = test_runtime(workspace);
        let recording = Recording::new();
        let options = StartOptions {
            model: Some("kimi-code/test".into()),
            approval: Some(ApprovalMode::Ask),
            instructions: Some("Answer plainly.".into()),
            ..StartOptions::default()
        };
        let (thread, session) = runtime
            .start(workspace, &options, recording.handlers.clone())
            .unwrap();
        assert_eq!(thread.id, "acp-kimi-session-1");
        assert_eq!(thread.provider, ProviderId::Acp);
        assert!(!session.capabilities().images);
        assert!(
            session
                .send_turn(
                    &thread.id,
                    "ignored",
                    &["reference.png".into()],
                    &TurnOptions::default(),
                )
                .is_err()
        );

        let turn_id = session
            .send_turn(&thread.id, "Build it", &[], &TurnOptions::default())
            .unwrap();
        let approval = recording.wait_for_approval("command-1");
        assert_eq!(approval.kind, ApprovalKind::Command);
        assert_eq!(approval.command.as_deref(), Some("cargo test"));
        assert!(
            session
                .respond_to_approval(&approval.id, ApprovalDecision::ApproveSession)
                .unwrap()
        );
        assert!(
            !session
                .respond_to_approval(&approval.id, ApprovalDecision::Approve)
                .unwrap()
        );
        recording.wait_for_terminal(&turn_id, TurnStatus::Completed);

        let events = lock(&recording.events);
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Command
                    && item.command.as_deref() == Some("cargo test")
                    && item.text.as_deref() == Some("passed")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Message
                    && item.text.as_deref() == Some("world")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Reasoning
                    && item.text.as_deref() == Some("Checking")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::PlanUpdated { steps, .. }
                if steps.iter().map(|step| step.status).collect::<Vec<_>>()
                    == [PlanStepStatus::Done, PlanStepStatus::Running]
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ApprovalRequested { request }
                if request.id == "edit-2" && request.kind == ApprovalKind::FileChange
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ApprovalResolved { id } if id == "edit-2"
        )));
        drop(events);

        let saved = session.export_state().unwrap().unwrap();
        let snapshot: AcpSessionState = serde_json::from_value(saved.value().clone()).unwrap();
        assert_eq!(snapshot.turn_counter, 1);
        assert!(!snapshot.instructions_pending);
        session.dispose();
        drop(session);

        let resumed_recording = Recording::new();
        let resume_options = StartOptions {
            resume_state: Some(saved),
            ..StartOptions::default()
        };
        let (resumed_thread, resumed) = runtime
            .resume(
                &thread.id,
                workspace,
                &resume_options,
                resumed_recording.handlers.clone(),
            )
            .unwrap();
        assert_eq!(resumed_thread, thread);
        let resumed_turn = resumed
            .send_turn(&thread.id, "Again", &[], &TurnOptions::default())
            .unwrap();
        resumed_recording.wait_for_item_text("resumed");
        resumed.interrupt(&thread.id).unwrap();
        resumed_recording.wait_for_terminal(&resumed_turn, TurnStatus::Interrupted);
        assert_ne!(resumed_turn, turn_id);
        let resumed_snapshot: AcpSessionState =
            serde_json::from_value(resumed.export_state().unwrap().unwrap().into_value()).unwrap();
        assert_eq!(resumed_snapshot.turn_counter, 2);
        resumed.dispose();
    }

    #[test]
    fn rejects_auto_review_before_launching_an_agent() {
        let workspace = tempfile::tempdir().unwrap();
        let runtime = AcpRuntime::new("kimi", Default::default()).unwrap();
        let result = runtime.start(
            workspace.path().to_str().unwrap(),
            &StartOptions {
                approval: Some(ApprovalMode::AutoReview),
                ..StartOptions::default()
            },
            AgentHandlers::default(),
        );
        assert!(matches!(
            result,
            Err(AgentError::Failed(message)) if message.contains("automatic approval review")
        ));
    }

    #[test]
    fn acp_agent_helper() {
        if std::env::var_os(HELPER_MODE).is_none() {
            return;
        }
        let expected_workspace = std::env::var(HELPER_WORKSPACE).unwrap();
        let stdin = std::io::stdin();
        let mut lines = BufReader::new(stdin.lock()).lines();
        let stdout = std::io::stdout();
        let mut stdout = stdout.lock();
        let mut loaded = false;
        let mut pending_prompt = None;
        while let Some(Ok(line)) = lines.next() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let Some(method) = request.get("method").and_then(Value::as_str) else {
                if request["id"] == 91 {
                    assert_eq!(request["result"], cancelled_outcome());
                }
                continue;
            };
            let id = request.get("id").cloned();
            match method {
                "initialize" => {
                    assert_eq!(request["params"]["protocolVersion"], PROTOCOL_VERSION);
                    assert_eq!(
                        request["params"]["clientCapabilities"]["fs"],
                        json!({ "readTextFile": false, "writeTextFile": false })
                    );
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({
                            "protocolVersion": PROTOCOL_VERSION,
                            "agentInfo": { "name": "Fake Kimi", "version": "0.29.7" },
                            "agentCapabilities": {
                                "loadSession": true,
                                "promptCapabilities": { "image": true }
                            }
                        }),
                    );
                }
                "session/new" => {
                    assert_eq!(request["params"]["cwd"], expected_workspace);
                    assert_eq!(request["params"]["mcpServers"], json!([]));
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({ "sessionId": "session-1" }),
                    );
                }
                "session/load" => {
                    loaded = true;
                    assert_eq!(request["params"]["sessionId"], "session-1");
                    assert_eq!(request["params"]["cwd"], expected_workspace);
                    assert_eq!(request["params"]["mcpServers"], json!([]));
                    respond(&mut stdout, id.unwrap(), json!({}));
                }
                "session/set_config_option" => {
                    assert_eq!(request["params"]["sessionId"], "session-1");
                    assert_eq!(request["params"]["configId"], "model");
                    assert_eq!(request["params"]["value"], "kimi-code/test");
                    respond(&mut stdout, id.unwrap(), json!({}));
                }
                "session/prompt" if loaded => {
                    assert_eq!(request["params"]["prompt"][0]["text"], "Again");
                    pending_prompt = id;
                    notify(
                        &mut stdout,
                        json!({
                            "sessionId": "session-1",
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": "resumed" }
                            }
                        }),
                    );
                }
                "session/prompt" => {
                    assert_eq!(
                        request["params"]["prompt"][0]["text"],
                        "<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nBuild it"
                    );
                    let prompt_id = id.unwrap();
                    notify(
                        &mut stdout,
                        json!({
                            "sessionId": "session-1",
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": "Hello " }
                            }
                        }),
                    );
                    notify(
                        &mut stdout,
                        json!({
                            "sessionId": "session-1",
                            "update": {
                                "sessionUpdate": "agent_thought_chunk",
                                "content": { "type": "text", "text": "Checking" }
                            }
                        }),
                    );
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "id": 90,
                            "method": "session/request_permission",
                            "params": {
                                "sessionId": "session-1",
                                "toolCall": {
                                    "toolCallId": "command-1",
                                    "title": "cargo test",
                                    "kind": "execute"
                                },
                                "options": [
                                    { "optionId": "always", "kind": "allow_always" },
                                    { "optionId": "once", "kind": "allow_once" },
                                    { "optionId": "deny", "kind": "reject_once" }
                                ]
                            }
                        }),
                    );
                    let approval: Value =
                        serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
                    assert_eq!(approval["id"], 90);
                    assert_eq!(approval["result"], selected_outcome("always".into()));
                    notify(
                        &mut stdout,
                        json!({
                            "sessionId": "session-1",
                            "update": {
                                "sessionUpdate": "tool_call_update",
                                "toolCallId": "command-1",
                                "status": "completed",
                                "content": [{
                                    "type": "content",
                                    "content": { "type": "text", "text": "passed" }
                                }]
                            }
                        }),
                    );
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "id": 91,
                            "method": "session/request_permission",
                            "params": {
                                "sessionId": "session-1",
                                "toolCall": {
                                    "toolCallId": "edit-2",
                                    "title": "/repo/file.rs",
                                    "kind": "edit"
                                },
                                "options": [
                                    { "optionId": "once", "kind": "allow_once" },
                                    { "optionId": "deny", "kind": "reject_once" }
                                ]
                            }
                        }),
                    );
                    notify(
                        &mut stdout,
                        json!({
                            "sessionId": "session-1",
                            "update": {
                                "sessionUpdate": "plan",
                                "entries": [
                                    { "content": "Inspect", "status": "completed" },
                                    { "content": "Build", "status": "in_progress" }
                                ]
                            }
                        }),
                    );
                    notify(
                        &mut stdout,
                        json!({
                            "sessionId": "session-1",
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": "world" }
                            }
                        }),
                    );
                    respond(&mut stdout, prompt_id, json!({ "stopReason": "end_turn" }));
                }
                "session/cancel" => {
                    assert!(loaded);
                    respond(
                        &mut stdout,
                        pending_prompt.take().unwrap(),
                        json!({ "stopReason": "cancelled" }),
                    );
                }
                method => panic!("unexpected ACP helper method: {method}"),
            }
        }
    }

    struct Recording {
        handlers: AgentHandlers,
        receiver: Receiver<DomainEvent>,
        events: Arc<Mutex<Vec<DomainEvent>>>,
    }

    impl Recording {
        fn new() -> Self {
            let (sender, receiver) = mpsc::channel();
            let events = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&events);
            Self {
                handlers: AgentHandlers::new(
                    move |event| {
                        lock(&recorded).push(event.clone());
                        let _ = sender.send(event);
                    },
                    |_| {},
                ),
                receiver,
                events,
            }
        }

        fn wait_for_approval(&self, expected_id: &str) -> ApprovalRequest {
            let deadline = Instant::now() + WAIT;
            loop {
                let event = self.receive(deadline, "approval");
                if let DomainEvent::ApprovalRequested { request } = event
                    && request.id == expected_id
                {
                    return request;
                }
            }
        }

        fn wait_for_item_text(&self, expected: &str) {
            let deadline = Instant::now() + WAIT;
            loop {
                let event = self.receive(deadline, "item");
                if matches!(
                    event,
                    DomainEvent::ItemStarted { item }
                        if item.text.as_deref() == Some(expected)
                ) {
                    return;
                }
            }
        }

        fn wait_for_terminal(&self, expected_id: &str, expected_status: TurnStatus) {
            let deadline = Instant::now() + WAIT;
            loop {
                let event = self.receive(deadline, "terminal event");
                if matches!(
                    event,
                    DomainEvent::TurnCompleted { turn_id, status }
                        if turn_id == expected_id && status == expected_status
                ) {
                    return;
                }
            }
        }

        fn receive(&self, deadline: Instant, label: &str) -> DomainEvent {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "{label} did not arrive");
            self.receiver.recv_timeout(remaining).unwrap()
        }
    }

    fn test_runtime(workspace: &str) -> AcpRuntime {
        let executable = std::env::current_exe().unwrap();
        AcpRuntime::with_command(
            "kimi",
            AcpCommand {
                program: executable.into_os_string(),
                prefix_args: vec![
                    OsString::from("--exact"),
                    OsString::from("session::tests::acp_agent_helper"),
                    OsString::from("--nocapture"),
                ],
                environment: vec![
                    (OsString::from(HELPER_MODE), OsString::from("1")),
                    (OsString::from(HELPER_WORKSPACE), OsString::from(workspace)),
                ],
                append_agent_args: false,
            },
        )
    }

    fn respond(stdout: &mut impl Write, id: Value, result: Value) {
        write_frame(
            stdout,
            json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        );
    }

    fn notify(stdout: &mut impl Write, params: Value) {
        write_frame(
            stdout,
            json!({ "jsonrpc": "2.0", "method": "session/update", "params": params }),
        );
    }

    fn write_frame(stdout: &mut impl Write, frame: Value) {
        writeln!(stdout, "{frame}").unwrap();
        stdout.flush().unwrap();
    }
}
