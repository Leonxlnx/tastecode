use crate::{
    ApiAdapterError, ApiMessage, ApiRequest, ApiStreamEvent, ApiTool, ApiToolCall, ApiTransport,
    FinishReason,
};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentSession, AgentSessionState, TurnOptions,
};
use harness_protocol::{
    ApprovalDecision, ApprovalKind, ApprovalMode, ApprovalRequest, Capabilities, DomainEvent, Item,
    ItemStatus, ItemType, MessageRole, ProviderId, Thread, Turn, TurnStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

const DEFAULT_MAX_TOOL_CALLS: usize = 32;
const APPROVAL_POLL_INTERVAL: Duration = Duration::from_millis(20);
const SESSION_STATE_VERSION: u32 = 1;

pub const API_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: true,
    approvals: true,
    user_input: None,
    auto_review: None,
    images: false,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiToolResult {
    pub content: String,
    pub is_error: bool,
}

impl ApiToolResult {
    pub fn success(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
        }
    }

    pub fn error(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiToolReview {
    pub kind: ApprovalKind,
    pub reason: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub path: Option<String>,
}

impl ApiToolReview {
    pub fn permissions(path: impl Into<String>) -> Self {
        Self {
            kind: ApprovalKind::Permissions,
            reason: None,
            command: None,
            cwd: None,
            path: Some(path.into()),
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("{0}")]
pub struct ApiToolError(pub String);

impl ApiToolError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

pub trait ApiToolExecutor: Send + Sync {
    fn review(&self, _call: &ApiToolCall) -> Result<Option<ApiToolReview>, ApiToolError> {
        Ok(None)
    }

    fn execute(
        &self,
        _call: &ApiToolCall,
        _cancelled: &AtomicBool,
    ) -> Result<ApiToolResult, ApiToolError> {
        Ok(ApiToolResult::error("Tool execution is unavailable."))
    }
}

struct UnavailableToolExecutor;

impl ApiToolExecutor for UnavailableToolExecutor {}

pub struct ApiSessionOptions {
    pub model: String,
    pub transport: Arc<dyn ApiTransport>,
    pub tools: Vec<ApiTool>,
    pub executor: Arc<dyn ApiToolExecutor>,
    pub max_tool_calls: usize,
    pub secrets: Vec<String>,
    pub instructions: Option<String>,
    pub approval: ApprovalMode,
}

impl ApiSessionOptions {
    pub fn new(model: impl Into<String>, transport: Arc<dyn ApiTransport>) -> Self {
        Self {
            model: model.into(),
            transport,
            tools: Vec::new(),
            executor: Arc::new(UnavailableToolExecutor),
            max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
            secrets: Vec::new(),
            instructions: None,
            approval: ApprovalMode::Ask,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApiSessionState {
    pub version: u32,
    pub thread: Thread,
    pub model: String,
    pub approval: ApprovalMode,
    pub instructions: Option<String>,
    pub instructions_pending: bool,
    pub approved_tools: Vec<String>,
    pub messages: Vec<ApiMessage>,
    pub turn_counter: u64,
}

pub struct ApiAgentSession {
    inner: Arc<SessionInner>,
}

struct SessionInner {
    thread: Thread,
    model: String,
    transport: Arc<dyn ApiTransport>,
    tools: Vec<ApiTool>,
    executor: Arc<dyn ApiToolExecutor>,
    max_tool_calls: usize,
    secrets: Vec<String>,
    instructions: Option<String>,
    approval: ApprovalMode,
    handlers: AgentHandlers,
    state: Mutex<SessionState>,
    state_changed: Condvar,
    disposed: AtomicBool,
}

struct SessionState {
    messages: Vec<ApiMessage>,
    turn_counter: u64,
    instructions_pending: bool,
    active: Option<ActiveTurn>,
    approval: Option<PendingApproval>,
    approved_tools: HashSet<String>,
}

struct ActiveTurn {
    id: String,
    cancelled: Arc<AtomicBool>,
}

struct PendingApproval {
    id: String,
    decision: mpsc::Sender<ApprovalDecision>,
}

impl ApiAgentSession {
    pub fn start(
        workspace_path: &str,
        connection_id: &str,
        options: ApiSessionOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        if connection_id.is_empty() {
            return Err(AgentError::Failed("connectionId is required".into()));
        }
        let thread = Thread {
            id: format!("api-{}", Uuid::new_v4()),
            provider: ProviderId::Api,
            connection_id: Some(connection_id.into()),
            workspace_path: workspace_path.into(),
            title: None,
            created_at: now_ms(),
        };
        let instructions_pending = options
            .instructions
            .as_deref()
            .is_some_and(|instructions| !instructions.is_empty());
        let session = Self::from_parts(
            thread.clone(),
            Vec::new(),
            0,
            instructions_pending,
            HashSet::new(),
            options,
            handlers,
        )?;
        Ok((thread, Arc::new(session)))
    }

    pub fn resume(
        state: ApiSessionState,
        options: ApiSessionOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        if state.version != SESSION_STATE_VERSION {
            return Err(AgentError::Failed(
                "direct API session state version is unsupported".into(),
            ));
        }
        if state.thread.provider != ProviderId::Api {
            return Err(AgentError::Failed(
                "only API threads can resume here".into(),
            ));
        }
        if state.model != options.model {
            return Err(AgentError::Failed(
                "direct API resume model does not match the saved session".into(),
            ));
        }
        if state.approval != options.approval {
            return Err(AgentError::Failed(
                "direct API resume approval mode does not match the saved session".into(),
            ));
        }
        let thread = state.thread.clone();
        let mut options = options;
        options.instructions = state.instructions;
        let session = Self::from_parts(
            state.thread,
            state.messages,
            state.turn_counter,
            state.instructions_pending,
            state.approved_tools.into_iter().collect(),
            options,
            handlers,
        )?;
        Ok((thread, Arc::new(session)))
    }

    fn from_parts(
        thread: Thread,
        messages: Vec<ApiMessage>,
        turn_counter: u64,
        instructions_pending: bool,
        approved_tools: HashSet<String>,
        options: ApiSessionOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<Self> {
        if options.model.trim().is_empty() {
            return Err(AgentError::Failed("a direct API model is required".into()));
        }
        if options.max_tool_calls == 0 {
            return Err(AgentError::Failed(
                "maxToolCalls must be a positive integer".into(),
            ));
        }
        Ok(Self {
            inner: Arc::new(SessionInner {
                thread,
                model: options.model,
                transport: options.transport,
                tools: options.tools,
                executor: options.executor,
                max_tool_calls: options.max_tool_calls,
                secrets: options
                    .secrets
                    .into_iter()
                    .filter(|secret| secret.chars().count() >= 4)
                    .collect(),
                instructions: options.instructions,
                approval: options.approval,
                handlers,
                state: Mutex::new(SessionState {
                    messages,
                    turn_counter,
                    instructions_pending,
                    active: None,
                    approval: None,
                    approved_tools,
                }),
                state_changed: Condvar::new(),
                disposed: AtomicBool::new(false),
            }),
        })
    }

    pub fn snapshot(&self) -> ApiSessionState {
        let state = lock(&self.inner.state);
        let mut approved_tools = state.approved_tools.iter().cloned().collect::<Vec<_>>();
        approved_tools.sort();
        ApiSessionState {
            version: SESSION_STATE_VERSION,
            thread: self.inner.thread.clone(),
            model: self.inner.model.clone(),
            approval: self.inner.approval,
            instructions: self.inner.instructions.clone(),
            instructions_pending: state.instructions_pending,
            approved_tools,
            messages: state.messages.clone(),
            turn_counter: state.turn_counter,
        }
    }

    pub fn send_turn(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        _options: &TurnOptions,
    ) -> AgentResult<String> {
        self.require_thread(thread_id)?;
        if !attachments.is_empty() {
            return Err(AgentError::Failed(
                "direct API attachments are not supported yet".into(),
            ));
        }
        if self.inner.disposed.load(Ordering::Acquire) {
            return Err(AgentError::Failed("direct API session is closed".into()));
        }

        let (turn_id, cancelled) = {
            let mut state = lock(&self.inner.state);
            if state.active.is_some() {
                return Err(AgentError::Failed("a turn is already running".into()));
            }
            state.turn_counter += 1;
            let turn_id = format!("{}-turn-{}", self.inner.thread.id, state.turn_counter);
            let cancelled = Arc::new(AtomicBool::new(false));
            state.active = Some(ActiveTurn {
                id: turn_id.clone(),
                cancelled: Arc::clone(&cancelled),
            });
            (turn_id, cancelled)
        };

        let inner = Arc::clone(&self.inner);
        let worker_turn_id = turn_id.clone();
        let prompt = text.to_owned();
        let spawn = std::thread::Builder::new()
            .name("harness-api-turn".into())
            .spawn(move || {
                let _guard = ActiveTurnGuard {
                    inner: Arc::clone(&inner),
                    turn_id: worker_turn_id.clone(),
                };
                if catch_unwind(AssertUnwindSafe(|| {
                    inner.run_turn(&worker_turn_id, &prompt, cancelled.as_ref());
                }))
                .is_err()
                {
                    inner.report_worker_panic(&worker_turn_id);
                }
            });
        if let Err(error) = spawn {
            self.inner.finish_active(&turn_id);
            return Err(AgentError::Failed(format!(
                "failed to start direct API turn worker: {error}"
            )));
        }
        Ok(turn_id)
    }

    pub fn interrupt(&self, thread_id: &str) -> AgentResult<()> {
        self.require_thread(thread_id)?;
        self.inner.cancel_active();
        Ok(())
    }

    pub fn respond_to_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> AgentResult<bool> {
        let pending = {
            let mut state = lock(&self.inner.state);
            if state.approval.as_ref().map(|pending| pending.id.as_str()) != Some(approval_id) {
                return Ok(false);
            }
            state.approval.take()
        };
        if let Some(pending) = pending {
            let _ = pending.decision.send(decision);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn wait_for_turn(&self, turn_id: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = lock(&self.inner.state);
        while state
            .active
            .as_ref()
            .is_some_and(|active| active.id == turn_id)
        {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let waited = self
                .inner
                .state_changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = waited.0;
            if waited.1.timed_out()
                && state
                    .active
                    .as_ref()
                    .is_some_and(|active| active.id == turn_id)
            {
                return false;
            }
        }
        true
    }

    pub fn dispose(&self) {
        if self.inner.disposed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.inner.cancel_active();
    }

    fn require_thread(&self, thread_id: &str) -> AgentResult<()> {
        if self.inner.thread.id != thread_id {
            return Err(AgentError::Failed("no such API thread".into()));
        }
        Ok(())
    }
}

impl AgentSession for ApiAgentSession {
    fn capabilities(&self) -> Capabilities {
        API_CAPABILITIES.clone()
    }

    fn send_turn(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        options: &TurnOptions,
    ) -> AgentResult<String> {
        ApiAgentSession::send_turn(self, thread_id, text, attachments, options)
    }

    fn interrupt(&self, thread_id: &str) -> AgentResult<()> {
        ApiAgentSession::interrupt(self, thread_id)
    }

    fn respond_to_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> AgentResult<bool> {
        ApiAgentSession::respond_to_approval(self, approval_id, decision)
    }

    fn export_state(&self) -> AgentResult<Option<AgentSessionState>> {
        serde_json::to_value(self.snapshot())
            .map(AgentSessionState::new)
            .map(Some)
            .map_err(|error| {
                AgentError::Failed(format!("could not encode direct API state: {error}"))
            })
    }

    fn dispose(&self) {
        ApiAgentSession::dispose(self);
    }
}

struct ActiveTurnGuard {
    inner: Arc<SessionInner>,
    turn_id: String,
}

impl Drop for ActiveTurnGuard {
    fn drop(&mut self) {
        self.inner.finish_active(&self.turn_id);
    }
}

impl SessionInner {
    fn run_turn(&self, turn_id: &str, text: &str, cancelled: &AtomicBool) {
        self.handlers.emit_event(DomainEvent::TurnStarted {
            turn: Turn {
                id: turn_id.into(),
                thread_id: self.thread.id.clone(),
                status: TurnStatus::Running,
                created_at: now_ms(),
            },
        });
        {
            let mut state = lock(&self.state);
            let prompt = if state.instructions_pending {
                state.instructions_pending = false;
                self.instructions
                    .as_ref()
                    .map(|instructions| {
                        format!(
                            "<system-instructions>\n{instructions}\n</system-instructions>\n\n{text}"
                        )
                    })
                    .unwrap_or_else(|| text.into())
            } else {
                text.into()
            };
            state.messages.push(ApiMessage::User { content: prompt });
        }

        let result = self.run_turn_loop(turn_id, cancelled);
        let interrupted =
            cancelled.load(Ordering::Acquire) || matches!(&result, Err(RunError::Interrupted));
        if let Err(ref error) = result {
            self.close_orphaned_tool_calls();
            if !interrupted {
                let detail = redact(&error.message(), &self.secrets);
                self.handlers
                    .emit_log(format!("direct API model request failed: {detail}"));
                self.handlers.emit_event(DomainEvent::ThreadError {
                    thread_id: self.thread.id.clone(),
                    message: if detail.is_empty() {
                        "The model request failed.".into()
                    } else {
                        detail
                    },
                });
            }
        }
        self.handlers.emit_event(DomainEvent::TurnCompleted {
            turn_id: turn_id.into(),
            status: if interrupted {
                TurnStatus::Interrupted
            } else if result.is_ok() {
                TurnStatus::Completed
            } else {
                TurnStatus::Failed
            },
        });
    }

    fn run_turn_loop(&self, turn_id: &str, cancelled: &AtomicBool) -> Result<(), RunError> {
        let mut tool_calls = 0;
        loop {
            check_cancelled(cancelled)?;
            let response = self.stream(turn_id, cancelled)?;
            let calls = response.calls.clone();
            {
                let mut state = lock(&self.state);
                state.messages.push(ApiMessage::Assistant {
                    content: response.text,
                    tool_calls: response.calls,
                    transport_state: response.state,
                });
            }
            if response.finish == FinishReason::Stop {
                return Ok(());
            }
            if calls.is_empty() {
                return Err(RunError::Message("missing tool calls".into()));
            }
            for call in calls {
                tool_calls += 1;
                if tool_calls > self.max_tool_calls {
                    return Err(RunError::Message("tool call limit exceeded".into()));
                }
                self.run_tool(turn_id, &call, cancelled)?;
            }
        }
    }

    fn stream(&self, turn_id: &str, cancelled: &AtomicBool) -> Result<StreamResponse, RunError> {
        check_cancelled(cancelled)?;
        let messages = lock(&self.state).messages.clone();
        let mut collector =
            StreamCollector::new(turn_id, messages.len(), &self.handlers, &self.secrets);
        self.transport.stream(
            ApiRequest {
                model: &self.model,
                messages: &messages,
                tools: &self.tools,
            },
            cancelled,
            &mut |event| collector.handle(event),
        )?;
        collector.finish()
    }

    fn run_tool(
        &self,
        turn_id: &str,
        call: &ApiToolCall,
        cancelled: &AtomicBool,
    ) -> Result<(), RunError> {
        let item_id = format!("{turn_id}-tool-{}", call.id);
        let created_at = now_ms();
        self.handlers.emit_event(DomainEvent::ItemStarted {
            item: Item {
                id: item_id.clone(),
                turn_id: turn_id.into(),
                item_type: ItemType::ToolCall,
                status: ItemStatus::Started,
                role: None,
                text: Some(call.name.clone()),
                command: None,
                exit_code: None,
                duration_ms: None,
                path: None,
                lines_added: None,
                lines_removed: None,
                created_at,
            },
        });

        let result = if self.approved(call, cancelled)? {
            self.executor
                .execute(call, cancelled)
                .unwrap_or_else(|_| ApiToolResult::error("Tool execution failed."))
        } else {
            ApiToolResult::error("Tool execution was denied.")
        };
        let content = redact(&result.content, &self.secrets);
        lock(&self.state).messages.push(ApiMessage::Tool {
            content: content.clone(),
            tool_call_id: call.id.clone(),
            is_error: result.is_error,
        });
        self.handlers.emit_event(DomainEvent::ItemCompleted {
            item: Item {
                id: item_id,
                turn_id: turn_id.into(),
                item_type: ItemType::ToolCall,
                status: if result.is_error {
                    ItemStatus::Failed
                } else {
                    ItemStatus::Completed
                },
                role: None,
                text: Some(format!("{}\n{content}", call.name)),
                command: None,
                exit_code: None,
                duration_ms: None,
                path: None,
                lines_added: None,
                lines_removed: None,
                created_at,
            },
        });
        Ok(())
    }

    fn approved(&self, call: &ApiToolCall, cancelled: &AtomicBool) -> Result<bool, RunError> {
        check_cancelled(cancelled)?;
        let Some(review) = self.executor.review(call)? else {
            return Ok(true);
        };
        let approval_key = format!(
            "{}\0{}\0{}\0{}",
            call.name,
            review.command.as_deref().unwrap_or_default(),
            review.path.as_deref().unwrap_or_default(),
            review.reason.as_deref().unwrap_or_default()
        );
        if lock(&self.state).approved_tools.contains(&approval_key) {
            return Ok(true);
        }

        let request = ApprovalRequest {
            id: Uuid::new_v4().to_string(),
            kind: review.kind,
            reason: review.reason,
            command: review.command,
            cwd: review.cwd,
            path: review.path,
            created_at: now_ms(),
        };
        let (decision, receiver) = mpsc::channel();
        {
            let mut state = lock(&self.state);
            if state.approval.is_some() {
                return Err(RunError::Message(
                    "another direct API approval is already pending".into(),
                ));
            }
            state.approval = Some(PendingApproval {
                id: request.id.clone(),
                decision,
            });
        }
        self.handlers.emit_event(DomainEvent::ApprovalRequested {
            request: request.clone(),
        });

        let decision = loop {
            if cancelled.load(Ordering::Acquire) {
                self.clear_approval(&request.id);
                break ApprovalDecision::Abort;
            }
            match receiver.recv_timeout(APPROVAL_POLL_INTERVAL) {
                Ok(decision) => break decision,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(RunError::Message(
                        "direct API approval channel closed".into(),
                    ));
                }
            }
        };
        self.clear_approval(&request.id);
        self.handlers
            .emit_event(DomainEvent::ApprovalResolved { id: request.id });
        match decision {
            ApprovalDecision::Abort => Err(RunError::Interrupted),
            ApprovalDecision::Deny => Ok(false),
            ApprovalDecision::Approve => Ok(true),
            ApprovalDecision::ApproveSession => {
                lock(&self.state).approved_tools.insert(approval_key);
                Ok(true)
            }
        }
    }

    fn close_orphaned_tool_calls(&self) {
        let mut state = lock(&self.state);
        let calls = state
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                ApiMessage::Assistant { tool_calls, .. } if !tool_calls.is_empty() => {
                    Some(tool_calls.clone())
                }
                _ => None,
            })
            .unwrap_or_default();
        if calls.is_empty() {
            return;
        }
        let answered = state
            .messages
            .iter()
            .filter_map(|message| match message {
                ApiMessage::Tool { tool_call_id, .. } => Some(tool_call_id.clone()),
                _ => None,
            })
            .collect::<HashSet<_>>();
        for call in calls {
            if !answered.contains(&call.id) {
                state.messages.push(ApiMessage::Tool {
                    content: "Tool execution was interrupted.".into(),
                    tool_call_id: call.id,
                    is_error: true,
                });
            }
        }
    }

    fn clear_approval(&self, approval_id: &str) {
        let mut state = lock(&self.state);
        if state.approval.as_ref().map(|pending| pending.id.as_str()) == Some(approval_id) {
            state.approval = None;
        }
    }

    fn cancel_active(&self) {
        let pending = {
            let mut state = lock(&self.state);
            if let Some(active) = &state.active {
                active.cancelled.store(true, Ordering::Release);
            }
            state.approval.take()
        };
        if let Some(pending) = pending {
            let _ = pending.decision.send(ApprovalDecision::Abort);
        }
    }

    fn finish_active(&self, turn_id: &str) {
        let changed = {
            let mut state = lock(&self.state);
            if state
                .active
                .as_ref()
                .is_some_and(|active| active.id == turn_id)
            {
                state.active = None;
                true
            } else {
                false
            }
        };
        if changed {
            self.state_changed.notify_all();
        }
    }

    fn report_worker_panic(&self, turn_id: &str) {
        self.handlers
            .emit_log("direct API turn worker stopped unexpectedly");
        self.handlers.emit_event(DomainEvent::ThreadError {
            thread_id: self.thread.id.clone(),
            message: "The model request failed.".into(),
        });
        self.handlers.emit_event(DomainEvent::TurnCompleted {
            turn_id: turn_id.into(),
            status: TurnStatus::Failed,
        });
    }
}

struct StreamResponse {
    text: String,
    calls: Vec<ApiToolCall>,
    finish: FinishReason,
    state: Option<Value>,
}

struct StreamCollector<'a> {
    handlers: &'a AgentHandlers,
    secrets: &'a [String],
    turn_id: &'a str,
    item_id: String,
    reasoning_id: String,
    holdback: usize,
    started: bool,
    reasoning_started: bool,
    text: String,
    reasoning: String,
    pending_text: String,
    pending_reasoning: String,
    calls: Vec<ApiToolCall>,
    finish: Option<FinishReason>,
    state: Option<Value>,
}

impl<'a> StreamCollector<'a> {
    fn new(
        turn_id: &'a str,
        message_count: usize,
        handlers: &'a AgentHandlers,
        secrets: &'a [String],
    ) -> Self {
        let item_id = format!("{turn_id}-assistant-{message_count}");
        Self {
            handlers,
            secrets,
            turn_id,
            reasoning_id: format!("{item_id}-reasoning"),
            item_id,
            holdback: secrets
                .iter()
                .map(|secret| secret.chars().count())
                .max()
                .unwrap_or(1)
                .saturating_sub(1),
            started: false,
            reasoning_started: false,
            text: String::new(),
            reasoning: String::new(),
            pending_text: String::new(),
            pending_reasoning: String::new(),
            calls: Vec::new(),
            finish: None,
            state: None,
        }
    }

    fn handle(&mut self, event: ApiStreamEvent) {
        match event {
            ApiStreamEvent::Text(delta) => {
                if !self.started {
                    self.started = true;
                    self.emit_item_started(
                        &self.item_id,
                        ItemType::Message,
                        Some(MessageRole::Assistant),
                    );
                }
                let chunk = safe_delta(&mut self.pending_text, &delta, self.holdback, self.secrets);
                self.text.push_str(&chunk);
                self.emit_delta(&self.item_id, chunk);
            }
            ApiStreamEvent::Reasoning(delta) => {
                if !self.reasoning_started {
                    self.reasoning_started = true;
                    self.emit_item_started(&self.reasoning_id, ItemType::Reasoning, None);
                }
                let chunk = safe_delta(
                    &mut self.pending_reasoning,
                    &delta,
                    self.holdback,
                    self.secrets,
                );
                self.reasoning.push_str(&chunk);
                self.emit_delta(&self.reasoning_id, chunk);
            }
            ApiStreamEvent::ToolCall(call) => self.calls.push(call),
            ApiStreamEvent::Usage(usage) => self
                .handlers
                .emit_event(DomainEvent::UsageUpdated { usage }),
            ApiStreamEvent::State(state) => self.state = Some(state),
            ApiStreamEvent::Finish(finish) => self.finish = Some(finish),
        }
    }

    fn finish(mut self) -> Result<StreamResponse, RunError> {
        let finish = self
            .finish
            .ok_or_else(|| RunError::Message("transport ended without a finish event".into()))?;
        let tail_text = redact(&self.pending_text, self.secrets);
        self.text.push_str(&tail_text);
        if self.started {
            self.emit_delta(&self.item_id, tail_text);
        }
        let tail_reasoning = redact(&self.pending_reasoning, self.secrets);
        self.reasoning.push_str(&tail_reasoning);
        if self.reasoning_started {
            self.emit_delta(&self.reasoning_id, tail_reasoning);
        }
        if self.started {
            self.emit_item_completed(
                &self.item_id,
                ItemType::Message,
                Some(MessageRole::Assistant),
                self.text.clone(),
            );
        }
        if self.reasoning_started {
            self.emit_item_completed(
                &self.reasoning_id,
                ItemType::Reasoning,
                None,
                self.reasoning.clone(),
            );
        }
        Ok(StreamResponse {
            text: self.text,
            calls: self.calls,
            finish,
            state: self.state,
        })
    }

    fn emit_item_started(&self, id: &str, item_type: ItemType, role: Option<MessageRole>) {
        self.handlers.emit_event(DomainEvent::ItemStarted {
            item: stream_item(id, self.turn_id, item_type, ItemStatus::Started, role, ""),
        });
    }

    fn emit_item_completed(
        &self,
        id: &str,
        item_type: ItemType,
        role: Option<MessageRole>,
        text: String,
    ) {
        self.handlers.emit_event(DomainEvent::ItemCompleted {
            item: stream_item(
                id,
                self.turn_id,
                item_type,
                ItemStatus::Completed,
                role,
                &text,
            ),
        });
    }

    fn emit_delta(&self, item_id: &str, delta: String) {
        if !delta.is_empty() {
            self.handlers.emit_event(DomainEvent::ItemDelta {
                turn_id: self.turn_id.into(),
                item_id: item_id.into(),
                text_delta: delta,
            });
        }
    }
}

fn stream_item(
    id: &str,
    turn_id: &str,
    item_type: ItemType,
    status: ItemStatus,
    role: Option<MessageRole>,
    text: &str,
) -> Item {
    Item {
        id: id.into(),
        turn_id: turn_id.into(),
        item_type,
        status,
        role,
        text: Some(text.into()),
        command: None,
        exit_code: None,
        duration_ms: None,
        path: None,
        lines_added: None,
        lines_removed: None,
        created_at: now_ms(),
    }
}

fn safe_delta(pending: &mut String, delta: &str, holdback: usize, secrets: &[String]) -> String {
    pending.push_str(delta);
    let redacted = redact(pending, secrets);
    let safe_chars = redacted.chars().count().saturating_sub(holdback);
    let split = redacted
        .char_indices()
        .nth(safe_chars)
        .map(|(index, _)| index)
        .unwrap_or(redacted.len());
    let chunk = redacted[..split].to_owned();
    *pending = redacted[split..].to_owned();
    chunk
}

fn redact(value: &str, secrets: &[String]) -> String {
    secrets.iter().fold(value.to_owned(), |text, secret| {
        text.replace(secret, "[REDACTED]")
    })
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), RunError> {
    if cancelled.load(Ordering::Acquire) {
        Err(RunError::Interrupted)
    } else {
        Ok(())
    }
}

#[derive(Debug)]
enum RunError {
    Interrupted,
    Message(String),
}

impl RunError {
    fn message(&self) -> String {
        match self {
            Self::Interrupted => "direct API request was interrupted".into(),
            Self::Message(message) => message.clone(),
        }
    }
}

impl From<ApiAdapterError> for RunError {
    fn from(error: ApiAdapterError) -> Self {
        match error {
            ApiAdapterError::Interrupted => Self::Interrupted,
            error => Self::Message(error.to_string()),
        }
    }
}

impl From<ApiToolError> for RunError {
    fn from(error: ApiToolError) -> Self {
        Self::Message(error.to_string())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;

    const WAIT: Duration = Duration::from_secs(2);

    #[test]
    fn adds_shared_instructions_to_the_first_provider_prompt_only() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            vec![ApiStreamEvent::Finish(FinishReason::Stop)],
            vec![ApiStreamEvent::Finish(FinishReason::Stop)],
        ]));
        let mut options = ApiSessionOptions::new("test-model", transport.clone());
        options.instructions = Some("Answer plainly.".into());
        let (thread, initial_session) = ApiAgentSession::start(
            "C:\\repo",
            "connection-1",
            options,
            AgentHandlers::default(),
        )
        .unwrap();
        let initial_state = initial_session.snapshot();
        assert_eq!(
            initial_state.instructions.as_deref(),
            Some("Answer plainly.")
        );
        assert!(initial_state.instructions_pending);
        initial_session.dispose();
        let (resumed_thread, session) = ApiAgentSession::resume(
            initial_state,
            ApiSessionOptions::new("test-model", transport.clone()),
            AgentHandlers::default(),
        )
        .unwrap();
        assert_eq!(resumed_thread, thread);

        let first = session
            .send_turn(&thread.id, "First", &[], &TurnOptions::default())
            .unwrap();
        assert!(session.wait_for_turn(&first, WAIT));
        let second = session
            .send_turn(&thread.id, "Second", &[], &TurnOptions::default())
            .unwrap();
        assert!(session.wait_for_turn(&second, WAIT));

        let seen = lock(&transport.seen);
        assert!(user_content(&seen[0][0]).contains("Answer plainly."));
        assert!(user_content(&seen[0][0]).contains("First"));
        assert_eq!(user_content(seen[1].last().unwrap()), "Second");
    }

    #[test]
    fn streams_provider_neutral_events_and_resumes_history() {
        let transport = Arc::new(ScriptedTransport::new(vec![vec![
            ApiStreamEvent::Text("Hello ".into()),
            ApiStreamEvent::Text("world".into()),
            ApiStreamEvent::State(serde_json::json!([{ "type": "provider-state" }])),
            ApiStreamEvent::Finish(FinishReason::Stop),
        ]]));
        let recording = recording_handlers();
        let events = Arc::clone(&recording.events);
        let mut options = ApiSessionOptions::new("test-model", transport);
        options.approval = ApprovalMode::AutoReview;
        let (thread, session) =
            ApiAgentSession::start("C:\\repo", "connection-1", options, recording.handlers)
                .unwrap();
        let turn_id = session
            .send_turn(&thread.id, "Hi", &[], &TurnOptions::default())
            .unwrap();
        assert!(session.wait_for_turn(&turn_id, WAIT));
        assert!(lock(&events).iter().any(|event| {
            matches!(
                event,
                DomainEvent::TurnCompleted {
                    turn_id: id,
                    status: TurnStatus::Completed
                } if id == &turn_id
            )
        }));

        let snapshot = session.snapshot();
        assert_eq!(snapshot.version, SESSION_STATE_VERSION);
        assert_eq!(snapshot.model, "test-model");
        assert_eq!(snapshot.approval, ApprovalMode::AutoReview);
        assert_eq!(snapshot.instructions, None);
        assert!(!snapshot.instructions_pending);
        assert!(snapshot.approved_tools.is_empty());
        assert_eq!(
            snapshot.messages,
            vec![
                ApiMessage::User {
                    content: "Hi".into()
                },
                ApiMessage::Assistant {
                    content: "Hello world".into(),
                    tool_calls: Vec::new(),
                    transport_state: Some(serde_json::json!([{ "type": "provider-state" }])),
                }
            ]
        );
        let exported = session.export_state().unwrap().unwrap();
        let decoded: ApiSessionState = serde_json::from_value(exported.into_value()).unwrap();
        assert_eq!(decoded, snapshot);

        let mut unsupported = snapshot.clone();
        unsupported.version += 1;
        let unsupported_transport = Arc::new(ScriptedTransport::new(Vec::new()));
        assert!(matches!(
            ApiAgentSession::resume(
                unsupported,
                ApiSessionOptions::new("test-model", unsupported_transport),
                AgentHandlers::default(),
            ),
            Err(AgentError::Failed(message)) if message.contains("version")
        ));

        let resumed_transport =
            Arc::new(ScriptedTransport::new(vec![vec![ApiStreamEvent::Finish(
                FinishReason::Stop,
            )]]));
        let mut resumed_options = ApiSessionOptions::new("test-model", resumed_transport);
        resumed_options.approval = ApprovalMode::AutoReview;
        let (resumed_thread, resumed) =
            ApiAgentSession::resume(snapshot, resumed_options, AgentHandlers::default()).unwrap();
        assert_eq!(resumed_thread, thread);
        let resumed_turn = resumed
            .send_turn(&thread.id, "Again", &[], &TurnOptions::default())
            .unwrap();
        assert!(resumed_turn.ends_with("-turn-2"));
        assert!(resumed.wait_for_turn(&resumed_turn, WAIT));
    }

    #[test]
    fn runs_tools_only_after_the_matching_approval() {
        let transport = Arc::new(ScriptedTransport::new(vec![
            vec![
                ApiStreamEvent::ToolCall(ApiToolCall {
                    id: "call-1".into(),
                    name: "read_file".into(),
                    input: serde_json::json!({ "path": "README.md" }),
                }),
                ApiStreamEvent::Finish(FinishReason::ToolCalls),
            ],
            vec![
                ApiStreamEvent::Text("The file says hello.".into()),
                ApiStreamEvent::Finish(FinishReason::Stop),
            ],
        ]));
        let executor = Arc::new(TestExecutor {
            review: true,
            calls: AtomicUsize::new(0),
        });
        let (event_sender, event_receiver) = mpsc::channel();
        let handlers = AgentHandlers::new(
            move |event| {
                let _ = event_sender.send(event);
            },
            |_| {},
        );
        let mut options = ApiSessionOptions::new("test-model", transport.clone());
        options.tools = vec![ApiTool {
            name: "read_file".into(),
            description: "Read a file".into(),
            input_schema: serde_json::json!({ "type": "object" }),
        }];
        options.executor = executor.clone();
        let (thread, session) =
            ApiAgentSession::start("C:\\repo", "connection-1", options, handlers).unwrap();
        let turn_id = session
            .send_turn(&thread.id, "Read it", &[], &TurnOptions::default())
            .unwrap();
        let approval_id = loop {
            let event = event_receiver.recv_timeout(WAIT).unwrap();
            if let DomainEvent::ApprovalRequested { request } = event {
                break request.id;
            }
        };
        assert_eq!(executor.calls.load(Ordering::Acquire), 0);
        assert!(
            session
                .respond_to_approval(&approval_id, ApprovalDecision::ApproveSession)
                .unwrap()
        );
        assert!(session.wait_for_turn(&turn_id, WAIT));
        assert_eq!(executor.calls.load(Ordering::Acquire), 1);

        let seen = lock(&transport.seen);
        assert_eq!(
            seen[1],
            vec![
                ApiMessage::User {
                    content: "Read it".into()
                },
                ApiMessage::Assistant {
                    content: String::new(),
                    tool_calls: vec![ApiToolCall {
                        id: "call-1".into(),
                        name: "read_file".into(),
                        input: serde_json::json!({ "path": "README.md" }),
                    }],
                    transport_state: None,
                },
                ApiMessage::Tool {
                    content: "hello".into(),
                    tool_call_id: "call-1".into(),
                    is_error: false,
                }
            ]
        );
        drop(seen);

        let snapshot = session.snapshot();
        assert_eq!(snapshot.approved_tools.len(), 1);
        let resumed_transport = Arc::new(ScriptedTransport::new(vec![
            vec![
                ApiStreamEvent::ToolCall(ApiToolCall {
                    id: "call-2".into(),
                    name: "read_file".into(),
                    input: serde_json::json!({ "path": "README.md" }),
                }),
                ApiStreamEvent::Finish(FinishReason::ToolCalls),
            ],
            vec![ApiStreamEvent::Finish(FinishReason::Stop)],
        ]));
        let resumed_executor = Arc::new(TestExecutor {
            review: true,
            calls: AtomicUsize::new(0),
        });
        let resumed_recording = recording_handlers();
        let resumed_events = Arc::clone(&resumed_recording.events);
        let mut resumed_options = ApiSessionOptions::new("test-model", resumed_transport);
        resumed_options.executor = resumed_executor.clone();
        let (_, resumed) =
            ApiAgentSession::resume(snapshot, resumed_options, resumed_recording.handlers).unwrap();
        let resumed_turn = resumed
            .send_turn(&thread.id, "Read it again", &[], &TurnOptions::default())
            .unwrap();
        assert!(resumed.wait_for_turn(&resumed_turn, WAIT));
        assert_eq!(resumed_executor.calls.load(Ordering::Acquire), 1);
        assert!(
            !lock(&resumed_events)
                .iter()
                .any(|event| matches!(event, DomainEvent::ApprovalRequested { .. }))
        );
    }

    #[test]
    fn aborting_an_approval_marks_the_turn_interrupted() {
        let transport = Arc::new(ScriptedTransport::new(vec![vec![
            ApiStreamEvent::ToolCall(ApiToolCall {
                id: "call-1".into(),
                name: "write_file".into(),
                input: serde_json::json!({ "path": "README.md" }),
            }),
            ApiStreamEvent::Finish(FinishReason::ToolCalls),
        ]]));
        let (event_sender, event_receiver) = mpsc::channel();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let recorded_target = Arc::clone(&recorded);
        let handlers = AgentHandlers::new(
            move |event| {
                lock(&recorded_target).push(event.clone());
                let _ = event_sender.send(event);
            },
            |_| {},
        );
        let mut options = ApiSessionOptions::new("test-model", transport);
        options.executor = Arc::new(TestExecutor {
            review: true,
            calls: AtomicUsize::new(0),
        });
        let (thread, session) =
            ApiAgentSession::start("C:\\repo", "connection-1", options, handlers).unwrap();
        let turn_id = session
            .send_turn(&thread.id, "Change it", &[], &TurnOptions::default())
            .unwrap();
        let approval_id = loop {
            if let DomainEvent::ApprovalRequested { request } =
                event_receiver.recv_timeout(WAIT).unwrap()
            {
                break request.id;
            }
        };
        session
            .respond_to_approval(&approval_id, ApprovalDecision::Abort)
            .unwrap();
        assert!(session.wait_for_turn(&turn_id, WAIT));
        let events = lock(&recorded);
        assert!(events.iter().any(|event| {
            matches!(
                event,
                DomainEvent::TurnCompleted {
                    status: TurnStatus::Interrupted,
                    ..
                }
            )
        }));
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, DomainEvent::ThreadError { .. }))
        );
    }

    #[test]
    fn interrupt_completes_the_turn_without_leaking_transport_errors() {
        let secret = "sk-test-secret";
        let (entered_sender, entered_receiver) = mpsc::channel();
        let transport = Arc::new(BlockingTransport {
            entered: Mutex::new(Some(entered_sender)),
            secret: secret.into(),
        });
        let recording = recording_handlers();
        let events = Arc::clone(&recording.events);
        let logs = Arc::clone(&recording.logs);
        let mut options = ApiSessionOptions::new("test-model", transport);
        options.secrets = vec![secret.into()];
        let (thread, session) =
            ApiAgentSession::start("C:\\repo", "connection-1", options, recording.handlers)
                .unwrap();
        let turn_id = session
            .send_turn(&thread.id, "Wait", &[], &TurnOptions::default())
            .unwrap();
        entered_receiver.recv_timeout(WAIT).unwrap();
        session.interrupt(&thread.id).unwrap();
        assert!(session.wait_for_turn(&turn_id, WAIT));

        let events = lock(&events);
        assert!(events.iter().any(|event| {
            matches!(
                event,
                DomainEvent::TurnCompleted {
                    turn_id: id,
                    status: TurnStatus::Interrupted
                } if id == &turn_id
            )
        }));
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, DomainEvent::ThreadError { .. }))
        );
        assert!(!format!("{events:?}{:?}", lock(&logs)).contains(secret));
    }

    #[test]
    fn synthesizes_results_for_tool_calls_orphaned_by_the_limit() {
        let transport = Arc::new(ScriptedTransport::new(vec![vec![
            ApiStreamEvent::ToolCall(ApiToolCall {
                id: "call-1".into(),
                name: "boom".into(),
                input: serde_json::json!({}),
            }),
            ApiStreamEvent::ToolCall(ApiToolCall {
                id: "call-2".into(),
                name: "boom".into(),
                input: serde_json::json!({}),
            }),
            ApiStreamEvent::Finish(FinishReason::ToolCalls),
        ]]));
        let recording = recording_handlers();
        let events = Arc::clone(&recording.events);
        let mut options = ApiSessionOptions::new("test-model", transport);
        options.max_tool_calls = 1;
        options.executor = Arc::new(TestExecutor {
            review: false,
            calls: AtomicUsize::new(0),
        });
        let (thread, session) =
            ApiAgentSession::start("C:\\repo", "connection-1", options, recording.handlers)
                .unwrap();
        let turn_id = session
            .send_turn(&thread.id, "Go", &[], &TurnOptions::default())
            .unwrap();
        assert!(session.wait_for_turn(&turn_id, WAIT));

        assert!(lock(&events).iter().any(|event| {
            matches!(
                event,
                DomainEvent::TurnCompleted {
                    status: TurnStatus::Failed,
                    ..
                }
            )
        }));
        assert!(session.snapshot().messages.iter().any(|message| {
            matches!(
                message,
                ApiMessage::Tool {
                    tool_call_id,
                    content,
                    is_error: true,
                } if tool_call_id == "call-2" && content == "Tool execution was interrupted."
            )
        }));
    }

    #[test]
    fn rolling_redaction_holds_back_secrets_split_across_deltas() {
        let secret = "sk-super-secret-key";
        let transport = Arc::new(ScriptedTransport::new(vec![vec![
            ApiStreamEvent::Text(format!("prefix {}", &secret[..8])),
            ApiStreamEvent::Text(format!("{} suffix", &secret[8..])),
            ApiStreamEvent::Finish(FinishReason::Stop),
        ]]));
        let recording = recording_handlers();
        let events = Arc::clone(&recording.events);
        let mut options = ApiSessionOptions::new("test-model", transport);
        options.secrets = vec![secret.into()];
        let (thread, session) =
            ApiAgentSession::start("C:\\repo", "connection-1", options, recording.handlers)
                .unwrap();
        let turn_id = session
            .send_turn(&thread.id, "Hi", &[], &TurnOptions::default())
            .unwrap();
        assert!(session.wait_for_turn(&turn_id, WAIT));

        let deltas = lock(&events)
            .iter()
            .filter_map(|event| match event {
                DomainEvent::ItemDelta { text_delta, .. } => Some(text_delta.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert_eq!(deltas, "prefix [REDACTED] suffix");
        assert!(!deltas.contains(secret));
        assert!(session.snapshot().messages.iter().any(|message| {
            matches!(
                message,
                ApiMessage::Assistant { content, .. }
                    if content == "prefix [REDACTED] suffix"
            )
        }));
    }

    struct ScriptedTransport {
        scripts: Mutex<VecDeque<Vec<ApiStreamEvent>>>,
        seen: Mutex<Vec<Vec<ApiMessage>>>,
    }

    impl ScriptedTransport {
        fn new(scripts: Vec<Vec<ApiStreamEvent>>) -> Self {
            Self {
                scripts: Mutex::new(scripts.into()),
                seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl ApiTransport for ScriptedTransport {
        fn stream(
            &self,
            request: ApiRequest<'_>,
            cancelled: &AtomicBool,
            emit: &mut dyn FnMut(ApiStreamEvent),
        ) -> Result<(), ApiAdapterError> {
            lock(&self.seen).push(request.messages.to_vec());
            let script = lock(&self.scripts)
                .pop_front()
                .ok_or_else(|| ApiAdapterError::Provider("missing test response".into()))?;
            for event in script {
                if cancelled.load(Ordering::Acquire) {
                    return Err(ApiAdapterError::Interrupted);
                }
                emit(event);
            }
            Ok(())
        }
    }

    struct BlockingTransport {
        entered: Mutex<Option<mpsc::Sender<()>>>,
        secret: String,
    }

    impl ApiTransport for BlockingTransport {
        fn stream(
            &self,
            _request: ApiRequest<'_>,
            cancelled: &AtomicBool,
            _emit: &mut dyn FnMut(ApiStreamEvent),
        ) -> Result<(), ApiAdapterError> {
            if let Some(entered) = lock(&self.entered).take() {
                let _ = entered.send(());
            }
            while !cancelled.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(ApiAdapterError::Provider(self.secret.clone()))
        }
    }

    struct TestExecutor {
        review: bool,
        calls: AtomicUsize,
    }

    impl ApiToolExecutor for TestExecutor {
        fn review(&self, call: &ApiToolCall) -> Result<Option<ApiToolReview>, ApiToolError> {
            Ok(self
                .review
                .then(|| ApiToolReview::permissions(call.input["path"].as_str().unwrap_or("."))))
        }

        fn execute(
            &self,
            _call: &ApiToolCall,
            _cancelled: &AtomicBool,
        ) -> Result<ApiToolResult, ApiToolError> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            Ok(ApiToolResult::success("hello"))
        }
    }

    struct Recording {
        handlers: AgentHandlers,
        events: Arc<Mutex<Vec<DomainEvent>>>,
        logs: Arc<Mutex<Vec<String>>>,
    }

    fn recording_handlers() -> Recording {
        let events = Arc::new(Mutex::new(Vec::new()));
        let logs = Arc::new(Mutex::new(Vec::new()));
        let event_target = Arc::clone(&events);
        let log_target = Arc::clone(&logs);
        Recording {
            handlers: AgentHandlers::new(
                move |event| lock(&event_target).push(event),
                move |line| lock(&log_target).push(line),
            ),
            events,
            logs,
        }
    }

    fn user_content(message: &ApiMessage) -> &str {
        match message {
            ApiMessage::User { content } => content,
            _ => panic!("expected a user message"),
        }
    }
}
