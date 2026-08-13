use crate::GrokEventMapper;
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentSession, AgentSessionState, StartOptions,
    TurnOptions,
};
use harness_proc::{
    DEFAULT_MAX_NDJSON_LINE, NdjsonFrame, SpawnOptions, SpawnedChild, read_ndjson, spawn_direct,
};
use harness_protocol::{
    ApprovalDecision, ApprovalMode, Capabilities, DomainEvent, ProviderId, Thread, Turn, TurnStatus,
};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SESSION_STATE_VERSION: u32 = 1;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const STOP_NONE: u8 = 0;
const STOP_INTERRUPT: u8 = 1;
const STOP_DISPOSE: u8 = 2;

pub const GROK_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: true,
    approvals: false,
    user_input: None,
    auto_review: None,
    images: false,
};

#[derive(Clone, Debug)]
pub(crate) struct GrokCommand {
    pub(crate) program: OsString,
    pub(crate) prefix_args: Vec<OsString>,
    pub(crate) environment: Vec<(OsString, OsString)>,
    pub(crate) append_turn_args: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GrokSessionState {
    pub version: u32,
    pub thread: Thread,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub approval: Option<ApprovalMode>,
    pub instructions: Option<String>,
    pub instructions_pending: bool,
    pub session_id: Option<String>,
    pub turn_counter: u64,
}

pub struct GrokSession {
    inner: Arc<SessionInner>,
}

struct SessionInner {
    thread: Thread,
    workspace: PathBuf,
    approval: Option<ApprovalMode>,
    instructions: Option<String>,
    command: GrokCommand,
    handlers: AgentHandlers,
    state: Mutex<SessionState>,
    state_changed: Condvar,
    disposed: AtomicBool,
}

struct SessionState {
    model: Option<String>,
    effort: Option<String>,
    instructions_pending: bool,
    session_id: Option<String>,
    turn_counter: u64,
    active: Option<ActiveTurn>,
}

#[derive(Clone)]
struct ActiveTurn {
    id: String,
    child: Arc<Mutex<SpawnedChild>>,
    stop: Arc<AtomicU8>,
}

impl GrokSession {
    pub(crate) fn start(
        workspace_path: &str,
        options: &StartOptions,
        command: GrokCommand,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        validate_approval(options.approval)?;
        let thread = Thread {
            id: format!("grok-{}", Uuid::new_v4()),
            provider: ProviderId::Grok,
            connection_id: None,
            workspace_path: workspace_path.into(),
            title: None,
            created_at: now_ms(),
        };
        let session = Self::from_state(
            GrokSessionState {
                version: SESSION_STATE_VERSION,
                thread: thread.clone(),
                model: options.model.clone(),
                effort: options.effort.clone(),
                approval: options.approval,
                instructions: options.instructions.clone(),
                instructions_pending: options
                    .instructions
                    .as_deref()
                    .is_some_and(|instructions| !instructions.is_empty()),
                session_id: None,
                turn_counter: 0,
            },
            command,
            handlers,
        )?;
        Ok((thread, Arc::new(session)))
    }

    pub(crate) fn resume(
        state: GrokSessionState,
        command: GrokCommand,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        validate_state(&state)?;
        let thread = state.thread.clone();
        Ok((
            thread,
            Arc::new(Self::from_state(state, command, handlers)?),
        ))
    }

    fn from_state(
        state: GrokSessionState,
        command: GrokCommand,
        handlers: AgentHandlers,
    ) -> AgentResult<Self> {
        let workspace = PathBuf::from(&state.thread.workspace_path);
        if !workspace.is_dir() {
            return Err(AgentError::Failed("Grok workspace is unavailable".into()));
        }
        Ok(Self {
            inner: Arc::new(SessionInner {
                thread: state.thread,
                workspace,
                approval: state.approval,
                instructions: state.instructions,
                command,
                handlers,
                state: Mutex::new(SessionState {
                    model: state.model,
                    effort: state.effort,
                    instructions_pending: state.instructions_pending,
                    session_id: state.session_id,
                    turn_counter: state.turn_counter,
                    active: None,
                }),
                state_changed: Condvar::new(),
                disposed: AtomicBool::new(false),
            }),
        })
    }

    pub fn snapshot(&self) -> GrokSessionState {
        let state = lock(&self.inner.state);
        GrokSessionState {
            version: SESSION_STATE_VERSION,
            thread: self.inner.thread.clone(),
            model: state.model.clone(),
            effort: state.effort.clone(),
            approval: self.inner.approval,
            instructions: self.inner.instructions.clone(),
            instructions_pending: state.instructions_pending,
            session_id: state.session_id.clone(),
            turn_counter: state.turn_counter,
        }
    }

    pub fn wait_for_turn(&self, turn_id: &str, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        let mut state = lock(&self.inner.state);
        while state
            .active
            .as_ref()
            .is_some_and(|active| active.id == turn_id)
        {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
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

    fn send_turn_inner(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        options: &TurnOptions,
    ) -> AgentResult<String> {
        self.require_thread(thread_id)?;
        if !attachments.is_empty() {
            return Err(AgentError::Failed(
                "Grok attachments are not supported yet".into(),
            ));
        }
        if self.inner.disposed.load(Ordering::Acquire) {
            return Err(AgentError::Failed("Grok session is closed".into()));
        }

        let mut state = lock(&self.inner.state);
        if state.active.is_some() {
            return Err(AgentError::Failed("a Grok turn is already running".into()));
        }
        let SessionState { model, effort, .. } = &mut *state;
        apply_turn_options(model, effort, options);
        let next_counter = state.turn_counter.saturating_add(1);
        let turn_id = format!("{}-turn-{next_counter}", self.inner.thread.id);
        let prompt = grok_prompt(
            text,
            state
                .instructions_pending
                .then_some(self.inner.instructions.as_deref())
                .flatten(),
        );
        let turn_args = grok_turn_args(
            &prompt,
            state.model.as_deref(),
            state.effort.as_deref(),
            self.inner.approval,
            state.session_id.as_deref(),
        )?;
        let mut args = self.inner.command.prefix_args.clone();
        if self.inner.command.append_turn_args {
            args.extend(turn_args);
        }
        let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
        let mut child = spawn_direct(
            self.inner.command.program.as_os_str(),
            &arg_refs,
            &SpawnOptions {
                cwd: Some(self.inner.workspace.clone()),
                environment: self.inner.command.environment.clone(),
                replace_environment: false,
            },
        )
        .map_err(|_| AgentError::Failed("Grok CLI could not start".into()))?;
        drop(child.take_stdin());
        let stdout = child
            .take_stdout()
            .ok_or_else(|| AgentError::Failed("Grok stdout is unavailable".into()))?;
        let stderr = child
            .take_stderr()
            .ok_or_else(|| AgentError::Failed("Grok stderr is unavailable".into()))?;
        let child = Arc::new(Mutex::new(child));
        let stop = Arc::new(AtomicU8::new(STOP_NONE));
        state.instructions_pending = false;
        state.turn_counter = next_counter;
        state.active = Some(ActiveTurn {
            id: turn_id.clone(),
            child: Arc::clone(&child),
            stop: Arc::clone(&stop),
        });
        drop(state);

        let (start, run) = std::sync::mpsc::channel();
        let inner = Arc::clone(&self.inner);
        let worker_turn_id = turn_id.clone();
        let spawn = thread::Builder::new()
            .name("harness-grok-turn".into())
            .spawn(move || {
                if run.recv().is_ok() {
                    run_turn(inner, worker_turn_id, child, stop, stdout, stderr);
                }
            });
        if spawn.is_err() {
            stop_active(&self.inner, &turn_id, STOP_DISPOSE);
            return Err(AgentError::Failed(
                "could not start the Grok turn worker".into(),
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
        let _ = start.send(());
        Ok(turn_id)
    }

    fn interrupt_inner(&self, thread_id: &str) -> AgentResult<()> {
        self.require_thread(thread_id)?;
        let active = lock(&self.inner.state).active.clone();
        if let Some(active) = active {
            active.stop.store(STOP_INTERRUPT, Ordering::Release);
            lock(&active.child)
                .kill_tree()
                .map_err(|_| AgentError::Failed("could not stop Grok".into()))?;
        }
        Ok(())
    }

    fn dispose_inner(&self) {
        if self.inner.disposed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(active) = lock(&self.inner.state).active.clone() {
            active.stop.store(STOP_DISPOSE, Ordering::Release);
            let _ = lock(&active.child).kill_tree();
        }
    }

    fn require_thread(&self, thread_id: &str) -> AgentResult<()> {
        if self.inner.thread.id != thread_id {
            return Err(AgentError::Failed("no such Grok thread".into()));
        }
        Ok(())
    }
}

impl AgentSession for GrokSession {
    fn capabilities(&self) -> Capabilities {
        GROK_CAPABILITIES
    }

    fn send_turn(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        options: &TurnOptions,
    ) -> AgentResult<String> {
        self.send_turn_inner(thread_id, text, attachments, options)
    }

    fn interrupt(&self, thread_id: &str) -> AgentResult<()> {
        self.interrupt_inner(thread_id)
    }

    fn respond_to_approval(
        &self,
        _approval_id: &str,
        _decision: ApprovalDecision,
    ) -> AgentResult<bool> {
        Ok(false)
    }

    fn export_state(&self) -> AgentResult<Option<AgentSessionState>> {
        serde_json::to_value(self.snapshot())
            .map(AgentSessionState::new)
            .map(Some)
            .map_err(|_| AgentError::Failed("could not encode Grok session state".into()))
    }

    fn dispose(&self) {
        self.dispose_inner();
    }
}

impl Drop for GrokSession {
    fn drop(&mut self) {
        self.dispose_inner();
    }
}

fn run_turn(
    inner: Arc<SessionInner>,
    turn_id: String,
    child: Arc<Mutex<SpawnedChild>>,
    stop: Arc<AtomicU8>,
    stdout: impl Read + Send + 'static,
    stderr: impl Read + Send + 'static,
) {
    let stdout_inner = Arc::clone(&inner);
    let stdout_turn_id = turn_id.clone();
    let stdout_reader = thread::spawn(move || {
        let mut mapper = GrokEventMapper::new(&stdout_turn_id, &stdout_inner.thread.id);
        let mut terminal = None;
        let result = read_ndjson(stdout, DEFAULT_MAX_NDJSON_LINE, |frame| match frame {
            NdjsonFrame::Value(value) => {
                let translated = mapper.translate(&value, now_ms());
                if let Some(session_id) = translated.session_id {
                    lock(&stdout_inner.state).session_id = Some(session_id);
                }
                for event in translated.events {
                    stdout_inner.handlers.emit_event(event);
                }
                terminal = translated.terminal.or(terminal);
            }
            NdjsonFrame::Unparsable(line) => stdout_inner.handlers.emit_log(format!(
                "unparsable Grok stdout: {}",
                line.chars().take(200).collect::<String>()
            )),
            NdjsonFrame::Oversized { max_bytes } => stdout_inner
                .handlers
                .emit_log(format!("Grok stdout line exceeded {max_bytes} bytes")),
        });
        (result, terminal)
    });
    let stderr_handlers = inner.handlers.clone();
    let stderr_reader = thread::spawn(move || stream_stderr(stderr, &stderr_handlers));

    let status = loop {
        match lock(&child).try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(PROCESS_POLL_INTERVAL),
            Err(_) => break None,
        }
    };
    let (stdout_result, terminal) = stdout_reader.join().unwrap_or_else(|_| {
        (
            Err(std::io::Error::other("Grok stdout reader panicked")),
            None,
        )
    });
    let _ = stderr_reader.join();
    if stdout_result.is_err() {
        inner.handlers.emit_log("Grok stdout ended unexpectedly");
    }
    clear_active(&inner, &turn_id);

    let stop_reason = stop.load(Ordering::Acquire);
    if stop_reason == STOP_DISPOSE {
        return;
    }
    if let Some(status) = terminal {
        inner
            .handlers
            .emit_event(DomainEvent::TurnCompleted { turn_id, status });
        return;
    }
    if stop_reason == STOP_INTERRUPT {
        inner.handlers.emit_event(DomainEvent::TurnCompleted {
            turn_id,
            status: TurnStatus::Interrupted,
        });
        return;
    }
    let code = status
        .and_then(|status| status.code())
        .map_or_else(|| "unknown".into(), |code| code.to_string());
    inner.handlers.emit_event(DomainEvent::ThreadError {
        thread_id: inner.thread.id.clone(),
        message: format!("grok exited with code {code} before reporting a result"),
    });
    inner.handlers.emit_event(DomainEvent::TurnCompleted {
        turn_id,
        status: TurnStatus::Failed,
    });
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
                handlers.emit_log("Grok stderr ended unexpectedly");
                return;
            }
        }
    }
}

fn clear_active(inner: &SessionInner, turn_id: &str) {
    let mut state = lock(&inner.state);
    if state.active.as_ref().map(|active| active.id.as_str()) == Some(turn_id) {
        state.active = None;
        inner.state_changed.notify_all();
    }
}

fn stop_active(inner: &SessionInner, turn_id: &str, reason: u8) {
    let active = lock(&inner.state)
        .active
        .as_ref()
        .filter(|active| active.id == turn_id)
        .cloned();
    if let Some(active) = active {
        active.stop.store(reason, Ordering::Release);
        let _ = lock(&active.child).kill_tree();
        clear_active(inner, turn_id);
    }
}

pub(crate) fn grok_prompt(text: &str, instructions: Option<&str>) -> String {
    instructions.map_or_else(
        || text.into(),
        |instructions| {
            format!("<system-instructions>\n{instructions}\n</system-instructions>\n\n{text}")
        },
    )
}

pub(crate) fn grok_turn_args(
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    approval: Option<ApprovalMode>,
    session_id: Option<&str>,
) -> AgentResult<Vec<OsString>> {
    validate_approval(approval)?;
    let mut args = vec![
        OsString::from("-p"),
        OsString::from(prompt),
        OsString::from("--output-format"),
        OsString::from("streaming-json"),
    ];
    if let Some(model) = model {
        args.extend([OsString::from("--model"), OsString::from(model)]);
    }
    if let Some(effort) = effort {
        args.extend([OsString::from("--reasoning-effort"), OsString::from(effort)]);
    }
    match approval {
        Some(ApprovalMode::Auto) => args.extend([
            OsString::from("--permission-mode"),
            OsString::from("acceptEdits"),
        ]),
        Some(ApprovalMode::Full) => args.extend([
            OsString::from("--permission-mode"),
            OsString::from("bypassPermissions"),
        ]),
        _ => {}
    }
    if let Some(session_id) = session_id {
        args.extend([OsString::from("-r"), OsString::from(session_id)]);
    }
    Ok(args)
}

fn apply_turn_options(
    model: &mut Option<String>,
    effort: &mut Option<String>,
    options: &TurnOptions,
) {
    if let Some(next_model) = &options.model {
        *model = Some(next_model.clone());
        *effort = options.effort.clone();
    } else if options.effort.is_some() {
        *effort = options.effort.clone();
    }
}

fn validate_state(state: &GrokSessionState) -> AgentResult<()> {
    if state.version != SESSION_STATE_VERSION {
        return Err(AgentError::Failed(
            "Grok session state version is unsupported".into(),
        ));
    }
    if state.thread.provider != ProviderId::Grok || state.thread.connection_id.is_some() {
        return Err(AgentError::Failed(
            "only Grok threads can resume here".into(),
        ));
    }
    if state.session_id.as_deref() == Some("") {
        return Err(AgentError::Failed("Grok session id is invalid".into()));
    }
    validate_approval(state.approval)
}

fn validate_approval(approval: Option<ApprovalMode>) -> AgentResult<()> {
    if approval == Some(ApprovalMode::AutoReview) {
        return Err(AgentError::Failed(
            "Grok does not support automatic approval review".into(),
        ));
    }
    Ok(())
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
    use crate::GrokRuntime;
    use harness_agent::AgentRuntime as _;
    use harness_protocol::{ItemType, Usage};
    use std::ffi::OsStr;
    use std::io::Write as _;
    use std::sync::mpsc;

    const HELPER_MODE: &str = "HARNESS_GROK_ADAPTER_HELPER";
    const HELPER_ACTION: &str = "HARNESS_GROK_ADAPTER_ACTION";
    const WAIT: Duration = Duration::from_secs(3);

    #[test]
    fn keeps_multiline_prompts_and_maps_model_effort_permissions_and_resume() {
        let prompt = grok_prompt("Create hello.txt", Some("Answer plainly."));
        let args = grok_turn_args(
            &prompt,
            Some("grok-4.5"),
            Some("xhigh"),
            Some(ApprovalMode::Auto),
            Some("session-1"),
        )
        .unwrap();
        assert_eq!(args[0], OsStr::new("-p"));
        assert!(args[1].to_string_lossy().contains('\n'));
        for expected in ["grok-4.5", "xhigh", "acceptEdits", "session-1"] {
            assert!(args.iter().any(|arg| arg == OsStr::new(expected)));
        }
        assert!(args.windows(2).any(|pair| {
            pair[0] == OsStr::new("--reasoning-effort") && pair[1] == OsStr::new("xhigh")
        }));
        assert!(args.iter().all(|arg| arg != OsStr::new("--effort")));
        assert!(
            grok_turn_args("x", None, None, Some(ApprovalMode::Full), None)
                .unwrap()
                .iter()
                .any(|arg| arg == OsStr::new("bypassPermissions"))
        );
        assert!(
            grok_turn_args("x", None, None, Some(ApprovalMode::Ask), None)
                .unwrap()
                .iter()
                .all(|arg| arg != OsStr::new("--permission-mode"))
        );
    }

    #[test]
    fn per_turn_selection_persists_and_a_model_change_can_clear_effort() {
        let mut model = Some("grok-4.5".into());
        let mut effort = Some("high".into());
        apply_turn_options(&mut model, &mut effort, &TurnOptions::default());
        assert_eq!(model.as_deref(), Some("grok-4.5"));
        assert_eq!(effort.as_deref(), Some("high"));

        apply_turn_options(
            &mut model,
            &mut effort,
            &TurnOptions {
                model: Some("grok-future".into()),
                effort: None,
                ..TurnOptions::default()
            },
        );
        assert_eq!(model.as_deref(), Some("grok-future"));
        assert_eq!(effort, None);
    }

    #[test]
    fn drives_captured_stream_resume_state_and_interrupt_over_real_stdio() {
        let workspace = tempfile::tempdir().unwrap();
        let (event_tx, event_rx) = mpsc::channel();
        let runtime = test_runtime("stream");
        let (thread, session) = runtime
            .start(
                workspace.path().to_str().unwrap(),
                &StartOptions {
                    instructions: Some("Answer plainly.".into()),
                    model: Some("grok-4.5".into()),
                    effort: Some("xhigh".into()),
                    ..StartOptions::default()
                },
                AgentHandlers::new(
                    move |event| {
                        let _ = event_tx.send(event);
                    },
                    |_| {},
                ),
            )
            .unwrap();
        let turn = session
            .send_turn(
                &thread.id,
                "Create hello.txt",
                &[],
                &TurnOptions {
                    model: Some("grok-future".into()),
                    effort: None,
                    ..TurnOptions::default()
                },
            )
            .unwrap();
        let events = through_terminal(&event_rx, &turn);
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Message && item.text.as_deref() == Some("done")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            DomainEvent::UsageUpdated { usage: Usage { input_tokens, .. } }
                if *input_tokens == 22_116.0
        )));
        let saved = session.export_state().unwrap().unwrap();
        let state: GrokSessionState = serde_json::from_value(saved.value().clone()).unwrap();
        assert_eq!(
            state.session_id.as_deref(),
            Some("019fd9b0-1c9b-7dd3-85a2-2b7b628382d3")
        );
        assert_eq!(state.turn_counter, 1);
        assert_eq!(state.model.as_deref(), Some("grok-future"));
        assert_eq!(state.effort, None);
        session.dispose();

        let (event_tx, event_rx) = mpsc::channel();
        let blocking = test_runtime("block");
        let (blocking_thread, blocking_session) = blocking
            .start(
                workspace.path().to_str().unwrap(),
                &StartOptions::default(),
                AgentHandlers::new(
                    move |event| {
                        let _ = event_tx.send(event);
                    },
                    |_| {},
                ),
            )
            .unwrap();
        let turn = blocking_session
            .send_turn(&blocking_thread.id, "Wait", &[], &TurnOptions::default())
            .unwrap();
        blocking_session.interrupt(&blocking_thread.id).unwrap();
        assert!(matches!(
            wait_for_terminal(&event_rx, &turn),
            TurnStatus::Interrupted
        ));
        blocking_session.dispose();
    }

    #[test]
    fn rejects_auto_review_before_launching() {
        let workspace = tempfile::tempdir().unwrap();
        assert!(
            test_runtime("stream")
                .start(
                    workspace.path().to_str().unwrap(),
                    &StartOptions {
                        approval: Some(ApprovalMode::AutoReview),
                        ..StartOptions::default()
                    },
                    AgentHandlers::default(),
                )
                .is_err()
        );
    }

    #[test]
    fn grok_helper() {
        if std::env::var_os(HELPER_MODE).is_none() {
            return;
        }
        match std::env::var(HELPER_ACTION).unwrap().as_str() {
            "stream" => {
                print!("{}", include_str!("../fixtures/stream.jsonl"));
                std::io::stdout().flush().unwrap();
            }
            "block" => loop {
                thread::sleep(Duration::from_secs(1));
            },
            action => panic!("unknown Grok helper action: {action}"),
        }
    }

    fn test_runtime(action: &str) -> GrokRuntime {
        GrokRuntime::with_command(GrokCommand {
            program: std::env::current_exe().unwrap().into_os_string(),
            prefix_args: vec![
                "--exact".into(),
                "session::tests::grok_helper".into(),
                "--nocapture".into(),
            ],
            environment: vec![
                (HELPER_MODE.into(), "1".into()),
                (HELPER_ACTION.into(), action.into()),
            ],
            append_turn_args: false,
        })
    }

    fn through_terminal(receiver: &mpsc::Receiver<DomainEvent>, turn_id: &str) -> Vec<DomainEvent> {
        let mut events = Vec::new();
        loop {
            let event = receiver.recv_timeout(WAIT).unwrap();
            let terminal = matches!(
                &event,
                DomainEvent::TurnCompleted { turn_id: id, .. } if id == turn_id
            );
            events.push(event);
            if terminal {
                return events;
            }
        }
    }

    fn wait_for_terminal(receiver: &mpsc::Receiver<DomainEvent>, turn_id: &str) -> TurnStatus {
        loop {
            if let DomainEvent::TurnCompleted {
                turn_id: id,
                status,
            } = receiver.recv_timeout(WAIT).unwrap()
                && id == turn_id
            {
                return status;
            }
        }
    }
}
