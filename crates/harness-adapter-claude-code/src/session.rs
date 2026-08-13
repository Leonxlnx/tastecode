use crate::map_domain_events;
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
use serde_json::{Value, json};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SESSION_STATE_VERSION: u32 = 1;
const SUPPORTED_VERSION_PREFIX: &str = "2.1";
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const STOP_NONE: u8 = 0;
const STOP_INTERRUPT: u8 = 1;
const STOP_DISPOSE: u8 = 2;

pub const CLAUDE_CAPABILITIES: Capabilities = Capabilities {
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
pub(crate) struct ClaudeCommand {
    pub(crate) program: OsString,
    pub(crate) prefix_args: Vec<OsString>,
    pub(crate) environment: Vec<(OsString, OsString)>,
    pub(crate) append_turn_args: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClaudeSessionState {
    pub version: u32,
    pub thread: Thread,
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub approval: Option<ApprovalMode>,
    pub instructions: Option<String>,
    pub session_id: Option<String>,
    pub turn_counter: u64,
}

pub struct ClaudeCodeSession {
    inner: Arc<SessionInner>,
}

struct SessionInner {
    thread: Thread,
    workspace: PathBuf,
    approval: Option<ApprovalMode>,
    instructions: Option<String>,
    instructions_dir: Mutex<Option<PathBuf>>,
    instructions_file: Option<PathBuf>,
    command: ClaudeCommand,
    handlers: AgentHandlers,
    state: Mutex<SessionState>,
    state_changed: Condvar,
    disposed: AtomicBool,
}

struct SessionState {
    model: Option<String>,
    effort: Option<String>,
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

impl ClaudeCodeSession {
    pub(crate) fn start(
        workspace_path: &str,
        options: &StartOptions,
        command: ClaudeCommand,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        validate_approval(options.approval)?;
        let thread = Thread {
            id: format!("claude-{}", Uuid::new_v4()),
            provider: ProviderId::ClaudeCode,
            connection_id: None,
            workspace_path: workspace_path.into(),
            title: None,
            created_at: now_ms(),
        };
        let session = Self::from_state(
            ClaudeSessionState {
                version: SESSION_STATE_VERSION,
                thread: thread.clone(),
                model: options.model.clone(),
                effort: options.effort.clone(),
                approval: options.approval,
                instructions: options.instructions.clone(),
                session_id: None,
                turn_counter: 0,
            },
            command,
            handlers,
        )?;
        Ok((thread, Arc::new(session)))
    }

    pub(crate) fn resume(
        state: ClaudeSessionState,
        command: ClaudeCommand,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<Self>)> {
        if state.version != SESSION_STATE_VERSION {
            return Err(AgentError::Failed(
                "Claude Code session state version is unsupported".into(),
            ));
        }
        if state.thread.provider != ProviderId::ClaudeCode || state.thread.connection_id.is_some() {
            return Err(AgentError::Failed(
                "only Claude Code threads can resume here".into(),
            ));
        }
        validate_approval(state.approval)?;
        let thread = state.thread.clone();
        Ok((
            thread,
            Arc::new(Self::from_state(state, command, handlers)?),
        ))
    }

    fn from_state(
        state: ClaudeSessionState,
        command: ClaudeCommand,
        handlers: AgentHandlers,
    ) -> AgentResult<Self> {
        let workspace = PathBuf::from(&state.thread.workspace_path);
        if !workspace.is_dir() {
            return Err(AgentError::Failed(
                "Claude Code workspace is unavailable".into(),
            ));
        }
        let (instructions_dir, instructions_file) =
            prepare_instructions(state.instructions.as_deref(), &handlers);
        Ok(Self {
            inner: Arc::new(SessionInner {
                thread: state.thread,
                workspace,
                approval: state.approval,
                instructions: state.instructions,
                instructions_dir: Mutex::new(instructions_dir),
                instructions_file,
                command,
                handlers,
                state: Mutex::new(SessionState {
                    model: state.model,
                    effort: state.effort,
                    session_id: state.session_id,
                    turn_counter: state.turn_counter,
                    active: None,
                }),
                state_changed: Condvar::new(),
                disposed: AtomicBool::new(false),
            }),
        })
    }

    pub fn snapshot(&self) -> ClaudeSessionState {
        let state = lock(&self.inner.state);
        ClaudeSessionState {
            version: SESSION_STATE_VERSION,
            thread: self.inner.thread.clone(),
            model: state.model.clone(),
            effort: state.effort.clone(),
            approval: self.inner.approval,
            instructions: self.inner.instructions.clone(),
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
                "Claude Code CLI attachments are not supported".into(),
            ));
        }
        if self.inner.disposed.load(Ordering::Acquire) {
            return Err(AgentError::Failed("Claude Code session is closed".into()));
        }

        let mut state = lock(&self.inner.state);
        if state.active.is_some() {
            return Err(AgentError::Failed(
                "a Claude Code turn is already running".into(),
            ));
        }
        let SessionState { model, effort, .. } = &mut *state;
        apply_turn_options(model, effort, options);
        let next_counter = state.turn_counter.saturating_add(1);
        let turn_id = format!("{}-turn-{next_counter}", self.inner.thread.id);
        let turn_args = claude_turn_args(
            state.model.as_deref(),
            state.effort.as_deref(),
            self.inner.approval,
            state.session_id.as_deref(),
            self.inner.instructions_file.as_deref(),
        )?;
        let mut args = self.inner.command.prefix_args.clone();
        if self.inner.command.append_turn_args {
            args.extend(turn_args);
        }
        let arg_refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
        let spawn_options = SpawnOptions {
            cwd: Some(self.inner.workspace.clone()),
            environment: self.inner.command.environment.clone(),
            replace_environment: false,
        };
        let mut child = spawn_cli(
            self.inner.command.program.as_os_str(),
            &arg_refs,
            &spawn_options,
        )
        .map_err(|_| AgentError::Failed("Claude Code CLI could not start".into()))?;
        child
            .write_all(claude_user_message(text).as_bytes())
            .map_err(|_| AgentError::Failed("could not send the prompt to Claude Code".into()))?;
        drop(child.take_stdin());
        let stdout = child
            .take_stdout()
            .ok_or_else(|| AgentError::Failed("Claude Code stdout is unavailable".into()))?;
        let stderr = child
            .take_stderr()
            .ok_or_else(|| AgentError::Failed("Claude Code stderr is unavailable".into()))?;
        let child = Arc::new(Mutex::new(child));
        let stop = Arc::new(AtomicU8::new(STOP_NONE));
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
            .name("harness-claude-turn".into())
            .spawn(move || {
                if run.recv().is_ok() {
                    run_turn(inner, worker_turn_id, child, stop, stdout, stderr);
                }
            });
        if spawn.is_err() {
            stop_active(&self.inner, &turn_id, STOP_DISPOSE);
            return Err(AgentError::Failed(
                "could not start the Claude Code turn worker".into(),
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
                .map_err(|_| AgentError::Failed("could not stop Claude Code".into()))?;
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
        if let Some(directory) = lock(&self.inner.instructions_dir).take() {
            let _ = std::fs::remove_dir_all(directory);
        }
    }

    fn require_thread(&self, thread_id: &str) -> AgentResult<()> {
        if self.inner.thread.id != thread_id {
            return Err(AgentError::Failed("no such Claude Code thread".into()));
        }
        Ok(())
    }
}

impl AgentSession for ClaudeCodeSession {
    fn capabilities(&self) -> Capabilities {
        CLAUDE_CAPABILITIES
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
            .map_err(|_| AgentError::Failed("could not encode Claude Code session state".into()))
    }

    fn dispose(&self) {
        self.dispose_inner();
    }
}

impl Drop for ClaudeCodeSession {
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
    let terminal = Arc::new(Mutex::new(None::<TurnStatus>));
    let stdout_inner = Arc::clone(&inner);
    let stdout_turn_id = turn_id.clone();
    let stdout_terminal = Arc::clone(&terminal);
    let stdout_reader = thread::spawn(move || {
        read_ndjson(stdout, DEFAULT_MAX_NDJSON_LINE, |frame| {
            handle_stdout_frame(&stdout_inner, &stdout_turn_id, &stdout_terminal, frame);
        })
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
    let stdout_result = stdout_reader.join();
    let _ = stderr_reader.join();
    if !matches!(stdout_result, Ok(Ok(()))) {
        inner
            .handlers
            .emit_log("Claude Code stdout ended unexpectedly");
    }
    clear_active(&inner, &turn_id);

    let stop_reason = stop.load(Ordering::Acquire);
    if stop_reason == STOP_DISPOSE {
        return;
    }
    let result_status = *lock(&terminal);
    if let Some(status) = result_status {
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

    let message = match status.and_then(|status| status.code()) {
        Some(0) => "Claude Code ended without a result".into(),
        Some(code) => format!("claude exited with code {code}"),
        None => "Claude Code stopped unexpectedly".into(),
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
    inner: &Arc<SessionInner>,
    turn_id: &str,
    terminal: &Arc<Mutex<Option<TurnStatus>>>,
    frame: NdjsonFrame,
) {
    let value = match frame {
        NdjsonFrame::Value(value) => value,
        NdjsonFrame::Unparsable(line) => {
            inner.handlers.emit_log(format!(
                "unparsable Claude Code stdout: {}",
                line.chars().take(200).collect::<String>()
            ));
            return;
        }
        NdjsonFrame::Oversized { max_bytes } => {
            inner.handlers.emit_log(format!(
                "Claude Code stdout line exceeded {max_bytes} bytes"
            ));
            return;
        }
    };

    if string(&value, "type") == Some("system") && string(&value, "subtype") == Some("init") {
        if let Some(session_id) = string(&value, "session_id") {
            lock(&inner.state).session_id = Some(session_id.into());
        }
        if let Some(version) = string(&value, "claude_code_version")
            && !version.starts_with(SUPPORTED_VERSION_PREFIX)
        {
            inner.handlers.emit_log(format!(
                "claude-code {version} is newer than the {SUPPORTED_VERSION_PREFIX}.x this adapter was written against"
            ));
        }
        return;
    }
    if string(&value, "type") == Some("rate_limit_event") {
        let utilization = value
            .get("rate_limit_info")
            .and_then(|info| info.get("utilization"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if utilization > 0.9 {
            inner
                .handlers
                .emit_log(format!("rate limit at {:.0}%", utilization * 100.0));
        }
        return;
    }

    for event in map_domain_events(&value, turn_id, now_ms()) {
        match event {
            DomainEvent::TurnCompleted { status, .. } => {
                let mut terminal = lock(terminal);
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
                handlers.emit_log("Claude Code stderr ended unexpectedly");
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

pub(crate) fn claude_user_message(text: &str) -> String {
    format!(
        "{}\n",
        json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": text }]
            }
        })
    )
}

pub(crate) fn claude_turn_args(
    model: Option<&str>,
    effort: Option<&str>,
    approval: Option<ApprovalMode>,
    session_id: Option<&str>,
    instructions_file: Option<&Path>,
) -> AgentResult<Vec<OsString>> {
    validate_approval(approval)?;
    let permission = match approval {
        Some(ApprovalMode::Ask) => Some("default"),
        Some(ApprovalMode::Auto) => Some("acceptEdits"),
        Some(ApprovalMode::Full) => Some("bypassPermissions"),
        Some(ApprovalMode::AutoReview) => unreachable!("validated above"),
        None => None,
    };
    let mut args = vec![
        OsString::from("-p"),
        OsString::from("--output-format"),
        OsString::from("stream-json"),
        OsString::from("--verbose"),
        OsString::from("--input-format"),
        OsString::from("stream-json"),
    ];
    if let Some(model) = model {
        args.extend([OsString::from("--model"), OsString::from(model)]);
    }
    if let Some(effort) = effort {
        args.extend([OsString::from("--effort"), OsString::from(effort)]);
    }
    if let Some(permission) = permission {
        args.extend([
            OsString::from("--permission-mode"),
            OsString::from(permission),
        ]);
    }
    if let Some(file) = instructions_file {
        args.extend([
            OsString::from("--append-system-prompt-file"),
            file.as_os_str().to_owned(),
        ]);
    }
    if let Some(session_id) = session_id {
        args.extend([OsString::from("--resume"), OsString::from(session_id)]);
    }
    if args.iter().any(|arg| {
        arg.to_string_lossy()
            .chars()
            .any(|character| character == '\r' || character == '\n')
    }) {
        return Err(AgentError::Failed(
            "Claude Code arguments cannot contain newlines".into(),
        ));
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

fn prepare_instructions(
    instructions: Option<&str>,
    handlers: &AgentHandlers,
) -> (Option<PathBuf>, Option<PathBuf>) {
    let Some(instructions) = instructions.filter(|instructions| !instructions.is_empty()) else {
        return (None, None);
    };
    let directory = std::env::temp_dir().join(format!("harness-claude-{}", Uuid::new_v4()));
    let file = directory.join("system-prompt.md");
    let result = std::fs::create_dir(&directory)
        .and_then(|()| std::fs::write(&file, instructions.as_bytes()));
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&directory);
        handlers.emit_log("Claude Code session instructions were dropped");
        (None, None)
    } else {
        (Some(directory), Some(file))
    }
}

fn validate_approval(approval: Option<ApprovalMode>) -> AgentResult<()> {
    if approval == Some(ApprovalMode::AutoReview) {
        return Err(AgentError::Failed(
            "Claude Code does not support automatic approval review".into(),
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
    use crate::ClaudeCodeRuntime;
    use harness_agent::AgentRuntime as _;
    use std::ffi::OsStr;
    use std::io::Write as _;
    use std::sync::mpsc;

    const HELPER_MODE: &str = "HARNESS_CLAUDE_ADAPTER_HELPER";
    const WAIT: Duration = Duration::from_secs(3);

    #[test]
    fn keeps_multiline_prompts_off_argv_and_maps_permission_modes() {
        let directory = tempfile::tempdir().unwrap();
        let instructions = directory.path().join("system-prompt.md");
        let args = claude_turn_args(
            Some("haiku"),
            Some("xhigh"),
            Some(ApprovalMode::Ask),
            Some("session-1"),
            Some(&instructions),
        )
        .unwrap();
        assert!(args.iter().all(|arg| !arg.to_string_lossy().contains('\n')));
        assert_eq!(args[args.len() - 2], OsStr::new("--resume"));
        assert_eq!(args[args.len() - 1], OsStr::new("session-1"));
        assert!(args.iter().any(|arg| arg == OsStr::new("default")));
        assert!(
            args.windows(2).any(|pair| {
                pair[0] == OsStr::new("--effort") && pair[1] == OsStr::new("xhigh")
            })
        );
        assert!(
            claude_turn_args(None, None, Some(ApprovalMode::Auto), None, None)
                .unwrap()
                .iter()
                .any(|arg| arg == OsStr::new("acceptEdits"))
        );
        assert!(
            claude_turn_args(None, None, Some(ApprovalMode::Full), None, None)
                .unwrap()
                .iter()
                .any(|arg| arg == OsStr::new("bypassPermissions"))
        );

        let prompt = claude_user_message("first line\nsecond line");
        let decoded: Value = serde_json::from_str(prompt.trim()).unwrap();
        assert_eq!(
            decoded["message"]["content"][0]["text"],
            "first line\nsecond line"
        );
        assert!(claude_turn_args(None, None, Some(ApprovalMode::AutoReview), None, None).is_err());
    }

    #[test]
    fn per_turn_selection_persists_and_a_model_change_can_clear_effort() {
        let mut model = Some("opus".into());
        let mut effort = Some("xhigh".into());
        apply_turn_options(&mut model, &mut effort, &TurnOptions::default());
        assert_eq!(model.as_deref(), Some("opus"));
        assert_eq!(effort.as_deref(), Some("xhigh"));

        apply_turn_options(
            &mut model,
            &mut effort,
            &TurnOptions {
                model: Some("haiku".into()),
                effort: None,
                ..TurnOptions::default()
            },
        );
        assert_eq!(model.as_deref(), Some("haiku"));
        assert_eq!(effort, None);
    }

    #[test]
    fn drives_turns_resume_state_and_interrupt_over_real_stdio() {
        let workspace = tempfile::tempdir().unwrap();
        let (event_tx, event_rx) = mpsc::channel();
        let (log_tx, log_rx) = mpsc::channel();
        let first_event_tx = event_tx.clone();
        let handlers = AgentHandlers::new(
            move |event| {
                let _ = first_event_tx.send(event);
            },
            move |line| {
                let _ = log_tx.send(line);
            },
        );
        let runtime = test_runtime();
        let (thread, session) = runtime
            .start(
                workspace.path().to_str().unwrap(),
                &StartOptions {
                    instructions: Some("Answer plainly.\n- Keep context.".into()),
                    model: Some("haiku".into()),
                    effort: Some("high".into()),
                    approval: Some(ApprovalMode::Ask),
                    ..StartOptions::default()
                },
                handlers,
            )
            .unwrap();
        let initial: ClaudeSessionState =
            serde_json::from_value(session.export_state().unwrap().unwrap().into_value()).unwrap();
        assert_eq!(initial.turn_counter, 0);
        assert_eq!(initial.session_id, None);
        assert_eq!(initial.effort.as_deref(), Some("high"));

        let first = session
            .send_turn(
                &thread.id,
                "first line\nsecond line",
                &[],
                &TurnOptions {
                    model: Some("sonnet".into()),
                    effort: Some("xhigh".into()),
                    ..TurnOptions::default()
                },
            )
            .unwrap();
        let first_events = through_terminal(&event_rx, &first);
        assert!(first_events.iter().any(|event| {
            matches!(
                event,
                DomainEvent::ItemCompleted { item }
                    if item.item_type == harness_protocol::ItemType::Message
                        && item.text.as_deref() == Some("Hello from Claude.")
            )
        }));
        let saved = session.export_state().unwrap().unwrap();
        let state: ClaudeSessionState = serde_json::from_value(saved.value().clone()).unwrap();
        assert_eq!(state.session_id.as_deref(), Some("claude-session-1"));
        assert_eq!(state.turn_counter, 1);
        assert_eq!(state.model.as_deref(), Some("sonnet"));
        assert_eq!(state.effort.as_deref(), Some("xhigh"));

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
            .send_turn(&thread.id, "again", &[], &TurnOptions::default())
            .unwrap();
        assert!(second.ends_with("-turn-2"));
        resumed.interrupt(&thread.id).unwrap();
        assert!(matches!(
            wait_for_terminal(&event_rx, &second),
            TurnStatus::Interrupted
        ));
        resumed.dispose();
        assert!(
            log_rx
                .try_iter()
                .any(|line| line.contains("unparsable Claude Code stdout"))
        );
    }

    #[test]
    fn claude_helper() {
        if std::env::var_os(HELPER_MODE).is_none() {
            return;
        }
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).unwrap();
        let prompt: Value = serde_json::from_str(input.trim()).unwrap();
        let text = prompt["message"]["content"][0]["text"].as_str().unwrap();
        if text == "again" {
            println!(
                "{}",
                json!({
                    "type": "system",
                    "subtype": "init",
                    "session_id": "claude-session-1",
                    "claude_code_version": "2.1.220"
                })
            );
            std::io::stdout().flush().unwrap();
            thread::sleep(Duration::from_secs(30));
            return;
        }
        assert_eq!(text, "first line\nsecond line");
        println!("startup warning");
        println!(
            "{}",
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "claude-session-1",
                "claude_code_version": "2.1.220"
            })
        );
        println!(
            "{}",
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg-1",
                    "content": [{ "type": "text", "text": "Hello from Claude." }]
                }
            })
        );
        println!(
            "{}",
            json!({
                "type": "result",
                "is_error": false,
                "usage": { "input_tokens": 2, "output_tokens": 3 },
                "total_cost_usd": 0.01
            })
        );
        std::io::stdout().flush().unwrap();
    }

    fn test_runtime() -> ClaudeCodeRuntime {
        let executable = std::env::current_exe().unwrap();
        ClaudeCodeRuntime::with_command(ClaudeCommand {
            program: executable.into_os_string(),
            prefix_args: vec![
                OsString::from("--exact"),
                OsString::from("session::tests::claude_helper"),
                OsString::from("--nocapture"),
            ],
            environment: vec![(OsString::from(HELPER_MODE), OsString::from("1"))],
            append_turn_args: false,
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
