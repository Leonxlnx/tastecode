use crate::events::{OpenCodeEventMapper, event_session_id};
use crate::http::OpenCodeHttp;
use crate::runtime::{RuntimeInner, ServerEndpoint};
use crate::sse::{MAX_SSE_EVENT, SseFrame, read_sse};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentSession, AgentSessionState, StartOptions,
    TurnOptions,
};
use harness_protocol::{
    ApprovalDecision, ApprovalKind, ApprovalMode, ApprovalRequest, Capabilities, DomainEvent,
    ProviderId, Thread, Turn, TurnStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const SESSION_STATE_VERSION: u32 = 1;

pub const OPENCODE_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: true,
    approvals: true,
    user_input: None,
    auto_review: None,
    images: false,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OpenCodeSessionState {
    pub version: u32,
    pub thread: Thread,
    pub model: Option<String>,
    pub approval: ApprovalMode,
    pub instructions: Option<String>,
    pub session_id: String,
    pub turn_counter: u64,
}

pub struct OpenCodeSession {
    inner: Arc<SessionInner>,
}

struct SessionInner {
    thread: Thread,
    model: Option<String>,
    approval: ApprovalMode,
    instructions: Option<String>,
    session_id: String,
    http: OpenCodeHttp,
    endpoint: ServerEndpoint,
    handlers: AgentHandlers,
    state: Mutex<LiveState>,
    disposed: AtomicBool,
}

struct LiveState {
    turn_counter: u64,
    active: Option<ActiveTurn>,
    pending_approvals: Vec<String>,
}

struct ActiveTurn {
    id: String,
    mapper: OpenCodeEventMapper,
}

impl OpenCodeSession {
    pub(crate) fn start(
        runtime: Arc<RuntimeInner>,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        validate_workspace(workspace_path)?;
        validate_approval(options.approval)?;
        parse_model(options.model.as_deref())?;
        let endpoint = runtime.endpoint(options, &handlers)?;
        let http = OpenCodeHttp::new(endpoint.base_url().clone(), Some(workspace_path.into()))?;
        let response = http.subscribe().map_err(|_| unavailable())?;
        let record = http.create_session().map_err(|_| unavailable())?;
        let thread = Thread {
            id: format!("opencode-{}", record.id),
            provider: ProviderId::OpenCode,
            connection_id: None,
            workspace_path: workspace_path.into(),
            title: record.title,
            created_at: record.created_at,
        };
        let session = Arc::new(Self {
            inner: Arc::new(SessionInner {
                thread: thread.clone(),
                model: options.model.clone(),
                approval: options.approval.unwrap_or(ApprovalMode::Ask),
                instructions: options.instructions.clone(),
                session_id: record.id,
                http,
                endpoint,
                handlers,
                state: Mutex::new(LiveState {
                    turn_counter: 0,
                    active: None,
                    pending_approvals: Vec::new(),
                }),
                disposed: AtomicBool::new(false),
            }),
        });
        if let Err(error) = session.start_subscription(response) {
            session.dispose_inner();
            return Err(error);
        }
        Ok((thread, session))
    }

    pub(crate) fn resume(
        runtime: Arc<RuntimeInner>,
        state: OpenCodeSessionState,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        if state.version != SESSION_STATE_VERSION {
            return Err(AgentError::Failed(
                "OpenCode session state version is unsupported".into(),
            ));
        }
        if state.thread.provider != ProviderId::OpenCode || state.thread.connection_id.is_some() {
            return Err(AgentError::Failed(
                "only OpenCode threads can resume here".into(),
            ));
        }
        if state.session_id.is_empty()
            || state.thread.id != format!("opencode-{}", state.session_id)
        {
            return Err(AgentError::Failed("OpenCode session id is invalid".into()));
        }
        validate_workspace(&state.thread.workspace_path)?;
        validate_approval(Some(state.approval))?;
        parse_model(state.model.as_deref())?;
        let endpoint = runtime.endpoint(options, &handlers)?;
        let http = OpenCodeHttp::new(
            endpoint.base_url().clone(),
            Some(state.thread.workspace_path.clone()),
        )?;
        let response = http.subscribe().map_err(|_| unavailable())?;
        let record = http
            .get_session(&state.session_id)
            .map_err(|_| unavailable())?;
        if record.id != state.session_id {
            return Err(AgentError::Failed(
                "OpenCode returned the wrong session".into(),
            ));
        }
        let thread = state.thread.clone();
        let session = Arc::new(Self {
            inner: Arc::new(SessionInner {
                thread: thread.clone(),
                model: state.model,
                approval: state.approval,
                instructions: state.instructions,
                session_id: state.session_id,
                http,
                endpoint,
                handlers,
                state: Mutex::new(LiveState {
                    turn_counter: state.turn_counter,
                    active: None,
                    pending_approvals: Vec::new(),
                }),
                disposed: AtomicBool::new(false),
            }),
        });
        if let Err(error) = session.start_subscription(response) {
            session.dispose_inner();
            return Err(error);
        }
        Ok((thread, session))
    }

    pub fn snapshot(&self) -> OpenCodeSessionState {
        let state = lock(&self.inner.state);
        OpenCodeSessionState {
            version: SESSION_STATE_VERSION,
            thread: self.inner.thread.clone(),
            model: self.inner.model.clone(),
            approval: self.inner.approval,
            instructions: self.inner.instructions.clone(),
            session_id: self.inner.session_id.clone(),
            turn_counter: state.turn_counter,
        }
    }

    fn start_subscription(&self, response: reqwest::blocking::Response) -> AgentResult<()> {
        let inner = Arc::downgrade(&self.inner);
        thread::Builder::new()
            .name("harness-opencode-events".into())
            .spawn(move || event_worker(response, inner))
            .map(|_| ())
            .map_err(|_| AgentError::Failed("could not start the OpenCode event worker".into()))
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
                "OpenCode attachments are not supported yet".into(),
            ));
        }
        if self.inner.disposed.load(Ordering::Acquire) {
            return Err(AgentError::Failed("OpenCode session is closed".into()));
        }
        let model = parse_model(self.inner.model.as_deref())?;
        let mut state = lock(&self.inner.state);
        if state.active.is_some() {
            return Err(AgentError::Failed(
                "an OpenCode turn is already running".into(),
            ));
        }
        let next_counter = state.turn_counter.saturating_add(1);
        let turn_id = format!("{}-turn-{next_counter}", self.inner.thread.id);
        state.turn_counter = next_counter;
        state.active = Some(ActiveTurn {
            id: turn_id.clone(),
            mapper: OpenCodeEventMapper::new(&turn_id),
        });
        drop(state);

        let mut body =
            Map::from_iter([("parts".into(), json!([{ "type": "text", "text": text }]))]);
        if let Some((provider_id, model_id)) = model {
            body.insert(
                "model".into(),
                json!({ "providerID": provider_id, "modelID": model_id }),
            );
        }
        if let Some(instructions) = self
            .inner
            .instructions
            .as_deref()
            .filter(|instructions| !instructions.is_empty())
        {
            body.insert("system".into(), Value::String(instructions.into()));
        }

        let (start_tx, start_rx) = std::sync::mpsc::channel();
        let http = self.inner.http.clone();
        let session_id = self.inner.session_id.clone();
        let inner = Arc::downgrade(&self.inner);
        let worker_turn_id = turn_id.clone();
        let worker = thread::Builder::new()
            .name("harness-opencode-prompt".into())
            .spawn(move || {
                if start_rx.recv().is_ok()
                    && http.prompt_async(&session_id, Value::Object(body)).is_err()
                    && let Some(inner) = inner.upgrade()
                {
                    fail_turn(&inner, Some(&worker_turn_id));
                }
            });
        if worker.is_err() {
            lock(&self.inner.state).active = None;
            return Err(AgentError::Failed(
                "could not start the OpenCode prompt worker".into(),
            ));
        }
        self.inner.handlers.emit_event(DomainEvent::TurnStarted {
            turn: Turn {
                id: turn_id.clone(),
                thread_id: self.inner.thread.id.clone(),
                status: TurnStatus::Running,
                created_at: now_ms(),
            },
        });
        let _ = start_tx.send(());
        Ok(turn_id)
    }

    fn interrupt_inner(&self, thread_id: &str) -> AgentResult<()> {
        self.require_thread(thread_id)?;
        self.inner.http.abort(&self.inner.session_id)?;
        finish_turn(&self.inner, TurnStatus::Interrupted);
        Ok(())
    }

    fn respond_to_approval_inner(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> AgentResult<bool> {
        respond_to_approval(&self.inner, approval_id, decision)
    }

    fn dispose_inner(&self) {
        if self.inner.disposed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.inner.endpoint.close();
        let mut state = lock(&self.inner.state);
        state.active = None;
        state.pending_approvals.clear();
    }

    fn require_thread(&self, thread_id: &str) -> AgentResult<()> {
        if self.inner.thread.id != thread_id {
            return Err(AgentError::Failed("no such OpenCode thread".into()));
        }
        Ok(())
    }
}

impl AgentSession for OpenCodeSession {
    fn capabilities(&self) -> Capabilities {
        OPENCODE_CAPABILITIES
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
            .map_err(|_| AgentError::Failed("could not encode OpenCode session state".into()))
    }

    fn dispose(&self) {
        self.dispose_inner();
    }
}

impl Drop for OpenCodeSession {
    fn drop(&mut self) {
        self.dispose_inner();
    }
}

fn event_worker(response: reqwest::blocking::Response, inner: Weak<SessionInner>) {
    let result = read_sse(response, MAX_SSE_EVENT, |frame| {
        if let Some(inner) = inner.upgrade() {
            handle_sse_frame(&inner, frame);
        }
    });
    if let Some(inner) = inner.upgrade()
        && !inner.disposed.load(Ordering::Acquire)
    {
        if result.is_err() {
            inner
                .handlers
                .emit_log("OpenCode event stream ended unexpectedly");
        } else {
            inner
                .handlers
                .emit_log("OpenCode event stream disconnected");
        }
        fail_turn(&inner, None);
    }
}

fn handle_sse_frame(inner: &Arc<SessionInner>, frame: SseFrame) {
    let event = match frame {
        SseFrame::Event(event) => event,
        SseFrame::Unparsable(data) => {
            inner.handlers.emit_log(format!(
                "unparsable OpenCode event: {}",
                data.chars().take(200).collect::<String>()
            ));
            return;
        }
        SseFrame::Oversized { max_bytes } => {
            inner
                .handlers
                .emit_log(format!("OpenCode event exceeded {max_bytes} bytes"));
            return;
        }
    };
    handle_event(inner, &event);
}

fn handle_event(inner: &Arc<SessionInner>, event: &Value) {
    if event_session_id(event).is_some_and(|id| id != inner.session_id) {
        return;
    }
    match event.get("type").and_then(Value::as_str) {
        Some("permission.updated") => {
            handle_permission(inner, event);
            return;
        }
        Some("session.error") => {
            fail_turn(inner, None);
            return;
        }
        Some("session.idle") => {
            finish_turn(inner, TurnStatus::Completed);
            return;
        }
        Some("session.status")
            if event
                .get("properties")
                .and_then(|properties| properties.get("status"))
                .and_then(|status| status.get("type"))
                .and_then(Value::as_str)
                == Some("idle") =>
        {
            finish_turn(inner, TurnStatus::Completed);
            return;
        }
        _ => {}
    }
    let events = {
        let mut state = lock(&inner.state);
        state
            .active
            .as_mut()
            .map(|active| active.mapper.translate(event, now_ms()))
            .unwrap_or_default()
    };
    for event in events {
        inner.handlers.emit_event(event);
    }
}

fn handle_permission(inner: &Arc<SessionInner>, event: &Value) {
    let Some(properties) = event.get("properties") else {
        return;
    };
    let (Some(id), Some(permission_type)) = (
        properties.get("id").and_then(Value::as_str),
        properties.get("type").and_then(Value::as_str),
    ) else {
        return;
    };
    let title = properties
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let created_at = properties
        .get("time")
        .and_then(|time| time.get("created"))
        .and_then(Value::as_f64)
        .unwrap_or_else(now_ms);
    let lowered = permission_type.to_ascii_lowercase();
    let command = ["bash", "shell", "command"]
        .iter()
        .any(|kind| lowered.contains(kind));
    {
        let mut state = lock(&inner.state);
        if !state.pending_approvals.iter().any(|pending| pending == id) {
            state.pending_approvals.push(id.into());
        }
    }
    if inner.approval == ApprovalMode::Full || (inner.approval == ApprovalMode::Auto && !command) {
        let decision = if inner.approval == ApprovalMode::Full {
            ApprovalDecision::ApproveSession
        } else {
            ApprovalDecision::Approve
        };
        let _ = respond_to_approval(inner, id, decision);
        return;
    }
    inner.handlers.emit_event(DomainEvent::ApprovalRequested {
        request: ApprovalRequest {
            id: id.into(),
            kind: if command {
                ApprovalKind::Command
            } else {
                ApprovalKind::FileChange
            },
            reason: None,
            command: command.then(|| title.into()),
            cwd: None,
            path: (!command).then(|| title.into()),
            created_at,
        },
    });
}

fn respond_to_approval(
    inner: &Arc<SessionInner>,
    approval_id: &str,
    decision: ApprovalDecision,
) -> AgentResult<bool> {
    let found = {
        let mut state = lock(&inner.state);
        state
            .pending_approvals
            .iter()
            .position(|pending| pending == approval_id)
            .map(|index| state.pending_approvals.remove(index))
            .is_some()
    };
    if !found {
        return Ok(false);
    }
    let response = match decision {
        ApprovalDecision::ApproveSession => "always",
        ApprovalDecision::Approve => "once",
        ApprovalDecision::Deny | ApprovalDecision::Abort => "reject",
    };
    let http = inner.http.clone();
    let session_id = inner.session_id.clone();
    let approval_id = approval_id.to_owned();
    let handlers = inner.handlers.clone();
    thread::Builder::new()
        .name("harness-opencode-approval".into())
        .spawn(move || {
            if http
                .respond_permission(&session_id, &approval_id, response)
                .is_ok()
            {
                handlers.emit_event(DomainEvent::ApprovalResolved { id: approval_id });
            } else {
                handlers.emit_log("OpenCode permission response failed");
            }
        })
        .map_err(|_| AgentError::Failed("could not start the OpenCode approval worker".into()))?;
    if decision == ApprovalDecision::Abort {
        let inner = Arc::downgrade(inner);
        let _ = thread::Builder::new()
            .name("harness-opencode-abort".into())
            .spawn(move || {
                if let Some(inner) = inner.upgrade()
                    && inner.http.abort(&inner.session_id).is_ok()
                {
                    finish_turn(&inner, TurnStatus::Interrupted);
                } else if let Some(inner) = inner.upgrade() {
                    inner.handlers.emit_log("OpenCode abort failed");
                }
            });
    }
    Ok(true)
}

fn finish_turn(inner: &SessionInner, status: TurnStatus) {
    let (turn_id, item_events, approvals) = {
        let mut state = lock(&inner.state);
        let Some(mut active) = state.active.take() else {
            return;
        };
        let item_events = active.mapper.finish(status);
        let approvals = std::mem::take(&mut state.pending_approvals);
        (active.id, item_events, approvals)
    };
    for event in item_events {
        inner.handlers.emit_event(event);
    }
    for id in approvals {
        inner
            .handlers
            .emit_event(DomainEvent::ApprovalResolved { id });
    }
    inner
        .handlers
        .emit_event(DomainEvent::TurnCompleted { turn_id, status });
}

fn fail_turn(inner: &SessionInner, expected_turn_id: Option<&str>) {
    let (turn_id, item_events, approvals) = {
        let mut state = lock(&inner.state);
        let Some(active) = state.active.as_ref() else {
            return;
        };
        if expected_turn_id.is_some_and(|expected| active.id != expected) {
            return;
        }
        let mut active = state.active.take().expect("active turn disappeared");
        let item_events = active.mapper.finish(TurnStatus::Failed);
        let approvals = std::mem::take(&mut state.pending_approvals);
        (active.id, item_events, approvals)
    };
    for event in item_events {
        inner.handlers.emit_event(event);
    }
    for id in approvals {
        inner
            .handlers
            .emit_event(DomainEvent::ApprovalResolved { id });
    }
    inner.handlers.emit_log("OpenCode request failed");
    inner.handlers.emit_event(DomainEvent::ThreadError {
        thread_id: inner.thread.id.clone(),
        message: "The OpenCode request failed.".into(),
    });
    inner.handlers.emit_event(DomainEvent::TurnCompleted {
        turn_id,
        status: TurnStatus::Failed,
    });
}

fn parse_model(value: Option<&str>) -> AgentResult<Option<(&str, &str)>> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some((provider_id, model_id)) = value.split_once('/') else {
        return Err(AgentError::Failed(
            "OpenCode models use provider/model".into(),
        ));
    };
    if provider_id.is_empty() || model_id.is_empty() {
        return Err(AgentError::Failed(
            "OpenCode models use provider/model".into(),
        ));
    }
    Ok(Some((provider_id, model_id)))
}

fn validate_approval(approval: Option<ApprovalMode>) -> AgentResult<()> {
    if approval == Some(ApprovalMode::AutoReview) {
        return Err(AgentError::Failed(
            "OpenCode does not support automatic approval review".into(),
        ));
    }
    Ok(())
}

fn validate_workspace(workspace_path: &str) -> AgentResult<()> {
    if !PathBuf::from(workspace_path).is_dir() {
        return Err(AgentError::Failed(
            "OpenCode workspace is unavailable".into(),
        ));
    }
    Ok(())
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
    use crate::runtime::{OpenCodeLaunchOptions, OpenCodeRuntime};
    use crate::test_support::MockOpenCode;
    use harness_agent::{AgentRuntime, TurnOptions};
    use harness_protocol::{ItemType, Usage};
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant};

    const WAIT: Duration = Duration::from_secs(3);

    #[test]
    fn starts_streams_resumes_approves_and_interrupts_a_native_session() {
        let mock = MockOpenCode::start();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().to_str().unwrap();
        let runtime = OpenCodeRuntime::new(OpenCodeLaunchOptions {
            base_url: Some(mock.base_url.clone()),
            ..OpenCodeLaunchOptions::default()
        });
        let (handlers, events) = recording_handlers();
        let options = StartOptions {
            model: Some("provider-1/model-1".into()),
            approval: Some(ApprovalMode::Ask),
            instructions: Some("Answer plainly.".into()),
            ..StartOptions::default()
        };
        let (thread, session) = runtime.start(workspace, &options, handlers).unwrap();
        assert_eq!(thread.id, "opencode-session-1");
        assert_eq!(thread.provider, ProviderId::OpenCode);
        assert_eq!(thread.title.as_deref(), Some("Harness session"));

        let turn_id = session
            .send_turn(
                &thread.id,
                "Check the repository",
                &[],
                &TurnOptions::default(),
            )
            .unwrap();
        let prompt = mock.wait_for_count("/prompt_async", 1).remove(0);
        assert_eq!(prompt.method, "POST");
        assert_eq!(
            prompt.body,
            Some(json!({
                "parts": [{ "type": "text", "text": "Check the repository" }],
                "model": { "providerID": "provider-1", "modelID": "model-1" },
                "system": "Answer plainly."
            }))
        );
        let encoded_workspace =
            url::form_urlencoded::byte_serialize(workspace.as_bytes()).collect::<String>();
        assert_eq!(
            prompt.headers.get("x-opencode-directory"),
            Some(&encoded_workspace)
        );
        let create = mock
            .wait_for_count("/session", 2)
            .into_iter()
            .find(|request| request.method == "POST" && request.target == "/session")
            .unwrap();
        assert_eq!(
            create.headers.get("x-opencode-directory"),
            Some(&encoded_workspace)
        );
        assert_eq!(create.body, Some(json!({ "title": "Personal Harness" })));

        let captured: Vec<Value> =
            serde_json::from_str(include_str!("fixtures/events.json")).unwrap();
        for event in captured {
            mock.broadcast(&event);
        }
        let first_events = through_terminal(&events, &turn_id, TurnStatus::Completed);
        assert!(first_events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemDelta { text_delta, .. }
                if text_delta == "Checking the repository."
        )));
        assert!(first_events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemStarted { item }
                if item.item_type == ItemType::Command
                    && item.command.as_deref() == Some("git status --short")
        )));
        assert!(first_events.iter().any(|event| matches!(
            event,
            DomainEvent::UsageUpdated {
                usage: Usage {
                    input_tokens: 10.0,
                    cached_input_tokens: 3.0,
                    output_tokens: 5.0,
                    reasoning_tokens: 2.0,
                    total_tokens: 17.0,
                    cost_usd: Some(0.01),
                    ..
                }
            }
        )));

        let saved = session.export_state().unwrap().unwrap();
        let saved_snapshot: OpenCodeSessionState =
            serde_json::from_value(saved.value().clone()).unwrap();
        assert_eq!(saved_snapshot.turn_counter, 1);
        assert_eq!(saved_snapshot.model.as_deref(), Some("provider-1/model-1"));
        session.dispose();
        drop(session);

        let (resumed_handlers, resumed_events) = recording_handlers();
        let resume_options = StartOptions {
            resume_state: Some(saved),
            ..StartOptions::default()
        };
        let (resumed_thread, resumed) = runtime
            .resume(&thread.id, workspace, &resume_options, resumed_handlers)
            .unwrap();
        assert_eq!(resumed_thread, thread);
        let resumed_turn = resumed
            .send_turn(&thread.id, "Run a command", &[], &TurnOptions::default())
            .unwrap();
        mock.wait_for_count("/prompt_async", 2);
        mock.broadcast(&json!({
            "type": "permission.updated",
            "properties": {
                "id": "permission-1",
                "type": "bash",
                "sessionID": "session-1",
                "messageID": "message-2",
                "title": "cargo test",
                "metadata": {},
                "time": { "created": 200 }
            }
        }));
        let approval = wait_for_approval(&resumed_events);
        assert_eq!(approval.id, "permission-1");
        assert_eq!(approval.kind, ApprovalKind::Command);
        assert_eq!(approval.command.as_deref(), Some("cargo test"));
        assert!(
            resumed
                .respond_to_approval(&approval.id, ApprovalDecision::ApproveSession)
                .unwrap()
        );
        assert!(
            !resumed
                .respond_to_approval(&approval.id, ApprovalDecision::Approve)
                .unwrap()
        );
        let permission = mock
            .wait_for_count("/permissions/permission-1", 1)
            .remove(0);
        assert_eq!(permission.body, Some(json!({ "response": "always" })));

        resumed.interrupt(&thread.id).unwrap();
        mock.wait_for_count("/abort", 1);
        through_terminal(&resumed_events, &resumed_turn, TurnStatus::Interrupted);
        let resumed_snapshot: OpenCodeSessionState =
            serde_json::from_value(resumed.export_state().unwrap().unwrap().into_value()).unwrap();
        assert_eq!(resumed_snapshot.turn_counter, 2);
        resumed.dispose();
    }

    #[test]
    fn rejects_unsupported_approval_and_malformed_models_before_launch() {
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path().to_str().unwrap();
        let runtime = OpenCodeRuntime::default();
        let auto_review = runtime.start(
            workspace,
            &StartOptions {
                approval: Some(ApprovalMode::AutoReview),
                ..StartOptions::default()
            },
            AgentHandlers::default(),
        );
        assert!(matches!(
            auto_review,
            Err(AgentError::Failed(message)) if message.contains("automatic approval review")
        ));
        let malformed = runtime.start(
            workspace,
            &StartOptions {
                model: Some("model-without-provider".into()),
                ..StartOptions::default()
            },
            AgentHandlers::default(),
        );
        assert!(matches!(
            malformed,
            Err(AgentError::Failed(message)) if message.contains("provider/model")
        ));
        assert!(parse_model(Some("provider/model/variant")).is_ok());
    }

    fn recording_handlers() -> (AgentHandlers, Receiver<DomainEvent>) {
        let (sender, receiver) = mpsc::channel();
        (
            AgentHandlers::new(
                move |event| {
                    let _ = sender.send(event);
                },
                |_| {},
            ),
            receiver,
        )
    }

    fn wait_for_approval(receiver: &Receiver<DomainEvent>) -> ApprovalRequest {
        let deadline = Instant::now() + WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "approval did not arrive");
            if let DomainEvent::ApprovalRequested { request } =
                receiver.recv_timeout(remaining).unwrap()
            {
                return request;
            }
        }
    }

    fn through_terminal(
        receiver: &Receiver<DomainEvent>,
        expected_turn_id: &str,
        expected_status: TurnStatus,
    ) -> Vec<DomainEvent> {
        let deadline = Instant::now() + WAIT;
        let mut events = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "terminal event did not arrive");
            let event = receiver.recv_timeout(remaining).unwrap();
            let terminal = matches!(
                &event,
                DomainEvent::TurnCompleted { turn_id, status }
                    if turn_id == expected_turn_id && *status == expected_status
            );
            events.push(event);
            if terminal {
                return events;
            }
        }
    }
}
