use crate::CursorEventMapper;
use crate::models::{get_cursor_index, resolve_cursor_model};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentSession, AgentSessionState, StartOptions,
    TurnOptions,
};
use harness_proc::{
    DEFAULT_MAX_NDJSON_LINE, NdjsonFrame, SpawnOptions, SpawnedChild, read_ndjson, spawn_cli,
};
use harness_protocol::{
    ApprovalDecision, ApprovalMode, Capabilities, DomainEvent, ProviderId, Thread, Turn, TurnStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

pub const CURSOR_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    fork: false,
    interrupt: true,
    reasoning_items: false,
    approvals: false,
    user_input: None,
    auto_review: None,
    images: false,
};

#[derive(Clone, Debug)]
pub(crate) struct CursorCommand {
    pub(crate) program: OsString,
    pub(crate) prefix_args: Vec<OsString>,
    pub(crate) environment: Vec<(OsString, OsString)>,
    pub(crate) append_provider_args: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CursorSessionState {
    pub version: u32,
    pub thread: Thread,
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub service_tier: Option<String>,
    pub approval: Option<ApprovalMode>,
    pub instructions: Option<String>,
    pub instructions_pending: bool,
    pub session_id: Option<String>,
    pub turn_counter: u64,
}

pub struct CursorSession {
    inner: Arc<SessionInner>,
}

struct SessionInner {
    thread: Thread,
    workspace: PathBuf,
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<String>,
    approval: Option<ApprovalMode>,
    instructions: Option<String>,
    command: CursorCommand,
    handlers: AgentHandlers,
    state: Mutex<SessionState>,
    state_changed: Condvar,
    disposed: AtomicBool,
}

struct SessionState {
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

impl CursorSession {
    pub(crate) fn start(
        workspace_path: &str,
        options: &StartOptions,
        command: CursorCommand,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        validate_approval(options.approval)?;
        let thread = Thread {
            id: format!("cursor-{}", Uuid::new_v4()),
            provider: ProviderId::Cursor,
            connection_id: None,
            workspace_path: workspace_path.into(),
            title: None,
            created_at: now_ms(),
        };
        let session = Self::from_state(
            CursorSessionState {
                version: SESSION_STATE_VERSION,
                thread: thread.clone(),
                model: options.model.clone(),
                effort: options.effort.clone(),
                service_tier: options.service_tier.clone(),
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
        state: CursorSessionState,
        command: CursorCommand,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        if state.version != SESSION_STATE_VERSION {
            return Err(AgentError::Failed(
                "Cursor session state version is unsupported".into(),
            ));
        }
        if state.thread.provider != ProviderId::Cursor || state.thread.connection_id.is_some() {
            return Err(AgentError::Failed(
                "only Cursor threads can resume here".into(),
            ));
        }
        if state.session_id.as_deref() == Some("") {
            return Err(AgentError::Failed("Cursor session id is invalid".into()));
        }
        validate_approval(state.approval)?;
        let thread = state.thread.clone();
        Ok((
            thread,
            Arc::new(Self::from_state(state, command, handlers)?),
        ))
    }

    fn from_state(
        state: CursorSessionState,
        command: CursorCommand,
        handlers: AgentHandlers,
    ) -> AgentResult<Self> {
        let workspace = PathBuf::from(&state.thread.workspace_path);
        if !workspace.is_dir() {
            return Err(AgentError::Failed("Cursor workspace is unavailable".into()));
        }
        Ok(Self {
            inner: Arc::new(SessionInner {
                thread: state.thread,
                workspace,
                model: state.model,
                effort: state.effort,
                service_tier: state.service_tier,
                approval: state.approval,
                instructions: state.instructions,
                command,
                handlers,
                state: Mutex::new(SessionState {
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

    pub fn snapshot(&self) -> CursorSessionState {
        let state = lock(&self.inner.state);
        CursorSessionState {
            version: SESSION_STATE_VERSION,
            thread: self.inner.thread.clone(),
            model: self.inner.model.clone(),
            effort: self.inner.effort.clone(),
            service_tier: self.inner.service_tier.clone(),
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
                "Cursor CLI attachments are not supported".into(),
            ));
        }
        if self.inner.disposed.load(Ordering::Acquire) {
            return Err(AgentError::Failed("Cursor session is closed".into()));
        }

        let model = options.model.as_deref().or(self.inner.model.as_deref());
        let effort = options.effort.as_deref().or(self.inner.effort.as_deref());
        let service_tier = options
            .service_tier
            .as_deref()
            .or(self.inner.service_tier.as_deref());
        if model.is_some()
            && (effort.is_some() || service_tier.is_some())
            && get_cursor_index().is_none()
        {
            let _ = crate::runtime::list_cursor_models(&self.inner.command);
        }
        let index = get_cursor_index();
        let concrete_model =
            model.map(|model| resolve_cursor_model(index.as_ref(), model, effort, service_tier));

        let mut state = lock(&self.inner.state);
        if state.active.is_some() {
            return Err(AgentError::Failed(
                "a Cursor turn is already running".into(),
            ));
        }
        let next_counter = state.turn_counter.saturating_add(1);
        let turn_id = format!("{}-turn-{next_counter}", self.inner.thread.id);
        let prompt = cursor_prompt(
            text,
            state
                .instructions_pending
                .then_some(self.inner.instructions.as_deref())
                .flatten(),
        );
        let turn_args = cursor_turn_args(
            concrete_model.as_deref(),
            self.inner.approval,
            state.session_id.as_deref(),
            &prompt,
        )?;
        let mut args = self.inner.command.prefix_args.clone();
        if self.inner.command.append_provider_args {
            args.extend(turn_args);
        }
        let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
        let mut child = spawn_cli(
            self.inner.command.program.as_os_str(),
            &arg_refs,
            &SpawnOptions {
                cwd: Some(self.inner.workspace.clone()),
                environment: self.inner.command.environment.clone(),
                replace_environment: false,
            },
        )
        .map_err(|_| AgentError::Failed("Cursor Agent CLI could not start".into()))?;
        drop(child.take_stdin());
        let stdout = child
            .take_stdout()
            .ok_or_else(|| AgentError::Failed("Cursor stdout is unavailable".into()))?;
        let stderr = child
            .take_stderr()
            .ok_or_else(|| AgentError::Failed("Cursor stderr is unavailable".into()))?;
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
            .name("harness-cursor-turn".into())
            .spawn(move || {
                if run.recv().is_ok() {
                    run_turn(inner, worker_turn_id, child, stop, stdout, stderr);
                }
            });
        if spawn.is_err() {
            stop_active(&self.inner, &turn_id, STOP_DISPOSE);
            return Err(AgentError::Failed(
                "could not start the Cursor turn worker".into(),
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
                .map_err(|_| AgentError::Failed("could not stop Cursor".into()))?;
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
            return Err(AgentError::Failed("no such Cursor thread".into()));
        }
        Ok(())
    }
}

impl AgentSession for CursorSession {
    fn capabilities(&self) -> Capabilities {
        CURSOR_CAPABILITIES
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
            .map_err(|_| AgentError::Failed("could not encode Cursor session state".into()))
    }

    fn dispose(&self) {
        self.dispose_inner();
    }
}

impl Drop for CursorSession {
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
        let mut mapper = CursorEventMapper::new(&stdout_turn_id);
        let mut terminal = None;
        let result = read_ndjson(stdout, DEFAULT_MAX_NDJSON_LINE, |frame| {
            handle_stdout_frame(&stdout_inner, &mut mapper, &mut terminal, frame);
        });
        (result, mapper, terminal)
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
    let (stdout_result, mut mapper, terminal) = match stdout_reader.join() {
        Ok(result) => result,
        Err(_) => (
            Err(std::io::Error::other("Cursor stdout reader panicked")),
            CursorEventMapper::new(&turn_id),
            None,
        ),
    };
    let _ = stderr_reader.join();
    if stdout_result.is_err() {
        inner.handlers.emit_log("Cursor stdout ended unexpectedly");
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
    for event in mapper.finish(now_ms()) {
        inner.handlers.emit_event(event);
    }
    if stop_reason == STOP_INTERRUPT {
        inner.handlers.emit_event(DomainEvent::TurnCompleted {
            turn_id,
            status: TurnStatus::Interrupted,
        });
        return;
    }

    let message = match status.and_then(|status| status.code()) {
        Some(0) => "Cursor ended without a result".into(),
        Some(code) => format!("cursor-agent exited with code {code}"),
        None => "Cursor stopped unexpectedly".into(),
    };
    inner.handlers.emit_event(DomainEvent::ThreadError {
        thread_id: inner.thread.id.clone(),
        message,
    });
    inner.handlers.emit_event(DomainEvent::TurnCompleted {
        turn_id,
        status: TurnStatus::Failed,
    });
}

fn handle_stdout_frame(
    inner: &SessionInner,
    mapper: &mut CursorEventMapper,
    terminal: &mut Option<TurnStatus>,
    frame: NdjsonFrame,
) {
    let value = match frame {
        NdjsonFrame::Value(value) => value,
        NdjsonFrame::Unparsable(line) => {
            inner.handlers.emit_log(format!(
                "unparsable Cursor stdout: {}",
                line.chars().take(200).collect::<String>()
            ));
            return;
        }
        NdjsonFrame::Oversized { max_bytes } => {
            inner
                .handlers
                .emit_log(format!("Cursor stdout line exceeded {max_bytes} bytes"));
            return;
        }
    };

    if string(&value, "type") == Some("system") && string(&value, "subtype") == Some("init") {
        if let Some(session_id) = string(&value, "session_id").filter(|id| !id.is_empty()) {
            lock(&inner.state).session_id = Some(session_id.into());
        }
        return;
    }

    for event in mapper.translate(&value, now_ms()) {
        match event {
            DomainEvent::TurnCompleted { status, .. } => {
                if terminal.is_none() {
                    *terminal = Some(status);
                }
            }
            event => inner.handlers.emit_event(event),
        }
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
                handlers.emit_log("Cursor stderr ended unexpectedly");
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

pub(crate) fn cursor_prompt(text: &str, instructions: Option<&str>) -> String {
    instructions.map_or_else(
        || text.into(),
        |instructions| {
            format!("<system-instructions>\n{instructions}\n</system-instructions>\n\n{text}")
        },
    )
}

pub(crate) fn cursor_turn_args(
    model: Option<&str>,
    approval: Option<ApprovalMode>,
    session_id: Option<&str>,
    prompt: &str,
) -> AgentResult<Vec<OsString>> {
    validate_approval(approval)?;
    let mut args = vec![
        OsString::from("--print"),
        OsString::from("--output-format"),
        OsString::from("stream-json"),
    ];
    if matches!(approval, Some(ApprovalMode::Auto | ApprovalMode::Full)) {
        args.push(OsString::from("--force"));
    }
    if let Some(model) = model {
        args.extend([OsString::from("--model"), OsString::from(model)]);
    }
    if let Some(session_id) = session_id {
        args.extend([OsString::from("--resume"), OsString::from(session_id)]);
    }
    args.push(OsString::from(prompt));
    Ok(args)
}

fn validate_approval(approval: Option<ApprovalMode>) -> AgentResult<()> {
    if approval == Some(ApprovalMode::AutoReview) {
        return Err(AgentError::Failed(
            "Cursor CLI does not support automatic approval review".into(),
        ));
    }
    Ok(())
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
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
    use crate::CursorRuntime;
    use harness_agent::AgentRuntime as _;
    use harness_protocol::ItemType;
    use serde_json::json;
    use std::ffi::OsStr;
    use std::io::Write as _;
    use std::sync::mpsc;

    const HELPER_MODE: &str = "HARNESS_CURSOR_ADAPTER_HELPER";
    const HELPER_ACTION: &str = "HARNESS_CURSOR_ADAPTER_ACTION";
    const WAIT: Duration = Duration::from_secs(3);

    #[test]
    fn maps_prompts_force_modes_and_resume_arguments() {
        assert_eq!(
            cursor_prompt("Update README", Some("Answer plainly.")),
            "<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nUpdate README"
        );
        let args = cursor_turn_args(
            Some("composer-2.5"),
            Some(ApprovalMode::Ask),
            Some("session-1"),
            "Continue",
        )
        .unwrap();
        assert_eq!(args[0], OsStr::new("--print"));
        assert!(args.iter().any(|arg| arg == OsStr::new("composer-2.5")));
        assert!(args.iter().any(|arg| arg == OsStr::new("session-1")));
        assert_eq!(args.last().unwrap(), OsStr::new("Continue"));
        assert!(!args.iter().any(|arg| arg == OsStr::new("--force")));
        for approval in [ApprovalMode::Auto, ApprovalMode::Full] {
            assert!(
                cursor_turn_args(None, Some(approval), None, "go")
                    .unwrap()
                    .iter()
                    .any(|arg| arg == OsStr::new("--force"))
            );
        }
        assert!(cursor_turn_args(None, Some(ApprovalMode::AutoReview), None, "go").is_err());
    }

    #[test]
    fn drives_turns_and_resumes_the_provider_session_over_real_stdio() {
        let workspace = tempfile::tempdir().unwrap();
        let (event_tx, event_rx) = mpsc::channel();
        let (log_tx, log_rx) = mpsc::channel();
        let first_event_tx = event_tx.clone();
        let runtime = test_runtime("stream");
        let (thread, session) = runtime
            .start(
                workspace.path().to_str().unwrap(),
                &StartOptions {
                    instructions: Some("Answer plainly.".into()),
                    model: Some("composer-2.5".into()),
                    effort: Some("high".into()),
                    service_tier: Some("fast".into()),
                    approval: Some(ApprovalMode::Ask),
                    ..StartOptions::default()
                },
                AgentHandlers::new(
                    move |event| {
                        let _ = first_event_tx.send(event);
                    },
                    move |line| {
                        let _ = log_tx.send(line);
                    },
                ),
            )
            .unwrap();
        let initial: CursorSessionState =
            serde_json::from_value(session.export_state().unwrap().unwrap().into_value()).unwrap();
        assert!(initial.instructions_pending);
        assert_eq!(initial.turn_counter, 0);
        assert_eq!(initial.effort.as_deref(), Some("high"));
        assert_eq!(initial.service_tier.as_deref(), Some("fast"));

        let first = session
            .send_turn(&thread.id, "Update README", &[], &TurnOptions::default())
            .unwrap();
        let first_events = through_terminal(&event_rx, &first);
        assert!(first_events.iter().any(|event| matches!(
            event,
            DomainEvent::ItemCompleted { item }
                if item.item_type == ItemType::Message
                    && item.text.as_deref() == Some("Hello from Cursor.")
        )));
        let saved = session.export_state().unwrap().unwrap();
        let state: CursorSessionState = serde_json::from_value(saved.value().clone()).unwrap();
        assert_eq!(state.session_id.as_deref(), Some("cursor-session-1"));
        assert_eq!(state.turn_counter, 1);
        assert!(!state.instructions_pending);
        assert!(
            log_rx
                .try_iter()
                .any(|line| line.contains("unparsable Cursor stdout"))
        );

        session.dispose();
        let (resumed_thread, resumed) = runtime
            .resume(
                &thread.id,
                workspace.path().to_str().unwrap(),
                &StartOptions {
                    resume_state: Some(saved),
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
        assert_eq!(resumed_thread, thread);
        let second = resumed
            .send_turn(&thread.id, "Continue", &[], &TurnOptions::default())
            .unwrap();
        assert!(second.ends_with("-turn-2"));
        assert_eq!(wait_for_terminal(&event_rx, &second), TurnStatus::Completed);
        resumed.dispose();
    }

    #[test]
    fn interrupts_a_real_child_process_and_reports_the_terminal_state_once() {
        let workspace = tempfile::tempdir().unwrap();
        let (event_tx, event_rx) = mpsc::channel();
        let runtime = test_runtime("block");
        let (thread, session) = runtime
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
        let turn = session
            .send_turn(&thread.id, "Wait", &[], &TurnOptions::default())
            .unwrap();
        session.interrupt(&thread.id).unwrap();
        assert_eq!(wait_for_terminal(&event_rx, &turn), TurnStatus::Interrupted);
        session.dispose();
    }

    #[test]
    fn cursor_helper() {
        if std::env::var_os(HELPER_MODE).is_none() {
            return;
        }
        match std::env::var(HELPER_ACTION).unwrap().as_str() {
            "stream" => {
                println!("startup warning");
                println!(
                    "{}",
                    json!({
                        "type": "system",
                        "subtype": "init",
                        "session_id": "cursor-session-1"
                    })
                );
                println!(
                    "{}",
                    json!({
                        "type": "assistant",
                        "message": {
                            "content": [{ "type": "text", "text": "Hello from Cursor." }]
                        }
                    })
                );
                println!(
                    "{}",
                    json!({
                        "type": "result",
                        "subtype": "success",
                        "duration_ms": 10,
                        "is_error": false,
                        "result": "Hello from Cursor.",
                        "session_id": "cursor-session-1"
                    })
                );
                std::io::stdout().flush().unwrap();
            }
            "block" => {
                println!(
                    "{}",
                    json!({
                        "type": "system",
                        "subtype": "init",
                        "session_id": "cursor-session-1"
                    })
                );
                std::io::stdout().flush().unwrap();
                thread::sleep(Duration::from_secs(30));
            }
            action => panic!("unexpected helper action: {action}"),
        }
    }

    fn test_runtime(action: &str) -> CursorRuntime {
        let executable = std::env::current_exe().unwrap();
        CursorRuntime::with_command(CursorCommand {
            program: executable.into_os_string(),
            prefix_args: vec![
                OsString::from("--exact"),
                OsString::from("session::tests::cursor_helper"),
                OsString::from("--nocapture"),
            ],
            environment: vec![
                (OsString::from(HELPER_MODE), OsString::from("1")),
                (OsString::from(HELPER_ACTION), OsString::from(action)),
            ],
            append_provider_args: false,
        })
    }

    fn through_terminal(events: &mpsc::Receiver<DomainEvent>, turn_id: &str) -> Vec<DomainEvent> {
        let mut seen = Vec::new();
        loop {
            let event = events.recv_timeout(WAIT).unwrap();
            let terminal = matches!(
                &event,
                DomainEvent::TurnCompleted { turn_id: id, .. } if id == turn_id
            );
            seen.push(event);
            if terminal {
                return seen;
            }
        }
    }

    fn wait_for_terminal(events: &mpsc::Receiver<DomainEvent>, turn_id: &str) -> TurnStatus {
        loop {
            if let DomainEvent::TurnCompleted {
                turn_id: id,
                status,
            } = events.recv_timeout(WAIT).unwrap()
                && id == turn_id
            {
                return status;
            }
        }
    }
}
