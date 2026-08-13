use harness_protocol::{
    Account, ApprovalDecision, ApprovalMode, AuthStartLoginResult, Capabilities, DomainEvent,
    McpListResult, McpOAuthStartResult, McpServerConfig, Model, SkillsListResult, Thread,
    VoiceStatusResult, VoiceTranscribeParams,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use thiserror::Error;

type EventHandler = dyn Fn(DomainEvent) + Send + Sync;
type LogHandler = dyn Fn(String) + Send + Sync;
type LoginHandler = dyn Fn(LoginEvent) + Send + Sync;
type McpOAuthHandler = dyn Fn(McpOAuthEvent) + Send + Sync;
type McpChangedHandler = dyn Fn(Option<String>) + Send + Sync;
type ChangedHandler = dyn Fn() + Send + Sync;

/// Provider-neutral callbacks installed before an agent process is started.
/// Events can arrive during initialization, so attaching them afterwards has
/// an unavoidable race.
#[derive(Clone)]
pub struct AgentHandlers {
    event: Arc<EventHandler>,
    log: Arc<LogHandler>,
    control: ControlHandlers,
}

impl AgentHandlers {
    pub fn new(
        event: impl Fn(DomainEvent) + Send + Sync + 'static,
        log: impl Fn(String) + Send + Sync + 'static,
    ) -> Self {
        Self {
            event: Arc::new(event),
            log: Arc::new(log),
            control: ControlHandlers::default(),
        }
    }

    pub fn with_control_handlers(mut self, control: ControlHandlers) -> Self {
        self.control = control;
        self
    }

    pub fn emit_event(&self, event: DomainEvent) {
        (self.event)(event);
    }

    pub fn emit_log(&self, line: impl Into<String>) {
        (self.log)(line.into());
    }

    pub fn emit_login(&self, event: LoginEvent) {
        self.control.emit_login(event);
    }

    pub fn emit_mcp_o_auth(&self, event: McpOAuthEvent) {
        self.control.emit_mcp_o_auth(event);
    }

    pub fn emit_mcp_changed(&self, thread_id: Option<String>) {
        self.control.emit_mcp_changed(thread_id);
    }

    pub fn emit_skills_changed(&self) {
        self.control.emit_skills_changed();
    }
}

impl Default for AgentHandlers {
    fn default() -> Self {
        Self::new(|_| {}, |_| {})
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginEvent {
    pub login_id: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpOAuthEvent {
    pub server_id: String,
    pub login_id: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct ControlHandlers {
    login: Arc<LoginHandler>,
    mcp_o_auth: Arc<McpOAuthHandler>,
    mcp_changed: Arc<McpChangedHandler>,
    skills_changed: Arc<ChangedHandler>,
    log: Arc<LogHandler>,
}

impl ControlHandlers {
    pub fn new(
        login: impl Fn(LoginEvent) + Send + Sync + 'static,
        log: impl Fn(String) + Send + Sync + 'static,
    ) -> Self {
        Self {
            login: Arc::new(login),
            mcp_o_auth: Arc::new(|_| {}),
            mcp_changed: Arc::new(|_| {}),
            skills_changed: Arc::new(|| {}),
            log: Arc::new(log),
        }
    }

    pub fn with_mcp_o_auth(
        mut self,
        handler: impl Fn(McpOAuthEvent) + Send + Sync + 'static,
    ) -> Self {
        self.mcp_o_auth = Arc::new(handler);
        self
    }

    pub fn with_mcp_changed(
        mut self,
        handler: impl Fn(Option<String>) + Send + Sync + 'static,
    ) -> Self {
        self.mcp_changed = Arc::new(handler);
        self
    }

    pub fn with_skills_changed(mut self, handler: impl Fn() + Send + Sync + 'static) -> Self {
        self.skills_changed = Arc::new(handler);
        self
    }

    pub fn emit_login(&self, event: LoginEvent) {
        (self.login)(event);
    }

    pub fn emit_mcp_o_auth(&self, event: McpOAuthEvent) {
        (self.mcp_o_auth)(event);
    }

    pub fn emit_mcp_changed(&self, thread_id: Option<String>) {
        (self.mcp_changed)(thread_id);
    }

    pub fn emit_skills_changed(&self) {
        (self.skills_changed)();
    }

    pub fn emit_log(&self, line: impl Into<String>) {
        (self.log)(line.into());
    }
}

impl Default for ControlHandlers {
    fn default() -> Self {
        Self::new(|_| {}, |_| {})
    }
}

#[derive(Clone, Default, PartialEq, Eq)]
pub struct CredentialValues(HashMap<String, String>);

impl CredentialValues {
    pub fn new(values: HashMap<String, String>) -> Self {
        Self(values)
    }

    pub fn get(&self, reference: &str) -> Option<&str> {
        self.0.get(reference).map(String::as_str)
    }

    pub fn insert(&mut self, reference: String, value: String) {
        self.0.insert(reference, value);
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Clone, Default, PartialEq, Eq)]
pub struct AgentSessionState(Value);

impl AgentSessionState {
    pub fn new(value: Value) -> Self {
        Self(value)
    }

    pub fn value(&self) -> &Value {
        &self.0
    }

    pub fn into_value(self) -> Value {
        self.0
    }
}

impl std::fmt::Debug for AgentSessionState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AgentSessionState([redacted])")
    }
}

impl std::fmt::Debug for CredentialValues {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "CredentialValues([redacted; {}])", self.0.len())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StartOptions {
    pub instructions: Option<String>,
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub effort: Option<String>,
    pub approval: Option<ApprovalMode>,
    pub mcp_servers: Vec<McpServerConfig>,
    pub mcp_credentials: CredentialValues,
    pub resume_state: Option<AgentSessionState>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnOptions {
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AgentError {
    #[error("{0}")]
    Failed(String),
    #[error("this agent does not support {0}")]
    Unsupported(&'static str),
}

pub type AgentResult<T> = Result<T, AgentError>;

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// One live provider session. Shared orchestration reads declared capabilities
/// and drives this interface; vendor wire details stay in adapter crates.
pub trait AgentSession: Send + Sync {
    fn capabilities(&self) -> Capabilities;

    fn send_turn(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        options: &TurnOptions,
    ) -> AgentResult<String>;

    fn steer(&self, _thread_id: &str, _text: &str, _attachments: &[String]) -> AgentResult<()> {
        Err(AgentError::Unsupported("steering"))
    }

    fn interrupt(&self, thread_id: &str) -> AgentResult<()>;

    fn respond_to_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> AgentResult<bool>;

    fn respond_to_user_input(
        &self,
        _request_id: &str,
        _answers: &HashMap<String, Vec<String>>,
    ) -> AgentResult<bool> {
        Err(AgentError::Unsupported("structured input"))
    }

    fn export_state(&self) -> AgentResult<Option<AgentSessionState>> {
        Ok(None)
    }

    fn list_mcp_servers(&self, _thread_id: &str) -> AgentResult<McpListResult> {
        Err(AgentError::Unsupported("MCP inventory"))
    }

    fn reload_mcp_servers(
        &self,
        _thread_id: &str,
        _servers: &[McpServerConfig],
        _credentials: &CredentialValues,
    ) -> AgentResult<()> {
        Err(AgentError::Unsupported("MCP reload"))
    }

    fn start_mcp_o_auth(
        &self,
        _server_id: &str,
        _thread_id: &str,
    ) -> AgentResult<McpOAuthStartResult> {
        Err(AgentError::Unsupported("MCP OAuth"))
    }

    fn dispose(&self);
}

/// Long-lived provider control channel for account and sign-in operations.
/// OAuth completion is delivered on the same process that started it, so this
/// object intentionally outlives any one request.
pub trait ProviderControl: Send + Sync {
    fn account(&self) -> AgentResult<Account>;
    fn start_login(&self) -> AgentResult<AuthStartLoginResult>;
    fn cancel_login(&self, login_id: &str) -> AgentResult<()>;
    fn use_api_key(&self, api_key: &str) -> AgentResult<Account>;
    fn sign_out(&self) -> AgentResult<()>;
    fn list_models(&self) -> AgentResult<Vec<Model>>;
    fn list_mcp_servers(&self) -> AgentResult<McpListResult> {
        Err(AgentError::Unsupported("MCP inventory"))
    }
    fn list_skills(&self, _project_path: &str) -> AgentResult<SkillsListResult> {
        Err(AgentError::Unsupported("skills inventory"))
    }
    fn set_skill_enabled(&self, _skill_id: &str, _enabled: bool) -> AgentResult<bool> {
        Err(AgentError::Unsupported("skill configuration"))
    }
    fn voice_status(&self) -> AgentResult<VoiceStatusResult> {
        Err(AgentError::Unsupported("voice transcription"))
    }
    fn transcribe_voice(
        &self,
        _input: &VoiceTranscribeParams,
        _cancellation: &CancellationToken,
    ) -> AgentResult<String> {
        Err(AgentError::Unsupported("voice transcription"))
    }
    fn dispose(&self);
}

/// Provider construction is separate from session orchestration, making the
/// shared lifecycle testable without spawning vendor binaries.
pub trait AgentRuntime: Send + Sync {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)>;

    fn resume(
        &self,
        _thread_id: &str,
        _workspace_path: &str,
        _options: &StartOptions,
        _handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        Err(AgentError::Unsupported("session resume"))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>>;

    fn open_control(&self, _handlers: ControlHandlers) -> AgentResult<Arc<dyn ProviderControl>> {
        Err(AgentError::Unsupported("account control"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_protocol::{Item, ItemStatus, ItemType};
    use std::sync::mpsc;

    #[test]
    fn handlers_are_cloneable_and_preserve_event_order() {
        let (sender, receiver) = mpsc::channel();
        let handlers = AgentHandlers::new(
            move |event| {
                let _ = sender.send(event);
            },
            |_| {},
        );
        let cloned = handlers.clone();
        handlers.emit_event(DomainEvent::ItemStarted {
            item: item("first"),
        });
        cloned.emit_event(DomainEvent::ItemCompleted {
            item: item("second"),
        });
        assert!(matches!(
            receiver.recv().unwrap(),
            DomainEvent::ItemStarted { item } if item.id == "first"
        ));
        assert!(matches!(
            receiver.recv().unwrap(),
            DomainEvent::ItemCompleted { item } if item.id == "second"
        ));
    }

    #[test]
    fn credential_values_never_expose_secrets_in_debug_output() {
        let mut credentials = CredentialValues::default();
        credentials.insert("token".into(), "super-secret".into());

        let debug = format!("{credentials:?}");
        assert_eq!(debug, "CredentialValues([redacted; 1])");
        assert!(!debug.contains("super-secret"));
    }

    #[test]
    fn provider_session_state_never_exposes_contents_in_debug_output() {
        let state = AgentSessionState::new(serde_json::json!({
            "messages": [{ "content": "private conversation" }],
            "token": "super-secret"
        }));

        let debug = format!("{state:?}");
        assert_eq!(debug, "AgentSessionState([redacted])");
        assert!(!debug.contains("private conversation"));
        assert!(!debug.contains("super-secret"));
    }

    fn item(id: &str) -> Item {
        Item {
            id: id.into(),
            turn_id: "turn-1".into(),
            item_type: ItemType::Unknown,
            status: ItemStatus::Started,
            role: None,
            text: None,
            command: None,
            exit_code: None,
            duration_ms: None,
            path: None,
            lines_added: None,
            lines_removed: None,
            created_at: 0.0,
        }
    }
}
