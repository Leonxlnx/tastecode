use async_channel::Receiver as EventReceiver;
use harness_client::{ClientEvent, ClientHandle, ConnectionState, Endpoint};
use harness_protocol::{
    Account, AcpAgent, AcpAgentsResult, ApprovalDecision, ApprovalMode, AuthEventPush,
    AuthStartLoginResult, CredentialConfiguredResult, DiffDecision, DomainEvent, ErrorCode,
    McpListResult, McpOAuthPush, McpOAuthStartResult, McpServer, McpServerConfig, Model,
    ModelConnection, ModelConnectionInput, ModelConnectionResult, ModelConnectionsResult,
    ModelsListResult, PROTOCOL_VERSION, PreviewCaptureRequest, PreviewCaptureResult,
    ProjectAddedResult, ProjectSummary, ProjectsListResult, ProviderId, ProviderStatus,
    ProvidersListResult, QueueDirection, Response, ReviewDiffResult, SendTurnResult, ServerWelcome,
    SessionDiff, SessionSearchPage, SessionSummary, SidebarMode, SidebarSettings,
    SkillEnabledResult, SkillInstalledResult, SkillsListResult, SystemInfo, TerminalExitPush,
    TerminalOpenedResult, TerminalOutputPush, ThreadChangedSinceResult, ThreadCheckpointsResult,
    ThreadEventPush, ThreadHistoryResult, ThreadInboxStatus, ThreadLifecycle, ThreadLifecyclePush,
    ThreadLifecycleResult, ThreadQueuePush, ThreadQueueResult, ThreadRestoreResult,
    ThreadStartResult, ThreadUnsavedWorkResult, UpdateCheckResult, UsageSummaryResult,
    VoiceStatusResult, VoiceTranscribeParams, VoiceTranscriptionResult, WorkspaceBranchesResult,
    WorkspaceInfo, channel, method,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) struct ClientState {
    client: Option<ClientHandle>,
    pub(crate) connection: ConnectionState,
    pub(crate) system_info: Option<SystemInfo>,
    pub(crate) update_check: Option<UpdateCheckResult>,
    pub(crate) update_checking: bool,
    pub(crate) voice_statuses: HashMap<ProviderId, VoiceStatusResult>,
    voice_status_pending: HashSet<ProviderId>,
    preview_capture_available: bool,
    pub(crate) projects: Vec<ProjectSummary>,
    pub(crate) projects_loaded: bool,
    pub(crate) sidebar_settings: SidebarSettings,
    pub(crate) provider_statuses: Vec<ProviderStatus>,
    pub(crate) model_connections: Vec<ModelConnection>,
    pub(crate) connection_busy: Option<String>,
    pub(crate) connection_error: Option<String>,
    pub(crate) accounts: HashMap<AuthTarget, Account>,
    pub(crate) auth_logins: HashMap<AuthTarget, AuthLoginSession>,
    pub(crate) auth_busy: Option<AuthTarget>,
    pub(crate) auth_error: Option<String>,
    early_auth_events: HashMap<String, AuthEventPush>,
    pub(crate) provider_terminal_busy: Option<AuthTarget>,
    pub(crate) acp_agents: Vec<AcpAgent>,
    pub(crate) model_catalog: Vec<ModelChoice>,
    pub(crate) model_catalog_loaded: bool,
    pending_provider_statuses: Vec<ProviderStatus>,
    pending_model_connections: Vec<ModelConnection>,
    pending_acp_agents: Vec<AcpAgent>,
    pending_model_catalog: Vec<ModelChoice>,
    catalog_refresh_failed: bool,
    completed_catalog_snapshot_pending: bool,
    pub(crate) mcp_inventory: Option<ScopedMcpInventory>,
    pub(crate) mcp_loading: bool,
    pub(crate) mcp_busy: Option<String>,
    pub(crate) mcp_error: Option<String>,
    pub(crate) mcp_notice: Option<String>,
    pub(crate) mcp_oauth: Option<McpOAuthSession>,
    early_mcp_oauth: HashMap<String, McpOAuthPush>,
    mcp_scope: Option<(ProviderId, String)>,
    mcp_generation: u64,
    pub(crate) skills_inventory: Option<ScopedSkillsInventory>,
    pub(crate) skills_loading: bool,
    pub(crate) skills_busy: Option<String>,
    pub(crate) skills_error: Option<String>,
    skills_scope: Option<(ProviderId, String)>,
    skills_generation: u64,
    settings_terminal_ids: HashSet<String>,
    early_terminal_output: PendingTerminalOutput,
    early_terminal_exits: HashMap<String, Option<i32>>,
    pending: HashMap<String, PendingRequest>,
    catalog_discovery_pending: usize,
    catalog_model_pending: usize,
    untouched_deletes_pending: usize,
    pub(crate) notice: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelChoice {
    pub(crate) key: String,
    pub(crate) provider: ProviderId,
    pub(crate) source_name: String,
    pub(crate) connection_id: Option<String>,
    pub(crate) agent_id: Option<String>,
    pub(crate) agent_name: Option<String>,
    pub(crate) model: Model,
    pub(crate) catalog_order: (u8, usize, usize),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ScopedMcpInventory {
    pub(crate) provider: ProviderId,
    pub(crate) project_path: String,
    pub(crate) result: McpListResult,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScopedSkillsInventory {
    pub(crate) provider: ProviderId,
    pub(crate) project_path: String,
    pub(crate) result: SkillsListResult,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpOAuthSession {
    pub(crate) provider: ProviderId,
    pub(crate) project_path: String,
    pub(crate) server_id: String,
    pub(crate) login_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct AuthTarget {
    pub(crate) provider: ProviderId,
    pub(crate) agent: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthLoginSession {
    pub(crate) login_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ProviderTerminalKind {
    Install,
    SignIn,
}

#[derive(Default)]
struct PendingTerminalOutput {
    by_terminal: HashMap<String, VecDeque<String>>,
    order: VecDeque<String>,
    bytes: usize,
}

const EARLY_TERMINAL_OUTPUT_LIMIT: usize = 512 * 1024;
const EARLY_TERMINAL_OUTPUT_PER_ID: usize = 128 * 1024;
const EARLY_TERMINAL_EXIT_LIMIT: usize = 64;

impl PendingTerminalOutput {
    fn push(&mut self, terminal_id: String, mut data: String) {
        if data.len() > EARLY_TERMINAL_OUTPUT_PER_ID {
            data = bounded_utf8_tail(data, EARLY_TERMINAL_OUTPUT_PER_ID);
        }
        if !self.by_terminal.contains_key(&terminal_id) {
            self.order.push_back(terminal_id.clone());
        }
        while self.bytes + data.len() > EARLY_TERMINAL_OUTPUT_LIMIT {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.remove(&oldest);
        }
        let chunks = self.by_terminal.entry(terminal_id).or_default();
        let mut terminal_bytes = chunks.iter().map(String::len).sum::<usize>();
        while terminal_bytes + data.len() > EARLY_TERMINAL_OUTPUT_PER_ID {
            let Some(removed) = chunks.pop_front() else {
                break;
            };
            terminal_bytes = terminal_bytes.saturating_sub(removed.len());
            self.bytes = self.bytes.saturating_sub(removed.len());
        }
        self.bytes += data.len();
        chunks.push_back(data);
    }

    fn take(&mut self, terminal_id: &str) -> Vec<String> {
        let chunks = self.by_terminal.remove(terminal_id).unwrap_or_default();
        self.order.retain(|id| id != terminal_id);
        self.bytes = self
            .bytes
            .saturating_sub(chunks.iter().map(String::len).sum::<usize>());
        chunks.into_iter().collect()
    }

    fn remove(&mut self, terminal_id: &str) {
        if let Some(chunks) = self.by_terminal.remove(terminal_id) {
            self.bytes = self
                .bytes
                .saturating_sub(chunks.iter().map(String::len).sum::<usize>());
        }
        self.order.retain(|id| id != terminal_id);
    }

    fn clear(&mut self) {
        self.by_terminal.clear();
        self.order.clear();
        self.bytes = 0;
    }
}

impl AuthTarget {
    pub(crate) fn provider(provider: ProviderId) -> Self {
        Self {
            provider,
            agent: None,
        }
    }

    pub(crate) fn agent(provider: ProviderId, agent: String) -> Self {
        Self {
            provider,
            agent: Some(agent),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProjectPush {
    provider: ProviderId,
    project_path: String,
}

#[derive(Clone)]
struct ModelSource {
    key: String,
    provider: ProviderId,
    source_name: String,
    connection_id: Option<String>,
    agent_id: Option<String>,
    agent_name: Option<String>,
    fallback_model: Option<Model>,
    catalog_group: u8,
    source_index: usize,
}

#[derive(Clone)]
pub(crate) struct NewThreadRequest {
    pub(crate) provisional_id: String,
    pub(crate) project_path: String,
    pub(crate) text: String,
    pub(crate) title: String,
    pub(crate) attachments: Vec<String>,
    pub(crate) choice: ModelChoice,
    pub(crate) effort: Option<String>,
    pub(crate) service_tier: Option<String>,
    pub(crate) approval: ApprovalMode,
    pub(crate) isolate: bool,
}

#[derive(Clone)]
pub(crate) struct SendTurnRequest {
    pub(crate) text: String,
    pub(crate) steer: bool,
    pub(crate) attachments: Vec<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) service_tier: Option<String>,
    pub(crate) steer_echo_after_row: Option<usize>,
    pub(crate) started_echo_after_row: Option<usize>,
}

pub(crate) struct ReviewHunkRequest {
    pub(crate) version: String,
    pub(crate) path: String,
    pub(crate) hunk_id: String,
    pub(crate) decision: DiffDecision,
}

pub(crate) struct SessionSearchRequest {
    pub(crate) query: String,
    pub(crate) project_path: Option<String>,
    pub(crate) provider: Option<ProviderId>,
    pub(crate) cursor: Option<String>,
    pub(crate) revision: u64,
    pub(crate) append: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum UsageScope {
    Thread(String),
    Provider(ProviderId),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceOperation {
    Info,
    Branches,
    Switch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RollbackOperation {
    Checkpoints,
    Inspect,
    Restore,
    Undo,
}

enum PendingRequest {
    Capabilities,
    PreviewCaptureResult,
    SystemInfo,
    UpdateCheck,
    VoiceStatus {
        provider: ProviderId,
    },
    VoiceTranscribe {
        request_id: String,
    },
    VoiceCancel,
    Projects,
    SidebarSettings,
    UpdateSidebarSettings,
    Providers,
    Connections,
    ConnectionUpsert {
        connection_id: String,
        api_key: String,
    },
    ConnectionCredential {
        connection_id: String,
    },
    ConnectionRemove {
        connection_id: String,
    },
    AuthStatus {
        target: AuthTarget,
    },
    AuthStart {
        target: AuthTarget,
    },
    AuthSignOut {
        target: AuthTarget,
    },
    ProviderTerminal {
        target: AuthTarget,
        kind: ProviderTerminalKind,
    },
    AcpAgents,
    Models {
        source: ModelSource,
    },
    McpList {
        provider: ProviderId,
        project_path: String,
        generation: u64,
    },
    McpMutation {
        provider: ProviderId,
        project_path: String,
        server_id: String,
        success_message: String,
    },
    McpReload {
        provider: ProviderId,
        project_path: String,
        success_message: String,
    },
    McpOAuthStart {
        provider: ProviderId,
        project_path: String,
        server_id: String,
    },
    McpOAuthCancel {
        provider: ProviderId,
        project_path: String,
        server_id: String,
    },
    SkillsList {
        provider: ProviderId,
        project_path: String,
        generation: u64,
    },
    SkillToggle {
        provider: ProviderId,
        project_path: String,
        skill_id: String,
    },
    SkillInstall {
        provider: ProviderId,
        project_path: String,
    },
    AddProject {
        path: String,
    },
    ProjectMutation {
        removed_path: Option<String>,
    },
    DeleteUntouched,
    SearchSessions {
        revision: u64,
        append: bool,
    },
    WorkspaceInfo {
        path: String,
        generation: u64,
    },
    WorkspaceBranches {
        path: String,
        generation: u64,
    },
    WorkspaceSwitch {
        path: String,
        branch: String,
        generation: u64,
    },
    Checkpoints {
        thread_id: String,
        generation: u64,
    },
    ChangedSince {
        thread_id: String,
        checkpoint_id: u64,
        generation: u64,
    },
    Restore {
        thread_id: String,
        checkpoint_id: u64,
        generation: u64,
    },
    UndoRestore {
        thread_id: String,
        generation: u64,
    },
    Usage {
        scope: UsageScope,
        generation: u64,
    },
    StartThread {
        request: NewThreadRequest,
    },
    RenameThread,
    ThreadSummaryMutation,
    ThreadLifecycle {
        thread_id: String,
        hide: bool,
    },
    ArchiveInspect {
        thread_id: String,
    },
    ArchiveClose {
        thread_id: String,
        force: bool,
    },
    ArchiveDiscard {
        thread_id: String,
    },
    ArchiveDelete {
        thread_id: String,
    },
    History {
        thread_id: String,
        replace: bool,
    },
    Queue {
        thread_id: String,
    },
    QueueMutation {
        thread_id: String,
    },
    SendTurn {
        thread_id: String,
        steer: bool,
        restore_text: String,
        restore_attachments: Vec<String>,
        optimistic_queue_id: Option<String>,
        steer_echo_after_row: Option<usize>,
        started_echo_after_row: Option<usize>,
    },
    Steer {
        thread_id: String,
        echo: Option<SteerEcho>,
    },
    Interrupt {
        thread_id: String,
    },
    RespondApproval {
        thread_id: String,
        approval_id: String,
    },
    RespondUserInput {
        thread_id: String,
        request_id: String,
    },
    Diff {
        thread_id: String,
    },
    ReviewHunk {
        thread_id: String,
    },
    TerminalOpen {
        thread_id: String,
    },
    TerminalInput {
        terminal_id: String,
    },
    TerminalResize {
        terminal_id: String,
    },
    TerminalClose {
        terminal_id: String,
    },
}

struct SteerEcho {
    text: String,
    created_at: f64,
    after_row: usize,
}

#[derive(Default)]
pub(crate) struct ClientUpdate {
    pub(crate) shell_changed: bool,
    pub(crate) chat: Vec<ChatUpdate>,
    pub(crate) shell_events: Vec<ShellEvent>,
}

pub(crate) enum ShellEvent {
    ProjectAdded {
        path: String,
    },
    ProjectRemoved {
        path: String,
    },
    ThreadHidden {
        thread_id: String,
    },
    ArchiveNeedsConfirmation {
        thread_id: String,
    },
    ArchiveFailed {
        thread_id: String,
    },
    ThreadArchived {
        thread_id: String,
    },
    ThreadStarted {
        thread_id: String,
        project_path: String,
        title: String,
        provider: ProviderId,
    },
    OpenUrl {
        url: String,
    },
    ProviderTerminalOpened {
        target: AuthTarget,
        kind: ProviderTerminalKind,
        terminal_id: String,
        buffered_output: Vec<String>,
        early_exit: Option<Option<i32>>,
    },
    ProviderTerminalOutput(TerminalOutputPush),
    ProviderTerminalExit(TerminalExitPush),
    ProviderTerminalError {
        target: Option<AuthTarget>,
        kind: Option<ProviderTerminalKind>,
        terminal_id: Option<String>,
        message: String,
    },
    ProviderTerminalClosed {
        terminal_id: String,
    },
    PreviewCaptureRequested(PreviewCaptureRequest),
    SessionSearchResults {
        revision: u64,
        append: bool,
        page: SessionSearchPage,
    },
    SessionSearchError {
        revision: u64,
        message: String,
    },
    WorkspaceInfo {
        path: String,
        generation: u64,
        info: WorkspaceInfo,
    },
    WorkspaceBranches {
        path: String,
        generation: u64,
        branches: Vec<String>,
    },
    WorkspaceSwitched {
        path: String,
        branch: String,
        generation: u64,
        info: WorkspaceInfo,
    },
    WorkspaceError {
        path: String,
        generation: u64,
        operation: WorkspaceOperation,
        message: String,
    },
    Checkpoints {
        thread_id: String,
        generation: u64,
        checkpoints: Vec<harness_protocol::CheckpointSummary>,
    },
    ChangedSince {
        thread_id: String,
        checkpoint_id: u64,
        generation: u64,
        files: Vec<String>,
    },
    CheckpointRestored {
        thread_id: String,
        checkpoint_id: u64,
        generation: u64,
        undo: String,
    },
    RestoreUndone {
        thread_id: String,
        generation: u64,
    },
    RollbackError {
        thread_id: String,
        generation: u64,
        operation: RollbackOperation,
        message: String,
    },
    UsageSummary {
        scope: UsageScope,
        generation: u64,
        summary: UsageSummaryResult,
    },
    UsageError {
        scope: UsageScope,
        generation: u64,
        message: String,
    },
}

pub(crate) enum ChatUpdate {
    History {
        thread_id: String,
        history: ThreadHistoryResult,
        replace: bool,
    },
    Queue {
        thread_id: String,
        queue: ThreadQueueResult,
    },
    QueueSubmissionResolved {
        thread_id: String,
        optimistic_queue_id: Option<String>,
        queued_turn: Option<harness_protocol::QueuedTurn>,
    },
    RunningSubmissionStarted {
        thread_id: String,
        turn_id: String,
        optimistic_queue_id: Option<String>,
        text: String,
        created_at: f64,
        echo_after_row: usize,
    },
    SteerAccepted {
        thread_id: String,
        text: String,
        created_at: f64,
        echo_after_row: usize,
    },
    Event(ThreadEventPush),
    Refresh,
    Error {
        thread_id: String,
        message: String,
    },
    DraftError {
        message: String,
        restore_text: String,
        restore_attachments: Vec<String>,
    },
    TurnError {
        thread_id: String,
        message: String,
        restore_text: String,
        restore_attachments: Vec<String>,
        optimistic_queue_id: Option<String>,
    },
    ApprovalError {
        thread_id: String,
        approval_id: String,
        message: String,
    },
    UserInputError {
        thread_id: String,
        request_id: String,
        message: String,
    },
    DiffSnapshot {
        thread_id: String,
        diff: SessionDiff,
    },
    DiffError {
        thread_id: String,
        message: String,
        stale: bool,
    },
    VoiceTranscribed {
        request_id: String,
        text: String,
    },
    VoiceTranscriptionError {
        request_id: String,
        message: String,
    },
    Connection(ConnectionState),
    TerminalOpened {
        thread_id: String,
        terminal_id: String,
    },
    TerminalOutput(TerminalOutputPush),
    TerminalExit(TerminalExitPush),
    TerminalOpenError {
        thread_id: String,
        message: String,
    },
    TerminalError {
        terminal_id: String,
        message: String,
    },
}

impl ClientUpdate {
    fn shell_changed() -> Self {
        Self {
            shell_changed: true,
            chat: Vec::new(),
            shell_events: Vec::new(),
        }
    }

    fn chat(update: ChatUpdate) -> Self {
        Self {
            shell_changed: false,
            chat: vec![update],
            shell_events: Vec::new(),
        }
    }

    fn shell_event(event: ShellEvent) -> Self {
        Self {
            shell_changed: true,
            chat: Vec::new(),
            shell_events: vec![event],
        }
    }
}

impl ClientState {
    pub(crate) fn new(fixture: bool) -> Self {
        Self {
            client: None,
            connection: if fixture {
                ConnectionState::Open
            } else {
                ConnectionState::Connecting
            },
            system_info: None,
            update_check: None,
            update_checking: false,
            voice_statuses: HashMap::new(),
            voice_status_pending: HashSet::new(),
            preview_capture_available: false,
            projects: Vec::new(),
            projects_loaded: fixture,
            sidebar_settings: SidebarSettings {
                mode: SidebarMode::Inbox,
                auto_settle_days: Some(3),
            },
            provider_statuses: Vec::new(),
            model_connections: Vec::new(),
            connection_busy: None,
            connection_error: None,
            accounts: HashMap::new(),
            auth_logins: HashMap::new(),
            auth_busy: None,
            auth_error: None,
            early_auth_events: HashMap::new(),
            provider_terminal_busy: None,
            acp_agents: Vec::new(),
            model_catalog: Vec::new(),
            model_catalog_loaded: fixture,
            pending_provider_statuses: Vec::new(),
            pending_model_connections: Vec::new(),
            pending_acp_agents: Vec::new(),
            pending_model_catalog: Vec::new(),
            catalog_refresh_failed: false,
            completed_catalog_snapshot_pending: false,
            mcp_inventory: None,
            mcp_loading: false,
            mcp_busy: None,
            mcp_error: None,
            mcp_notice: None,
            mcp_oauth: None,
            early_mcp_oauth: HashMap::new(),
            mcp_scope: None,
            mcp_generation: 0,
            skills_inventory: None,
            skills_loading: false,
            skills_busy: None,
            skills_error: None,
            skills_scope: None,
            skills_generation: 0,
            settings_terminal_ids: HashSet::new(),
            early_terminal_output: PendingTerminalOutput::default(),
            early_terminal_exits: HashMap::new(),
            pending: HashMap::new(),
            catalog_discovery_pending: 0,
            catalog_model_pending: 0,
            untouched_deletes_pending: 0,
            notice: None,
        }
    }

    pub(crate) fn connect(&mut self, endpoint: Endpoint) -> Option<EventReceiver<ClientEvent>> {
        match ClientHandle::start(endpoint) {
            Ok((client, events)) => {
                self.client = Some(client);
                Some(events)
            }
            Err(error) => {
                self.connection = ConnectionState::Closed;
                self.notice = Some(error.to_string());
                None
            }
        }
    }

    pub(crate) fn ensure_healthy(&self) {
        if matches!(
            self.connection,
            ConnectionState::Open | ConnectionState::Reconnecting
        ) && let Some(client) = &self.client
        {
            let _ = client.ensure_healthy();
        }
    }

    pub(crate) fn restore_model_catalog_snapshot(&mut self, snapshot: Option<Vec<ModelChoice>>) {
        if let Some(snapshot) = snapshot {
            self.model_catalog = snapshot;
            self.model_catalog_loaded = true;
        }
    }

    pub(crate) fn take_completed_model_catalog_snapshot(&mut self) -> Option<Vec<ModelChoice>> {
        if !self.completed_catalog_snapshot_pending {
            return None;
        }
        self.completed_catalog_snapshot_pending = false;
        Some(self.model_catalog.clone())
    }

    pub(crate) fn set_preview_capture_available(&mut self, available: bool) {
        self.preview_capture_available = available;
    }

    pub(crate) fn submit_preview_capture_result(&mut self, result: PreviewCaptureResult) {
        if let Ok(params) = serde_json::to_value(result) {
            self.send_request(
                method::PREVIEW_CAPTURE_RESULT,
                params,
                PendingRequest::PreviewCaptureResult,
            );
        }
    }

    pub(crate) fn handle_event(&mut self, event: ClientEvent) -> ClientUpdate {
        match event {
            ClientEvent::StateChanged(state) => {
                self.connection = state;
                if state == ConnectionState::Open {
                    self.notice = None;
                    self.request_initial_state();
                    return ClientUpdate {
                        shell_changed: true,
                        chat: vec![ChatUpdate::Connection(state), ChatUpdate::Refresh],
                        shell_events: Vec::new(),
                    };
                }
                ClientUpdate {
                    shell_changed: true,
                    chat: vec![ChatUpdate::Connection(state)],
                    shell_events: Vec::new(),
                }
            }
            ClientEvent::Response(response) => self.handle_response(response),
            ClientEvent::Push(push) => self.handle_push(&push.channel, push.data),
            ClientEvent::SequenceGap { expected, received } => {
                self.notice = Some(format!(
                    "Live state skipped from sequence {expected} to {received}; refreshing."
                ));
                self.request_projects();
                ClientUpdate {
                    shell_changed: true,
                    chat: vec![ChatUpdate::Refresh],
                    shell_events: Vec::new(),
                }
            }
            ClientEvent::RequestAborted { id } => self.handle_aborted_request(&id),
            ClientEvent::DecodeFailed { reason } => {
                self.notice = Some(format!("The server sent an unreadable frame: {reason}"));
                ClientUpdate::shell_changed()
            }
        }
    }

    pub(crate) fn select_thread(&mut self, thread_id: &str) {
        self.request_history(thread_id, None);
        self.request_thread_queue(thread_id);
    }

    pub(crate) fn request_thread_queue(&mut self, thread_id: &str) {
        self.send_request(
            method::THREAD_QUEUE,
            json!({ "threadId": thread_id }),
            PendingRequest::Queue {
                thread_id: thread_id.into(),
            },
        );
    }

    pub(crate) fn request_update_check(&mut self) -> ClientUpdate {
        if self.update_checking {
            return ClientUpdate::default();
        }
        self.update_checking = true;
        if !self.send_request(
            method::SYSTEM_UPDATE_CHECK,
            json!({}),
            PendingRequest::UpdateCheck,
        ) {
            self.update_checking = false;
            self.update_check =
                Some(failed_update_check(self.notice.clone().unwrap_or_else(
                    || "The update check could not be started.".into(),
                )));
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn ensure_voice_status(&mut self, provider: ProviderId) {
        if self.voice_statuses.contains_key(&provider)
            || self.voice_status_pending.contains(&provider)
        {
            return;
        }
        self.voice_status_pending.insert(provider);
        if !self.send_request(
            method::VOICE_STATUS,
            json!({ "provider": provider }),
            PendingRequest::VoiceStatus { provider },
        ) {
            self.voice_status_pending.remove(&provider);
            self.voice_statuses.insert(
                provider,
                VoiceStatusResult {
                    available: false,
                    reason: None,
                },
            );
        }
    }

    pub(crate) fn transcribe_voice(&mut self, params: VoiceTranscribeParams) -> ClientUpdate {
        let request_id = params.request_id.clone();
        let payload = match serde_json::to_value(params) {
            Ok(payload) => payload,
            Err(error) => {
                return ClientUpdate::chat(ChatUpdate::VoiceTranscriptionError {
                    request_id,
                    message: format!("The voice recording could not be encoded: {error}"),
                });
            }
        };
        if self.send_request(
            method::VOICE_TRANSCRIBE,
            payload,
            PendingRequest::VoiceTranscribe {
                request_id: request_id.clone(),
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::chat(ChatUpdate::VoiceTranscriptionError {
                request_id,
                message: self
                    .notice
                    .clone()
                    .unwrap_or_else(|| "Voice transcription could not be started.".into()),
            })
        }
    }

    pub(crate) fn cancel_voice(&mut self, request_id: String) {
        self.send_request(
            method::VOICE_CANCEL,
            json!({ "requestId": request_id }),
            PendingRequest::VoiceCancel,
        );
    }

    pub(crate) fn update_sidebar_settings(&mut self, settings: SidebarSettings) -> ClientUpdate {
        self.sidebar_settings = settings.clone();
        self.send_request(
            method::SIDEBAR_UPDATE_SETTINGS,
            json!({
                "mode": settings.mode,
                "autoSettleDays": settings.auto_settle_days,
            }),
            PendingRequest::UpdateSidebarSettings,
        );
        ClientUpdate::shell_changed()
    }

    pub(crate) fn upsert_connection(
        &mut self,
        connection: ModelConnectionInput,
        api_key: String,
    ) -> ClientUpdate {
        let connection_id = connection.id.clone();
        self.connection_busy = Some(connection_id.clone());
        self.connection_error = None;
        let params = match serde_json::to_value(connection) {
            Ok(params) => params,
            Err(error) => {
                self.connection_busy = None;
                self.connection_error = Some(format!("Could not encode the connection: {error}"));
                return ClientUpdate::shell_changed();
            }
        };
        if !self.send_request(
            method::CONNECTIONS_UPSERT,
            params,
            PendingRequest::ConnectionUpsert {
                connection_id,
                api_key,
            },
        ) {
            self.connection_busy = None;
            self.connection_error = self.notice.clone();
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn remove_connection(&mut self, connection_id: String) -> ClientUpdate {
        self.connection_busy = Some(connection_id.clone());
        self.connection_error = None;
        if !self.send_request(
            method::CONNECTIONS_REMOVE,
            json!({ "connectionId": connection_id }),
            PendingRequest::ConnectionRemove { connection_id },
        ) {
            self.connection_busy = None;
            self.connection_error = self.notice.clone();
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn start_auth(&mut self, target: AuthTarget) -> ClientUpdate {
        self.auth_busy = Some(target.clone());
        self.auth_error = None;
        if !self.send_request(
            method::AUTH_START_LOGIN,
            auth_params(&target),
            PendingRequest::AuthStart { target },
        ) {
            self.auth_busy = None;
            self.auth_error = self.notice.clone();
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn sign_out(&mut self, target: AuthTarget) -> ClientUpdate {
        self.auth_busy = Some(target.clone());
        self.auth_error = None;
        if !self.send_request(
            method::AUTH_SIGN_OUT,
            auth_params(&target),
            PendingRequest::AuthSignOut { target },
        ) {
            self.auth_busy = None;
            self.auth_error = self.notice.clone();
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn start_provider_terminal(
        &mut self,
        target: AuthTarget,
        kind: ProviderTerminalKind,
        columns: u16,
        rows: u16,
    ) -> ClientUpdate {
        self.provider_terminal_busy = Some(target.clone());
        self.auth_error = None;
        let mut params = auth_params(&target);
        if let Value::Object(params) = &mut params {
            params.insert("columns".into(), json!(columns));
            params.insert("rows".into(), json!(rows));
        }
        let request_method = match kind {
            ProviderTerminalKind::Install => method::PROVIDERS_INSTALL,
            ProviderTerminalKind::SignIn => method::PROVIDERS_LAUNCH,
        };
        if !self.send_request(
            request_method,
            params,
            PendingRequest::ProviderTerminal {
                target: target.clone(),
                kind,
            },
        ) {
            self.provider_terminal_busy = None;
            let message = self
                .notice
                .clone()
                .unwrap_or_else(|| "The provider terminal could not be started.".into());
            self.auth_error = Some(message.clone());
            return ClientUpdate {
                shell_changed: true,
                chat: Vec::new(),
                shell_events: vec![ShellEvent::ProviderTerminalError {
                    target: Some(target),
                    kind: Some(kind),
                    terminal_id: None,
                    message,
                }],
            };
        }
        ClientUpdate::shell_changed()
    }

    fn request_auth_status(&mut self, target: AuthTarget) {
        self.send_request(
            method::AUTH_STATUS,
            auth_params(&target),
            PendingRequest::AuthStatus { target },
        );
    }

    pub(crate) fn request_mcp_inventory(
        &mut self,
        provider: ProviderId,
        project_path: String,
    ) -> ClientUpdate {
        let scope = (provider, project_path.clone());
        if self.mcp_scope.as_ref() != Some(&scope) {
            self.mcp_inventory = None;
            self.mcp_notice = None;
        }
        self.mcp_scope = Some(scope);
        self.mcp_generation = self.mcp_generation.wrapping_add(1);
        let generation = self.mcp_generation;
        self.mcp_loading = true;
        self.mcp_error = None;
        if !self.send_request(
            method::MCP_LIST,
            json!({ "provider": provider, "projectPath": project_path }),
            PendingRequest::McpList {
                provider,
                project_path,
                generation,
            },
        ) {
            self.mcp_loading = false;
            self.mcp_error = self
                .notice
                .clone()
                .or_else(|| Some("Could not request MCP inventory.".into()));
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn toggle_mcp_server(
        &mut self,
        provider: ProviderId,
        project_path: String,
        server: &McpServer,
    ) -> ClientUpdate {
        self.mcp_scope = Some((provider, project_path.clone()));
        let (method_name, params, success_message) = if server.enabled {
            (
                method::MCP_ADD,
                json!({
                    "provider": provider,
                    "projectPath": project_path,
                    "server": { "id": server.id, "enabled": false }
                }),
                "Server disabled for this project.",
            )
        } else {
            (
                method::MCP_REMOVE,
                json!({
                    "provider": provider,
                    "projectPath": project_path,
                    "serverId": server.id
                }),
                "Project override removed.",
            )
        };
        self.send_mcp_mutation(
            provider,
            project_path,
            server.id.clone(),
            method_name,
            params,
            success_message,
        )
    }

    pub(crate) fn save_mcp_server(
        &mut self,
        provider: ProviderId,
        project_path: String,
        server: McpServerConfig,
        update: bool,
    ) -> ClientUpdate {
        let server_id = server.id.clone();
        let params = match serde_json::to_value(server) {
            Ok(server) => json!({
                "provider": provider,
                "projectPath": project_path,
                "server": server,
            }),
            Err(error) => {
                self.mcp_error = Some(format!("Could not encode the MCP server: {error}"));
                return ClientUpdate::shell_changed();
            }
        };
        self.send_mcp_mutation(
            provider,
            project_path,
            server_id,
            if update {
                method::MCP_UPDATE
            } else {
                method::MCP_ADD
            },
            params,
            if update {
                "Server updated."
            } else {
                "Server added."
            },
        )
    }

    pub(crate) fn remove_mcp_server(
        &mut self,
        provider: ProviderId,
        project_path: String,
        server_id: String,
    ) -> ClientUpdate {
        self.send_mcp_mutation(
            provider,
            project_path.clone(),
            server_id.clone(),
            method::MCP_REMOVE,
            json!({
                "provider": provider,
                "projectPath": project_path,
                "serverId": server_id,
            }),
            "Server removed.",
        )
    }

    pub(crate) fn start_mcp_oauth(
        &mut self,
        provider: ProviderId,
        project_path: String,
        server_id: String,
    ) -> ClientUpdate {
        self.mcp_scope = Some((provider, project_path.clone()));
        self.mcp_busy = Some(server_id.clone());
        self.mcp_error = None;
        self.mcp_notice = None;
        if !self.send_request(
            method::MCP_START_OAUTH,
            json!({
                "provider": provider,
                "projectPath": project_path,
                "serverId": server_id,
            }),
            PendingRequest::McpOAuthStart {
                provider,
                project_path,
                server_id,
            },
        ) {
            self.mcp_busy = None;
            self.mcp_error = self
                .notice
                .clone()
                .or_else(|| Some("Could not start MCP sign-in.".into()));
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn cancel_mcp_oauth(&mut self) -> ClientUpdate {
        let Some(session) = self.mcp_oauth.clone() else {
            return ClientUpdate::default();
        };
        self.mcp_busy = Some(session.server_id.clone());
        self.mcp_error = None;
        if !self.send_request(
            method::MCP_CANCEL_OAUTH,
            json!({
                "provider": session.provider,
                "projectPath": session.project_path,
                "serverId": session.server_id,
                "loginId": session.login_id,
            }),
            PendingRequest::McpOAuthCancel {
                provider: session.provider,
                project_path: session.project_path,
                server_id: session.server_id,
            },
        ) {
            self.mcp_busy = None;
            self.mcp_error = self
                .notice
                .clone()
                .or_else(|| Some("Could not cancel MCP sign-in.".into()));
        }
        ClientUpdate::shell_changed()
    }

    fn send_mcp_mutation(
        &mut self,
        provider: ProviderId,
        project_path: String,
        server_id: String,
        method_name: &'static str,
        params: Value,
        success_message: &'static str,
    ) -> ClientUpdate {
        self.mcp_scope = Some((provider, project_path.clone()));
        self.mcp_busy = Some(server_id.clone());
        self.mcp_error = None;
        self.mcp_notice = None;
        if !self.send_request(
            method_name,
            params,
            PendingRequest::McpMutation {
                provider,
                project_path,
                server_id,
                success_message: success_message.into(),
            },
        ) {
            self.mcp_busy = None;
            self.mcp_error = self
                .notice
                .clone()
                .or_else(|| Some("Could not update the MCP server.".into()));
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn request_skills_inventory(
        &mut self,
        provider: ProviderId,
        project_path: String,
    ) -> ClientUpdate {
        let scope = (provider, project_path.clone());
        if self.skills_scope.as_ref() != Some(&scope) {
            self.skills_inventory = None;
        }
        self.skills_scope = Some(scope);
        self.skills_generation = self.skills_generation.wrapping_add(1);
        let generation = self.skills_generation;
        self.skills_loading = true;
        self.skills_error = None;
        if !self.send_request(
            method::SKILLS_LIST,
            json!({ "provider": provider, "projectPath": project_path }),
            PendingRequest::SkillsList {
                provider,
                project_path,
                generation,
            },
        ) {
            self.skills_loading = false;
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn set_skill_enabled(
        &mut self,
        provider: ProviderId,
        project_path: String,
        skill_id: String,
        enabled: bool,
    ) -> ClientUpdate {
        self.skills_scope = Some((provider, project_path.clone()));
        self.skills_busy = Some(skill_id.clone());
        self.skills_error = None;
        if !self.send_request(
            method::SKILLS_SET_ENABLED,
            json!({
                "provider": provider,
                "projectPath": project_path,
                "skillId": skill_id,
                "enabled": enabled,
            }),
            PendingRequest::SkillToggle {
                provider,
                project_path,
                skill_id,
            },
        ) {
            self.skills_busy = None;
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn install_skill_from_folder(
        &mut self,
        provider: ProviderId,
        project_path: String,
        folder_path: String,
    ) -> ClientUpdate {
        self.skills_scope = Some((provider, project_path.clone()));
        self.skills_busy = Some("install".into());
        self.skills_error = None;
        if !self.send_request(
            method::SKILLS_INSTALL_FROM_FOLDER,
            json!({
                "provider": provider,
                "projectPath": project_path,
                "folderPath": folder_path,
            }),
            PendingRequest::SkillInstall {
                provider,
                project_path,
            },
        ) {
            self.skills_busy = None;
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn request_history(&mut self, thread_id: &str, after_seq: Option<u64>) {
        let params = match after_seq {
            Some(after_seq) => json!({ "threadId": thread_id, "afterSeq": after_seq }),
            None => json!({ "threadId": thread_id }),
        };
        self.send_request(
            method::THREAD_HISTORY,
            params,
            PendingRequest::History {
                thread_id: thread_id.into(),
                replace: after_seq.is_none(),
            },
        );
    }

    pub(crate) fn search_sessions(&mut self, request: SessionSearchRequest) -> ClientUpdate {
        let mut params = serde_json::Map::from_iter([
            ("query".into(), json!(request.query)),
            ("limit".into(), json!(20)),
        ]);
        if let Some(project_path) = request.project_path {
            params.insert("projectPath".into(), json!(project_path));
        }
        if let Some(provider) = request.provider {
            params.insert("provider".into(), json!(provider));
        }
        if let Some(cursor) = request.cursor {
            params.insert("cursor".into(), json!(cursor));
        }
        let pending = PendingRequest::SearchSessions {
            revision: request.revision,
            append: request.append,
        };
        if self.send_request(method::SEARCH_SESSIONS, Value::Object(params), pending) {
            ClientUpdate::default()
        } else {
            ClientUpdate::shell_event(ShellEvent::SessionSearchError {
                revision: request.revision,
                message: self
                    .notice
                    .clone()
                    .unwrap_or_else(|| "Search could not be started.".into()),
            })
        }
    }

    pub(crate) fn request_workspace(&mut self, path: String, generation: u64) -> ClientUpdate {
        let mut shell_events = Vec::new();
        if !self.send_request(
            method::WORKSPACE_INFO,
            json!({ "path": path }),
            PendingRequest::WorkspaceInfo {
                path: path.clone(),
                generation,
            },
        ) {
            shell_events.push(ShellEvent::WorkspaceError {
                path: path.clone(),
                generation,
                operation: WorkspaceOperation::Info,
                message: self.request_start_error("Workspace status could not be loaded."),
            });
        }
        if !self.send_request(
            method::WORKSPACE_BRANCHES,
            json!({ "path": path }),
            PendingRequest::WorkspaceBranches {
                path: path.clone(),
                generation,
            },
        ) {
            shell_events.push(ShellEvent::WorkspaceError {
                path,
                generation,
                operation: WorkspaceOperation::Branches,
                message: self.request_start_error("Branches could not be loaded."),
            });
        }
        ClientUpdate {
            shell_changed: !shell_events.is_empty(),
            chat: Vec::new(),
            shell_events,
        }
    }

    pub(crate) fn switch_workspace_branch(
        &mut self,
        path: String,
        branch: String,
        generation: u64,
    ) -> ClientUpdate {
        if self.send_request(
            method::WORKSPACE_SWITCH_BRANCH,
            json!({ "path": path, "branch": branch }),
            PendingRequest::WorkspaceSwitch {
                path: path.clone(),
                branch,
                generation,
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                path,
                generation,
                operation: WorkspaceOperation::Switch,
                message: self.request_start_error("The branch could not be switched."),
            })
        }
    }

    pub(crate) fn request_checkpoints(
        &mut self,
        thread_id: String,
        generation: u64,
    ) -> ClientUpdate {
        if self.send_request(
            method::THREAD_CHECKPOINTS,
            json!({ "threadId": thread_id }),
            PendingRequest::Checkpoints {
                thread_id: thread_id.clone(),
                generation,
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::shell_event(ShellEvent::RollbackError {
                thread_id,
                generation,
                operation: RollbackOperation::Checkpoints,
                message: self.request_start_error("Checkpoints could not be loaded."),
            })
        }
    }

    pub(crate) fn request_changed_since(
        &mut self,
        thread_id: String,
        checkpoint_id: u64,
        generation: u64,
    ) -> ClientUpdate {
        if self.send_request(
            method::THREAD_CHANGED_SINCE,
            json!({ "threadId": thread_id, "checkpointId": checkpoint_id }),
            PendingRequest::ChangedSince {
                thread_id: thread_id.clone(),
                checkpoint_id,
                generation,
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::shell_event(ShellEvent::RollbackError {
                thread_id,
                generation,
                operation: RollbackOperation::Inspect,
                message: self.request_start_error("The checkpoint could not be inspected."),
            })
        }
    }

    pub(crate) fn restore_checkpoint(
        &mut self,
        thread_id: String,
        checkpoint_id: u64,
        generation: u64,
    ) -> ClientUpdate {
        if self.send_request(
            method::THREAD_RESTORE,
            json!({ "threadId": thread_id, "checkpointId": checkpoint_id }),
            PendingRequest::Restore {
                thread_id: thread_id.clone(),
                checkpoint_id,
                generation,
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::shell_event(ShellEvent::RollbackError {
                thread_id,
                generation,
                operation: RollbackOperation::Restore,
                message: self.request_start_error("The checkpoint could not be restored."),
            })
        }
    }

    pub(crate) fn undo_restore(
        &mut self,
        thread_id: String,
        undo: String,
        generation: u64,
    ) -> ClientUpdate {
        if self.send_request(
            method::THREAD_UNDO_RESTORE,
            json!({ "threadId": thread_id, "undo": undo }),
            PendingRequest::UndoRestore {
                thread_id: thread_id.clone(),
                generation,
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::shell_event(ShellEvent::RollbackError {
                thread_id,
                generation,
                operation: RollbackOperation::Undo,
                message: self.request_start_error("The restore could not be undone."),
            })
        }
    }

    pub(crate) fn request_usage(&mut self, scope: UsageScope, generation: u64) -> ClientUpdate {
        let params = match &scope {
            UsageScope::Thread(thread_id) => json!({ "threadId": thread_id }),
            UsageScope::Provider(provider) => json!({ "provider": provider }),
        };
        if self.send_request(
            method::USAGE_SUMMARY,
            params,
            PendingRequest::Usage {
                scope: scope.clone(),
                generation,
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::shell_event(ShellEvent::UsageError {
                scope,
                generation,
                message: self.request_start_error("Usage could not be loaded."),
            })
        }
    }

    fn request_start_error(&self, fallback: &str) -> String {
        self.notice.clone().unwrap_or_else(|| fallback.into())
    }

    pub(crate) fn send_turn(
        &mut self,
        thread_id: &str,
        request: SendTurnRequest,
        optimistic_queue_id: Option<String>,
    ) -> ClientUpdate {
        let steer = request.steer;
        let steer_echo_after_row = request.steer_echo_after_row;
        let started_echo_after_row = request.started_echo_after_row;
        let restore_text = request.text.clone();
        let restore_attachments = request.attachments.clone();
        if self.send_request(
            method::THREAD_SEND_TURN,
            send_turn_params(thread_id, request),
            PendingRequest::SendTurn {
                thread_id: thread_id.into(),
                steer,
                restore_text: restore_text.clone(),
                restore_attachments: restore_attachments.clone(),
                optimistic_queue_id: optimistic_queue_id.clone(),
                steer_echo_after_row,
                started_echo_after_row,
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::chat(ChatUpdate::TurnError {
                thread_id: thread_id.into(),
                message: self.request_start_error(
                    "This request could not be sent because the server is unavailable.",
                ),
                restore_text,
                restore_attachments,
                optimistic_queue_id,
            })
        }
    }

    pub(crate) fn delete_queued_turn(
        &mut self,
        thread_id: &str,
        queued_turn_id: &str,
    ) -> ClientUpdate {
        self.send_queue_mutation(
            method::THREAD_DELETE_QUEUED_TURN,
            thread_id,
            queue_mutation_params(thread_id, queued_turn_id, None),
        )
    }

    pub(crate) fn move_queued_turn(
        &mut self,
        thread_id: &str,
        queued_turn_id: &str,
        direction: QueueDirection,
    ) -> ClientUpdate {
        self.send_queue_mutation(
            method::THREAD_MOVE_QUEUED_TURN,
            thread_id,
            queue_mutation_params(thread_id, queued_turn_id, Some(direction)),
        )
    }

    pub(crate) fn steer_queued_turn(
        &mut self,
        thread_id: &str,
        queued_turn_id: &str,
    ) -> ClientUpdate {
        let sent = self.send_request(
            method::THREAD_STEER_QUEUED_TURN,
            queue_mutation_params(thread_id, queued_turn_id, None),
            PendingRequest::Steer {
                thread_id: thread_id.into(),
                echo: None,
            },
        );
        if sent {
            ClientUpdate::default()
        } else {
            ClientUpdate::shell_changed()
        }
    }

    fn send_queue_mutation(
        &mut self,
        method_name: &str,
        thread_id: &str,
        params: Value,
    ) -> ClientUpdate {
        let sent = self.send_request(
            method_name,
            params,
            PendingRequest::QueueMutation {
                thread_id: thread_id.into(),
            },
        );
        if sent {
            ClientUpdate::default()
        } else {
            ClientUpdate::shell_changed()
        }
    }

    pub(crate) fn interrupt(&mut self, thread_id: &str) {
        self.send_request(
            method::THREAD_INTERRUPT,
            json!({ "threadId": thread_id }),
            PendingRequest::Interrupt {
                thread_id: thread_id.into(),
            },
        );
    }

    pub(crate) fn open_terminal(
        &mut self,
        thread_id: &str,
        columns: u16,
        rows: u16,
    ) -> ClientUpdate {
        if self.send_request(
            method::TERMINAL_OPEN,
            json!({
                "threadId": thread_id,
                "columns": columns,
                "rows": rows,
            }),
            PendingRequest::TerminalOpen {
                thread_id: thread_id.into(),
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::chat(ChatUpdate::TerminalOpenError {
                thread_id: thread_id.into(),
                message: self
                    .notice
                    .clone()
                    .unwrap_or_else(|| "The terminal could not be opened.".into()),
            })
        }
    }

    pub(crate) fn write_terminal(&mut self, terminal_id: &str, data: String) -> ClientUpdate {
        if self.send_request(
            method::TERMINAL_INPUT,
            json!({ "terminalId": terminal_id, "data": data }),
            PendingRequest::TerminalInput {
                terminal_id: terminal_id.into(),
            },
        ) {
            ClientUpdate::default()
        } else {
            self.immediate_terminal_error(terminal_id, "The terminal input could not be sent.")
        }
    }

    pub(crate) fn resize_terminal(
        &mut self,
        terminal_id: &str,
        columns: u16,
        rows: u16,
    ) -> ClientUpdate {
        if self.send_request(
            method::TERMINAL_RESIZE,
            json!({
                "terminalId": terminal_id,
                "columns": columns,
                "rows": rows,
            }),
            PendingRequest::TerminalResize {
                terminal_id: terminal_id.into(),
            },
        ) {
            ClientUpdate::default()
        } else {
            self.immediate_terminal_error(terminal_id, "The terminal resize could not be sent.")
        }
    }

    pub(crate) fn close_terminal(&mut self, terminal_id: &str) -> ClientUpdate {
        if self.send_request(
            method::TERMINAL_CLOSE,
            json!({ "terminalId": terminal_id }),
            PendingRequest::TerminalClose {
                terminal_id: terminal_id.into(),
            },
        ) {
            ClientUpdate::default()
        } else {
            self.immediate_terminal_error(terminal_id, "The terminal could not be closed.")
        }
    }

    fn immediate_terminal_error(&self, terminal_id: &str, fallback: &str) -> ClientUpdate {
        ClientUpdate::chat(ChatUpdate::TerminalError {
            terminal_id: terminal_id.into(),
            message: self.notice.clone().unwrap_or_else(|| fallback.to_owned()),
        })
    }

    pub(crate) fn respond_to_approval(
        &mut self,
        thread_id: &str,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> ClientUpdate {
        if self.send_request(
            method::THREAD_RESPOND_TO_APPROVAL,
            json!({
                "threadId": thread_id,
                "approvalId": approval_id,
                "decision": decision,
            }),
            PendingRequest::RespondApproval {
                thread_id: thread_id.into(),
                approval_id: approval_id.into(),
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::chat(ChatUpdate::ApprovalError {
                thread_id: thread_id.into(),
                approval_id: approval_id.into(),
                message: self
                    .notice
                    .clone()
                    .unwrap_or_else(|| "The approval response could not be sent.".into()),
            })
        }
    }

    pub(crate) fn respond_to_user_input(
        &mut self,
        thread_id: &str,
        request_id: &str,
        answers: HashMap<String, Vec<String>>,
    ) -> ClientUpdate {
        if self.send_request(
            method::THREAD_RESPOND_TO_USER_INPUT,
            json!({
                "threadId": thread_id,
                "requestId": request_id,
                "answers": answers,
            }),
            PendingRequest::RespondUserInput {
                thread_id: thread_id.into(),
                request_id: request_id.into(),
            },
        ) {
            ClientUpdate::default()
        } else {
            ClientUpdate::chat(ChatUpdate::UserInputError {
                thread_id: thread_id.into(),
                request_id: request_id.into(),
                message: self
                    .notice
                    .clone()
                    .unwrap_or_else(|| "The answers could not be sent.".into()),
            })
        }
    }

    pub(crate) fn request_diff(&mut self, thread_id: &str) -> ClientUpdate {
        if self.send_request(
            method::THREAD_DIFF,
            json!({ "threadId": thread_id }),
            PendingRequest::Diff {
                thread_id: thread_id.into(),
            },
        ) {
            ClientUpdate::default()
        } else {
            self.immediate_diff_error(thread_id)
        }
    }

    pub(crate) fn review_hunk(
        &mut self,
        thread_id: &str,
        request: ReviewHunkRequest,
    ) -> ClientUpdate {
        if self.send_request(
            method::THREAD_REVIEW_HUNK,
            json!({
                "threadId": thread_id,
                "version": request.version,
                "path": request.path,
                "hunkId": request.hunk_id,
                "decision": request.decision,
            }),
            PendingRequest::ReviewHunk {
                thread_id: thread_id.into(),
            },
        ) {
            ClientUpdate::default()
        } else {
            self.immediate_diff_error(thread_id)
        }
    }

    fn immediate_diff_error(&self, thread_id: &str) -> ClientUpdate {
        ClientUpdate::chat(ChatUpdate::DiffError {
            thread_id: thread_id.into(),
            message: self
                .notice
                .clone()
                .unwrap_or_else(|| "The diff request could not be sent.".into()),
            stale: false,
        })
    }

    pub(crate) fn add_project(&mut self, path: String) {
        self.send_request(
            method::PROJECTS_ADD,
            json!({ "path": path }),
            PendingRequest::AddProject { path },
        );
    }

    pub(crate) fn pin_project(&mut self, path: String, pinned: bool) -> ClientUpdate {
        if self.send_request(
            method::PROJECTS_PIN,
            json!({ "path": &path, "pinned": pinned }),
            PendingRequest::ProjectMutation { removed_path: None },
        ) && let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.path == path)
        {
            project.pinned = pinned;
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn rename_project(&mut self, path: String, name: String) -> ClientUpdate {
        if self.send_request(
            method::PROJECTS_RENAME,
            json!({ "path": &path, "name": &name }),
            PendingRequest::ProjectMutation { removed_path: None },
        ) && let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.path == path)
        {
            project.name = name;
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn remove_project(&mut self, path: String) -> ClientUpdate {
        if self.send_request(
            method::PROJECTS_REMOVE,
            json!({ "path": &path }),
            PendingRequest::ProjectMutation {
                removed_path: Some(path.clone()),
            },
        ) {
            self.projects.retain(|project| project.path != path);
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn delete_untouched_sessions(&mut self, project_path: &str) -> bool {
        let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.path == project_path)
        else {
            return false;
        };
        let untouched = project
            .sessions
            .iter()
            .filter(|session| session.title == "New session")
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        if untouched.is_empty() {
            return false;
        }
        project
            .sessions
            .retain(|session| session.title != "New session");
        for thread_id in untouched {
            if self.send_request(
                method::THREAD_DELETE,
                json!({ "threadId": thread_id }),
                PendingRequest::DeleteUntouched,
            ) {
                self.untouched_deletes_pending += 1;
            }
        }
        true
    }

    fn finish_untouched_delete(&mut self) -> ClientUpdate {
        self.untouched_deletes_pending = self.untouched_deletes_pending.saturating_sub(1);
        if self.untouched_deletes_pending == 0 {
            self.request_projects();
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn rename_thread(&mut self, thread_id: String, title: String) -> ClientUpdate {
        if self.send_request(
            method::THREAD_RENAME,
            json!({ "threadId": &thread_id, "title": &title }),
            PendingRequest::ThreadSummaryMutation,
        ) && let Some(session) = self.session_mut(&thread_id)
        {
            session.title = title;
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn pin_thread(&mut self, thread_id: String, pinned: bool) -> ClientUpdate {
        if self.send_request(
            method::THREAD_PIN,
            json!({ "threadId": &thread_id, "pinned": pinned }),
            PendingRequest::ThreadSummaryMutation,
        ) && let Some(session) = self.session_mut(&thread_id)
        {
            session.pinned = pinned;
        }
        ClientUpdate::shell_changed()
    }

    pub(crate) fn settle_thread(&mut self, thread_id: String) -> ClientUpdate {
        self.request_thread_lifecycle(method::THREAD_SETTLE, thread_id, None, true)
    }

    pub(crate) fn unsettle_thread(&mut self, thread_id: String) -> ClientUpdate {
        self.request_thread_lifecycle(method::THREAD_UNSETTLE, thread_id, None, false)
    }

    pub(crate) fn snooze_thread(&mut self, thread_id: String, wake_at: u64) -> ClientUpdate {
        self.request_thread_lifecycle(
            method::THREAD_SNOOZE,
            thread_id,
            Some(("wakeAt", json!(wake_at))),
            true,
        )
    }

    pub(crate) fn unsnooze_thread(&mut self, thread_id: String) -> ClientUpdate {
        self.request_thread_lifecycle(method::THREAD_UNSNOOZE, thread_id, None, false)
    }

    pub(crate) fn set_thread_keep_active(
        &mut self,
        thread_id: String,
        keep_active: bool,
    ) -> ClientUpdate {
        self.request_thread_lifecycle(
            method::THREAD_SET_KEEP_ACTIVE,
            thread_id,
            Some(("keepActive", json!(keep_active))),
            false,
        )
    }

    fn request_thread_lifecycle(
        &mut self,
        method_name: &str,
        thread_id: String,
        extra: Option<(&str, Value)>,
        hide: bool,
    ) -> ClientUpdate {
        let mut params = serde_json::Map::from_iter([("threadId".into(), json!(&thread_id))]);
        if let Some((key, value)) = extra {
            params.insert(key.into(), value);
        }
        self.send_request(
            method_name,
            Value::Object(params),
            PendingRequest::ThreadLifecycle { thread_id, hide },
        );
        ClientUpdate::shell_changed()
    }

    pub(crate) fn archive_thread(&mut self, thread_id: String) -> ClientUpdate {
        self.send_request(
            method::THREAD_UNSAVED_WORK,
            json!({ "threadId": &thread_id }),
            PendingRequest::ArchiveInspect { thread_id },
        );
        ClientUpdate::shell_changed()
    }

    pub(crate) fn force_archive_thread(&mut self, thread_id: String) -> ClientUpdate {
        self.begin_archive_close(thread_id, true)
    }

    fn begin_archive_close(&mut self, thread_id: String, force: bool) -> ClientUpdate {
        self.send_request(
            method::THREAD_CLOSE,
            json!({ "threadId": &thread_id }),
            PendingRequest::ArchiveClose { thread_id, force },
        );
        ClientUpdate::shell_changed()
    }

    fn begin_archive_discard(&mut self, thread_id: String, force: bool) -> ClientUpdate {
        let mut params = serde_json::Map::from_iter([("threadId".into(), json!(&thread_id))]);
        if force {
            params.insert("force".into(), json!(true));
        }
        self.send_request(
            method::THREAD_DISCARD_WORKTREE,
            Value::Object(params),
            PendingRequest::ArchiveDiscard { thread_id },
        );
        ClientUpdate::shell_changed()
    }

    fn begin_archive_delete(&mut self, thread_id: String) -> ClientUpdate {
        self.send_request(
            method::THREAD_DELETE,
            json!({ "threadId": &thread_id }),
            PendingRequest::ArchiveDelete { thread_id },
        );
        ClientUpdate::shell_changed()
    }

    pub(crate) fn start_thread(&mut self, request: NewThreadRequest) -> ClientUpdate {
        let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.path == request.project_path)
        else {
            return self.fail_start_thread(request, "That project is no longer available.".into());
        };
        project
            .sessions
            .retain(|session| session.id != request.provisional_id);
        project.sessions.insert(
            0,
            SessionSummary {
                id: request.provisional_id.clone(),
                title: request.title.clone(),
                provider: request.choice.provider,
                agent: request.choice.agent_id.clone(),
                created_at: unix_time_ms(),
                running: true,
                pinned: false,
                status: Some(ThreadInboxStatus::Starting),
                unread: Some(false),
                lifecycle: Some(ThreadLifecycle::Active {
                    keep_active: false,
                    woke_at: None,
                }),
                closed_at: None,
                worktree_branch: None,
            },
        );
        let mut params = serde_json::Map::from_iter([
            ("provider".into(), json!(request.choice.provider)),
            ("workspacePath".into(), json!(request.project_path)),
            ("approval".into(), json!(request.approval)),
        ]);
        if let Some(agent) = &request.choice.agent_id {
            params.insert("agent".into(), json!(agent));
        }
        if let Some(connection_id) = &request.choice.connection_id {
            params.insert("connectionId".into(), json!(connection_id));
        }
        if !request.choice.model.id.is_empty() {
            params.insert("model".into(), json!(request.choice.model.id));
        }
        if let Some(service_tier) = &request.service_tier {
            params.insert("serviceTier".into(), json!(service_tier));
        }
        if let Some(effort) = &request.effort {
            params.insert("effort".into(), json!(effort));
        }
        if request.isolate {
            params.insert("isolate".into(), json!(true));
        }
        if self.send_request(
            method::THREAD_START,
            Value::Object(params),
            PendingRequest::StartThread {
                request: request.clone(),
            },
        ) {
            ClientUpdate::shell_changed()
        } else {
            self.fail_start_thread(
                request,
                "The session could not be started because the server is unavailable.".into(),
            )
        }
    }

    fn fail_start_thread(&mut self, request: NewThreadRequest, message: String) -> ClientUpdate {
        self.remove_session(&request.provisional_id);
        ClientUpdate {
            shell_changed: true,
            chat: vec![ChatUpdate::DraftError {
                message,
                restore_text: request.text,
                restore_attachments: request.attachments,
            }],
            shell_events: Vec::new(),
        }
    }

    fn request_initial_state(&mut self) {
        self.voice_statuses.clear();
        self.voice_status_pending.clear();
        self.send_request(
            method::CLIENT_CAPABILITIES,
            json!({ "previewCapture": self.preview_capture_available }),
            PendingRequest::Capabilities,
        );
        self.send_request(method::SYSTEM_INFO, json!({}), PendingRequest::SystemInfo);
        self.request_projects();
        self.send_request(
            method::SIDEBAR_SETTINGS,
            json!({}),
            PendingRequest::SidebarSettings,
        );
        self.request_model_catalog();
    }

    fn request_model_catalog(&mut self) {
        self.pending
            .retain(|_, request| !request.is_catalog_request());
        self.pending_provider_statuses.clear();
        self.pending_model_connections.clear();
        self.pending_acp_agents.clear();
        self.pending_model_catalog.clear();
        self.catalog_refresh_failed = false;
        self.catalog_discovery_pending = 0;
        self.catalog_model_pending = 0;
        if self.send_request(method::PROVIDERS_LIST, json!({}), PendingRequest::Providers) {
            self.catalog_discovery_pending += 1;
        } else {
            self.catalog_refresh_failed = true;
        }
        if self.send_request(
            method::CONNECTIONS_LIST,
            json!({}),
            PendingRequest::Connections,
        ) {
            self.catalog_discovery_pending += 1;
        }
        if self.send_request(method::ACP_AGENTS, json!({}), PendingRequest::AcpAgents) {
            self.catalog_discovery_pending += 1;
        }
        self.update_catalog_loaded();
    }

    pub(crate) fn refresh_model_catalog(&mut self) {
        self.request_model_catalog();
    }

    fn request_projects(&mut self) {
        self.send_request(method::PROJECTS_LIST, json!({}), PendingRequest::Projects);
    }

    fn send_request(&mut self, method: &str, params: Value, request: PendingRequest) -> bool {
        let Some(client) = &self.client else {
            return false;
        };
        match client.request(method, params) {
            Ok(id) => {
                self.pending.insert(id, request);
                true
            }
            Err(error) => {
                self.notice = Some(error.to_string());
                false
            }
        }
    }

    fn handle_response(&mut self, response: Response<Value>) -> ClientUpdate {
        let pending = self.pending.remove(response.id());
        match response {
            Response::Failure { error, .. } => {
                if pending
                    .as_ref()
                    .is_some_and(PendingRequest::is_catalog_request)
                {
                    self.finish_catalog_request(pending.as_ref().expect("checked above"));
                    return ClientUpdate::shell_changed();
                }
                let stale = error.code == ErrorCode::StaleSnapshot;
                let message = match error.detail {
                    Some(detail) => format!("{} ({detail})", error.message),
                    None => error.message,
                };
                match pending {
                    Some(PendingRequest::SystemInfo) => ClientUpdate::default(),
                    Some(PendingRequest::UpdateCheck) => {
                        self.update_checking = false;
                        self.update_check = Some(failed_update_check(message));
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::VoiceStatus { provider }) => {
                        self.voice_status_pending.remove(&provider);
                        self.voice_statuses.insert(
                            provider,
                            VoiceStatusResult {
                                available: false,
                                reason: None,
                            },
                        );
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::VoiceTranscribe { request_id }) => {
                        ClientUpdate::chat(ChatUpdate::VoiceTranscriptionError {
                            request_id,
                            message,
                        })
                    }
                    Some(PendingRequest::VoiceCancel | PendingRequest::PreviewCaptureResult) => {
                        ClientUpdate::default()
                    }
                    Some(PendingRequest::ProviderTerminal { target, kind }) => {
                        if self.provider_terminal_busy.as_ref() == Some(&target) {
                            self.provider_terminal_busy = None;
                        }
                        self.clear_orphaned_provider_terminal_events();
                        self.auth_error = Some(message.clone());
                        ClientUpdate {
                            shell_changed: true,
                            chat: Vec::new(),
                            shell_events: vec![ShellEvent::ProviderTerminalError {
                                target: Some(target),
                                kind: Some(kind),
                                terminal_id: None,
                                message,
                            }],
                        }
                    }
                    Some(PendingRequest::AuthStatus { target }) => {
                        self.accounts.insert(
                            target,
                            Account {
                                signed_in: false,
                                email: None,
                                plan: None,
                            },
                        );
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::AuthStart { target })
                    | Some(PendingRequest::AuthSignOut { target }) => {
                        if self.auth_busy.as_ref() == Some(&target) {
                            self.auth_busy = None;
                        }
                        self.auth_error = Some(message);
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::ConnectionUpsert { connection_id, .. })
                    | Some(PendingRequest::ConnectionCredential { connection_id })
                    | Some(PendingRequest::ConnectionRemove { connection_id }) => {
                        if self.connection_busy.as_deref() == Some(connection_id.as_str()) {
                            self.connection_busy = None;
                        }
                        self.connection_error = Some(message);
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::McpList {
                        provider,
                        project_path,
                        generation,
                    }) => {
                        if self.mcp_scope.as_ref() == Some(&(provider, project_path))
                            && self.mcp_generation == generation
                        {
                            self.mcp_loading = false;
                            self.mcp_error = Some(message);
                            ClientUpdate::shell_changed()
                        } else {
                            ClientUpdate::default()
                        }
                    }
                    Some(PendingRequest::McpMutation { server_id, .. }) => {
                        if self.mcp_busy.as_deref() == Some(server_id.as_str()) {
                            self.mcp_busy = None;
                        }
                        self.mcp_notice = None;
                        self.mcp_error = Some(message);
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::McpReload { .. }) => {
                        self.mcp_loading = false;
                        self.mcp_busy = None;
                        self.mcp_error = Some(message);
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::McpOAuthStart { server_id, .. })
                    | Some(PendingRequest::McpOAuthCancel { server_id, .. }) => {
                        if self.mcp_busy.as_deref() == Some(server_id.as_str()) {
                            self.mcp_busy = None;
                        }
                        self.clear_orphaned_mcp_oauth_events();
                        self.mcp_error = Some(message);
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::SkillsList {
                        provider,
                        project_path,
                        generation,
                    }) => {
                        if self.skills_scope.as_ref() == Some(&(provider, project_path))
                            && self.skills_generation == generation
                        {
                            self.skills_loading = false;
                            self.skills_error = Some(message);
                            ClientUpdate::shell_changed()
                        } else {
                            ClientUpdate::default()
                        }
                    }
                    Some(PendingRequest::SkillToggle { skill_id, .. }) => {
                        if self.skills_busy.as_deref() == Some(skill_id.as_str()) {
                            self.skills_busy = None;
                        }
                        self.skills_error = Some(message);
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::SkillInstall { .. }) => {
                        self.skills_busy = None;
                        self.skills_error = Some(message);
                        ClientUpdate::shell_changed()
                    }
                    Some(PendingRequest::SearchSessions { revision, .. }) => {
                        ClientUpdate::shell_event(ShellEvent::SessionSearchError {
                            revision,
                            message,
                        })
                    }
                    Some(PendingRequest::WorkspaceInfo { path, generation }) => {
                        ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                            path,
                            generation,
                            operation: WorkspaceOperation::Info,
                            message,
                        })
                    }
                    Some(PendingRequest::WorkspaceBranches { path, generation }) => {
                        ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                            path,
                            generation,
                            operation: WorkspaceOperation::Branches,
                            message,
                        })
                    }
                    Some(PendingRequest::WorkspaceSwitch {
                        path, generation, ..
                    }) => ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                        path,
                        generation,
                        operation: WorkspaceOperation::Switch,
                        message,
                    }),
                    Some(PendingRequest::Checkpoints {
                        thread_id,
                        generation,
                    }) => ClientUpdate::shell_event(ShellEvent::RollbackError {
                        thread_id,
                        generation,
                        operation: RollbackOperation::Checkpoints,
                        message,
                    }),
                    Some(PendingRequest::ChangedSince {
                        thread_id,
                        generation,
                        ..
                    }) => ClientUpdate::shell_event(ShellEvent::RollbackError {
                        thread_id,
                        generation,
                        operation: RollbackOperation::Inspect,
                        message,
                    }),
                    Some(PendingRequest::Restore {
                        thread_id,
                        generation,
                        ..
                    }) => ClientUpdate::shell_event(ShellEvent::RollbackError {
                        thread_id,
                        generation,
                        operation: RollbackOperation::Restore,
                        message,
                    }),
                    Some(PendingRequest::UndoRestore {
                        thread_id,
                        generation,
                    }) => ClientUpdate::shell_event(ShellEvent::RollbackError {
                        thread_id,
                        generation,
                        operation: RollbackOperation::Undo,
                        message,
                    }),
                    Some(PendingRequest::Usage { scope, generation }) => {
                        ClientUpdate::shell_event(ShellEvent::UsageError {
                            scope,
                            generation,
                            message,
                        })
                    }
                    Some(
                        PendingRequest::ProjectMutation { .. }
                        | PendingRequest::ThreadSummaryMutation
                        | PendingRequest::ThreadLifecycle { .. },
                    ) => {
                        self.notice = Some(message);
                        self.request_projects();
                        ClientUpdate::shell_changed()
                    }
                    Some(
                        PendingRequest::ArchiveInspect { thread_id }
                        | PendingRequest::ArchiveClose { thread_id, .. }
                        | PendingRequest::ArchiveDiscard { thread_id }
                        | PendingRequest::ArchiveDelete { thread_id },
                    ) => {
                        self.notice = Some(message);
                        self.request_projects();
                        ClientUpdate {
                            shell_changed: true,
                            chat: Vec::new(),
                            shell_events: vec![ShellEvent::ArchiveFailed { thread_id }],
                        }
                    }
                    Some(PendingRequest::StartThread { request }) => {
                        self.fail_start_thread(request, message)
                    }
                    Some(PendingRequest::DeleteUntouched) => self.finish_untouched_delete(),
                    Some(PendingRequest::SendTurn {
                        thread_id,
                        restore_text,
                        restore_attachments,
                        optimistic_queue_id,
                        ..
                    }) => ClientUpdate::chat(ChatUpdate::TurnError {
                        thread_id,
                        message,
                        restore_text,
                        restore_attachments,
                        optimistic_queue_id,
                    }),
                    Some(PendingRequest::RespondApproval {
                        thread_id,
                        approval_id,
                    }) => ClientUpdate::chat(ChatUpdate::ApprovalError {
                        thread_id,
                        approval_id,
                        message,
                    }),
                    Some(PendingRequest::RespondUserInput {
                        thread_id,
                        request_id,
                    }) => ClientUpdate::chat(ChatUpdate::UserInputError {
                        thread_id,
                        request_id,
                        message,
                    }),
                    Some(PendingRequest::Diff { thread_id })
                    | Some(PendingRequest::ReviewHunk { thread_id }) => {
                        ClientUpdate::chat(ChatUpdate::DiffError {
                            thread_id,
                            message,
                            stale,
                        })
                    }
                    Some(PendingRequest::TerminalOpen { thread_id }) => {
                        ClientUpdate::chat(ChatUpdate::TerminalOpenError { thread_id, message })
                    }
                    Some(PendingRequest::TerminalInput { terminal_id })
                    | Some(PendingRequest::TerminalResize { terminal_id })
                    | Some(PendingRequest::TerminalClose { terminal_id }) => {
                        if self.settings_terminal_ids.contains(&terminal_id) {
                            ClientUpdate {
                                shell_changed: true,
                                chat: Vec::new(),
                                shell_events: vec![ShellEvent::ProviderTerminalError {
                                    target: None,
                                    kind: None,
                                    terminal_id: Some(terminal_id),
                                    message,
                                }],
                            }
                        } else {
                            ClientUpdate::chat(ChatUpdate::TerminalError {
                                terminal_id,
                                message,
                            })
                        }
                    }
                    Some(request) => match request.thread_id() {
                        Some(thread_id) => {
                            ClientUpdate::chat(ChatUpdate::Error { thread_id, message })
                        }
                        None => {
                            self.notice = Some(message);
                            ClientUpdate::shell_changed()
                        }
                    },
                    None => {
                        self.notice = Some(message);
                        ClientUpdate::shell_changed()
                    }
                }
            }
            Response::Success { result, .. } => match pending {
                Some(PendingRequest::SystemInfo) => {
                    if let Ok(info) = serde_json::from_value::<SystemInfo>(result) {
                        self.system_info = Some(info);
                    }
                    ClientUpdate::shell_changed()
                }
                Some(PendingRequest::UpdateCheck) => {
                    self.update_checking = false;
                    self.update_check = Some(
                        serde_json::from_value::<UpdateCheckResult>(result).unwrap_or_else(
                            |error| {
                                failed_update_check(format!(
                                    "system.updateCheck was invalid: {error}"
                                ))
                            },
                        ),
                    );
                    ClientUpdate::shell_changed()
                }
                Some(PendingRequest::VoiceStatus { provider }) => {
                    self.voice_status_pending.remove(&provider);
                    let status = serde_json::from_value::<VoiceStatusResult>(result).unwrap_or(
                        VoiceStatusResult {
                            available: false,
                            reason: None,
                        },
                    );
                    self.voice_statuses.insert(provider, status);
                    ClientUpdate::shell_changed()
                }
                Some(PendingRequest::VoiceTranscribe { request_id }) => {
                    match serde_json::from_value::<VoiceTranscriptionResult>(result) {
                        Ok(result) => ClientUpdate::chat(ChatUpdate::VoiceTranscribed {
                            request_id,
                            text: result.text,
                        }),
                        Err(error) => ClientUpdate::chat(ChatUpdate::VoiceTranscriptionError {
                            request_id,
                            message: format!("voice.transcribe was invalid: {error}"),
                        }),
                    }
                }
                Some(PendingRequest::Projects) => self.handle_projects_response(result),
                Some(PendingRequest::SidebarSettings)
                | Some(PendingRequest::UpdateSidebarSettings) => {
                    self.handle_settings_response(result)
                }
                Some(PendingRequest::Providers) => self.handle_providers_response(result),
                Some(PendingRequest::Connections) => self.handle_connections_response(result),
                Some(PendingRequest::AuthStatus { target }) => {
                    self.handle_auth_status_response(result, target)
                }
                Some(PendingRequest::AuthStart { target }) => {
                    self.handle_auth_start_response(result, target)
                }
                Some(PendingRequest::AuthSignOut { target }) => {
                    self.handle_auth_sign_out_response(target)
                }
                Some(PendingRequest::ProviderTerminal { target, kind }) => {
                    self.handle_provider_terminal_response(result, target, kind)
                }
                Some(PendingRequest::ConnectionUpsert {
                    connection_id,
                    api_key,
                }) => self.handle_connection_upsert_response(result, connection_id, api_key),
                Some(PendingRequest::ConnectionCredential { connection_id }) => {
                    self.handle_connection_credential_response(result, connection_id)
                }
                Some(PendingRequest::ConnectionRemove { connection_id }) => {
                    self.handle_connection_remove_response(connection_id)
                }
                Some(PendingRequest::AcpAgents) => self.handle_acp_agents_response(result),
                Some(PendingRequest::Models { source }) => {
                    self.handle_models_response(result, source)
                }
                Some(PendingRequest::McpList {
                    provider,
                    project_path,
                    generation,
                }) => self.handle_mcp_response(result, provider, project_path, generation),
                Some(PendingRequest::McpMutation {
                    provider,
                    project_path,
                    success_message,
                    ..
                }) => self.finish_mcp_mutation(provider, project_path, success_message),
                Some(PendingRequest::McpReload {
                    provider,
                    project_path,
                    success_message,
                }) => self.finish_mcp_reload(provider, project_path, success_message),
                Some(PendingRequest::McpOAuthStart {
                    provider,
                    project_path,
                    server_id,
                }) => {
                    self.handle_mcp_oauth_start_response(result, provider, project_path, server_id)
                }
                Some(PendingRequest::McpOAuthCancel {
                    provider,
                    project_path,
                    server_id,
                }) => self.handle_mcp_oauth_cancel_response(provider, project_path, server_id),
                Some(PendingRequest::SkillsList {
                    provider,
                    project_path,
                    generation,
                }) => self.handle_skills_response(result, provider, project_path, generation),
                Some(PendingRequest::SkillToggle {
                    provider,
                    project_path,
                    skill_id,
                }) => self.handle_skill_toggle_response(result, provider, project_path, skill_id),
                Some(PendingRequest::SkillInstall {
                    provider,
                    project_path,
                }) => self.handle_skill_install_response(result, provider, project_path),
                Some(PendingRequest::AddProject { path }) => {
                    self.handle_add_project_response(result, path)
                }
                Some(PendingRequest::ProjectMutation { removed_path }) => {
                    self.request_projects();
                    match removed_path {
                        Some(path) => {
                            ClientUpdate::shell_event(ShellEvent::ProjectRemoved { path })
                        }
                        None => ClientUpdate::shell_changed(),
                    }
                }
                Some(PendingRequest::DeleteUntouched) => self.finish_untouched_delete(),
                Some(PendingRequest::SearchSessions { revision, append }) => {
                    match serde_json::from_value::<SessionSearchPage>(result) {
                        Ok(page) => ClientUpdate::shell_event(ShellEvent::SessionSearchResults {
                            revision,
                            append,
                            page,
                        }),
                        Err(error) => ClientUpdate::shell_event(ShellEvent::SessionSearchError {
                            revision,
                            message: format!("search.sessions was invalid: {error}"),
                        }),
                    }
                }
                Some(PendingRequest::WorkspaceInfo { path, generation }) => {
                    match serde_json::from_value::<WorkspaceInfo>(result) {
                        Ok(info) => ClientUpdate::shell_event(ShellEvent::WorkspaceInfo {
                            path,
                            generation,
                            info,
                        }),
                        Err(error) => ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                            path,
                            generation,
                            operation: WorkspaceOperation::Info,
                            message: format!("workspace.info was invalid: {error}"),
                        }),
                    }
                }
                Some(PendingRequest::WorkspaceBranches { path, generation }) => {
                    match serde_json::from_value::<WorkspaceBranchesResult>(result) {
                        Ok(result) => ClientUpdate::shell_event(ShellEvent::WorkspaceBranches {
                            path,
                            generation,
                            branches: result.branches,
                        }),
                        Err(error) => ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                            path,
                            generation,
                            operation: WorkspaceOperation::Branches,
                            message: format!("workspace.branches was invalid: {error}"),
                        }),
                    }
                }
                Some(PendingRequest::WorkspaceSwitch {
                    path,
                    branch,
                    generation,
                }) => match serde_json::from_value::<WorkspaceInfo>(result) {
                    Ok(info) => ClientUpdate::shell_event(ShellEvent::WorkspaceSwitched {
                        path,
                        branch,
                        generation,
                        info,
                    }),
                    Err(error) => ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                        path,
                        generation,
                        operation: WorkspaceOperation::Switch,
                        message: format!("workspace.switchBranch was invalid: {error}"),
                    }),
                },
                Some(PendingRequest::Checkpoints {
                    thread_id,
                    generation,
                }) => match serde_json::from_value::<ThreadCheckpointsResult>(result) {
                    Ok(result) => ClientUpdate::shell_event(ShellEvent::Checkpoints {
                        thread_id,
                        generation,
                        checkpoints: result.checkpoints,
                    }),
                    Err(error) => ClientUpdate::shell_event(ShellEvent::RollbackError {
                        thread_id,
                        generation,
                        operation: RollbackOperation::Checkpoints,
                        message: format!("thread.checkpoints was invalid: {error}"),
                    }),
                },
                Some(PendingRequest::ChangedSince {
                    thread_id,
                    checkpoint_id,
                    generation,
                }) => match serde_json::from_value::<ThreadChangedSinceResult>(result) {
                    Ok(result) => ClientUpdate::shell_event(ShellEvent::ChangedSince {
                        thread_id,
                        checkpoint_id,
                        generation,
                        files: result.files,
                    }),
                    Err(error) => ClientUpdate::shell_event(ShellEvent::RollbackError {
                        thread_id,
                        generation,
                        operation: RollbackOperation::Inspect,
                        message: format!("thread.changedSince was invalid: {error}"),
                    }),
                },
                Some(PendingRequest::Restore {
                    thread_id,
                    checkpoint_id,
                    generation,
                }) => match serde_json::from_value::<ThreadRestoreResult>(result) {
                    Ok(result) => ClientUpdate::shell_event(ShellEvent::CheckpointRestored {
                        thread_id,
                        checkpoint_id,
                        generation,
                        undo: result.undo,
                    }),
                    Err(error) => ClientUpdate::shell_event(ShellEvent::RollbackError {
                        thread_id,
                        generation,
                        operation: RollbackOperation::Restore,
                        message: format!("thread.restore was invalid: {error}"),
                    }),
                },
                Some(PendingRequest::UndoRestore {
                    thread_id,
                    generation,
                }) => ClientUpdate::shell_event(ShellEvent::RestoreUndone {
                    thread_id,
                    generation,
                }),
                Some(PendingRequest::Usage { scope, generation }) => {
                    match serde_json::from_value::<UsageSummaryResult>(result) {
                        Ok(summary) => ClientUpdate::shell_event(ShellEvent::UsageSummary {
                            scope,
                            generation,
                            summary,
                        }),
                        Err(error) => ClientUpdate::shell_event(ShellEvent::UsageError {
                            scope,
                            generation,
                            message: format!("usage.summary was invalid: {error}"),
                        }),
                    }
                }
                Some(PendingRequest::StartThread { request }) => {
                    self.handle_start_thread_response(result, request)
                }
                Some(PendingRequest::ThreadSummaryMutation) => {
                    self.request_projects();
                    ClientUpdate::shell_changed()
                }
                Some(PendingRequest::ThreadLifecycle { thread_id, hide }) => {
                    match serde_json::from_value::<ThreadLifecycleResult>(result) {
                        Ok(result) => {
                            if let Some(session) = self.session_mut(&thread_id) {
                                session.lifecycle = Some(result.lifecycle);
                            } else {
                                self.request_projects();
                            }
                            ClientUpdate {
                                shell_changed: true,
                                chat: Vec::new(),
                                shell_events: hide
                                    .then_some(ShellEvent::ThreadHidden { thread_id })
                                    .into_iter()
                                    .collect(),
                            }
                        }
                        Err(error) => {
                            self.notice =
                                Some(format!("thread lifecycle response was invalid: {error}"));
                            self.request_projects();
                            ClientUpdate::shell_changed()
                        }
                    }
                }
                Some(PendingRequest::ArchiveInspect { thread_id }) => {
                    match serde_json::from_value::<ThreadUnsavedWorkResult>(result) {
                        Ok(work) if work.isolated && work.uncommitted => {
                            ClientUpdate::shell_event(ShellEvent::ArchiveNeedsConfirmation {
                                thread_id,
                            })
                        }
                        Ok(work) if work.isolated => self.begin_archive_close(thread_id, false),
                        Ok(_) => self.begin_archive_delete(thread_id),
                        Err(error) => {
                            self.notice = Some(format!("thread.unsavedWork was invalid: {error}"));
                            ClientUpdate::shell_changed()
                        }
                    }
                }
                Some(PendingRequest::ArchiveClose { thread_id, force }) => {
                    self.begin_archive_discard(thread_id, force)
                }
                Some(PendingRequest::ArchiveDiscard { thread_id }) => {
                    self.begin_archive_delete(thread_id)
                }
                Some(PendingRequest::ArchiveDelete { thread_id }) => {
                    for project in &mut self.projects {
                        project.sessions.retain(|session| session.id != thread_id);
                    }
                    self.request_projects();
                    ClientUpdate::shell_event(ShellEvent::ThreadArchived { thread_id })
                }
                Some(PendingRequest::History { thread_id, replace }) => {
                    match serde_json::from_value::<ThreadHistoryResult>(result) {
                        Ok(history) => ClientUpdate::chat(ChatUpdate::History {
                            thread_id,
                            history,
                            replace,
                        }),
                        Err(error) => ClientUpdate::chat(ChatUpdate::Error {
                            thread_id,
                            message: format!("thread.history was invalid: {error}"),
                        }),
                    }
                }
                Some(PendingRequest::Queue { thread_id }) => {
                    match serde_json::from_value::<ThreadQueueResult>(result) {
                        Ok(queue) => ClientUpdate::chat(ChatUpdate::Queue { thread_id, queue }),
                        Err(error) => ClientUpdate::chat(ChatUpdate::Error {
                            thread_id,
                            message: format!("thread.queue was invalid: {error}"),
                        }),
                    }
                }
                Some(PendingRequest::SendTurn {
                    thread_id,
                    steer,
                    restore_text,
                    restore_attachments,
                    optimistic_queue_id,
                    steer_echo_after_row,
                    started_echo_after_row,
                }) => match serde_json::from_value::<SendTurnResult>(result) {
                    Ok(SendTurnResult::Started {
                        queued: false,
                        turn_id,
                    }) => match started_echo_after_row {
                        Some(echo_after_row) => {
                            ClientUpdate::chat(ChatUpdate::RunningSubmissionStarted {
                                thread_id,
                                turn_id,
                                optimistic_queue_id,
                                text: restore_text,
                                created_at: unix_time_ms(),
                                echo_after_row,
                            })
                        }
                        None => {
                            optimistic_queue_id.map_or_else(ClientUpdate::default, |queue_id| {
                                ClientUpdate::chat(ChatUpdate::QueueSubmissionResolved {
                                    thread_id,
                                    optimistic_queue_id: Some(queue_id),
                                    queued_turn: None,
                                })
                            })
                        }
                    },
                    Ok(SendTurnResult::Queued {
                        queued: true,
                        queued_turn,
                    }) => {
                        if steer {
                            let sent = self.send_request(
                                method::THREAD_STEER_QUEUED_TURN,
                                json!({
                                    "threadId": thread_id,
                                    "queuedTurnId": queued_turn.id.clone()
                                }),
                                PendingRequest::Steer {
                                    thread_id: thread_id.clone(),
                                    echo: steer_echo_after_row.map(|after_row| SteerEcho {
                                        text: queued_turn.text.clone(),
                                        created_at: queued_turn.created_at,
                                        after_row,
                                    }),
                                },
                            );
                            if sent {
                                ClientUpdate::default()
                            } else {
                                ClientUpdate::chat(ChatUpdate::Error {
                                    thread_id,
                                    message: self.request_start_error(
                                        "The queued prompt could not be steered because the server is unavailable.",
                                    ),
                                })
                            }
                        } else {
                            ClientUpdate::chat(ChatUpdate::QueueSubmissionResolved {
                                thread_id,
                                optimistic_queue_id,
                                queued_turn: Some(queued_turn),
                            })
                        }
                    }
                    Ok(_) => ClientUpdate::chat(ChatUpdate::TurnError {
                        thread_id,
                        message: "thread.sendTurn returned a contradictory queue state.".into(),
                        restore_text,
                        restore_attachments,
                        optimistic_queue_id,
                    }),
                    Err(error) => ClientUpdate::chat(ChatUpdate::TurnError {
                        thread_id,
                        message: format!("thread.sendTurn was invalid: {error}"),
                        restore_text,
                        restore_attachments,
                        optimistic_queue_id,
                    }),
                },
                Some(PendingRequest::Diff { thread_id }) => {
                    match serde_json::from_value::<SessionDiff>(result) {
                        Ok(diff) => {
                            ClientUpdate::chat(ChatUpdate::DiffSnapshot { thread_id, diff })
                        }
                        Err(error) => ClientUpdate::chat(ChatUpdate::DiffError {
                            thread_id,
                            message: format!("thread.diff was invalid: {error}"),
                            stale: false,
                        }),
                    }
                }
                Some(PendingRequest::ReviewHunk { thread_id }) => {
                    match serde_json::from_value::<ReviewDiffResult>(result) {
                        Ok(result) => ClientUpdate::chat(ChatUpdate::DiffSnapshot {
                            thread_id,
                            diff: result.diff,
                        }),
                        Err(error) => ClientUpdate::chat(ChatUpdate::DiffError {
                            thread_id,
                            message: format!("thread.reviewHunk was invalid: {error}"),
                            stale: false,
                        }),
                    }
                }
                Some(PendingRequest::TerminalOpen { thread_id }) => {
                    match serde_json::from_value::<TerminalOpenedResult>(result) {
                        Ok(opened) => {
                            self.early_terminal_output.remove(&opened.terminal_id);
                            self.early_terminal_exits.remove(&opened.terminal_id);
                            ClientUpdate::chat(ChatUpdate::TerminalOpened {
                                thread_id,
                                terminal_id: opened.terminal_id,
                            })
                        }
                        Err(error) => ClientUpdate::chat(ChatUpdate::TerminalOpenError {
                            thread_id,
                            message: format!("terminal.open was invalid: {error}"),
                        }),
                    }
                }
                Some(PendingRequest::TerminalClose { terminal_id }) => {
                    if self.settings_terminal_ids.remove(&terminal_id) {
                        ClientUpdate {
                            shell_changed: true,
                            chat: Vec::new(),
                            shell_events: vec![ShellEvent::ProviderTerminalClosed { terminal_id }],
                        }
                    } else {
                        ClientUpdate::default()
                    }
                }
                Some(PendingRequest::Steer {
                    thread_id,
                    echo: Some(echo),
                }) => ClientUpdate::chat(ChatUpdate::SteerAccepted {
                    thread_id,
                    text: echo.text,
                    created_at: echo.created_at,
                    echo_after_row: echo.after_row,
                }),
                Some(PendingRequest::Interrupt { .. })
                | Some(PendingRequest::QueueMutation { .. })
                | Some(PendingRequest::Steer { .. })
                | Some(PendingRequest::RespondApproval { .. })
                | Some(PendingRequest::RespondUserInput { .. })
                | Some(PendingRequest::TerminalInput { .. })
                | Some(PendingRequest::TerminalResize { .. })
                | Some(PendingRequest::RenameThread)
                | Some(PendingRequest::Capabilities)
                | Some(PendingRequest::PreviewCaptureResult)
                | Some(PendingRequest::VoiceCancel)
                | None => ClientUpdate::default(),
            },
        }
    }

    fn handle_aborted_request(&mut self, id: &str) -> ClientUpdate {
        let Some(pending) = self.pending.remove(id) else {
            return ClientUpdate::default();
        };
        if pending.is_catalog_request() {
            self.finish_catalog_request(&pending);
            return ClientUpdate::shell_changed();
        }
        match pending {
            PendingRequest::SystemInfo => ClientUpdate::default(),
            PendingRequest::UpdateCheck => {
                self.update_checking = false;
                self.update_check = Some(failed_update_check(
                    "The server connection was lost during the update check.".into(),
                ));
                ClientUpdate::shell_changed()
            }
            PendingRequest::VoiceStatus { provider } => {
                self.voice_status_pending.remove(&provider);
                self.voice_statuses.insert(
                    provider,
                    VoiceStatusResult {
                        available: false,
                        reason: None,
                    },
                );
                ClientUpdate::shell_changed()
            }
            PendingRequest::VoiceTranscribe { request_id } => {
                ClientUpdate::chat(ChatUpdate::VoiceTranscriptionError {
                    request_id,
                    message: "The server connection was lost during voice transcription.".into(),
                })
            }
            PendingRequest::VoiceCancel | PendingRequest::PreviewCaptureResult => {
                ClientUpdate::default()
            }
            PendingRequest::ProviderTerminal { target, kind } => {
                if self.provider_terminal_busy.as_ref() == Some(&target) {
                    self.provider_terminal_busy = None;
                }
                self.clear_orphaned_provider_terminal_events();
                let message = String::from(
                    "The server connection was lost before the provider terminal opened.",
                );
                self.auth_error = Some(message.clone());
                ClientUpdate {
                    shell_changed: true,
                    chat: Vec::new(),
                    shell_events: vec![ShellEvent::ProviderTerminalError {
                        target: Some(target),
                        kind: Some(kind),
                        terminal_id: None,
                        message,
                    }],
                }
            }
            PendingRequest::AuthStatus { target } => {
                if self.auth_busy.as_ref() == Some(&target) {
                    self.auth_busy = None;
                }
                self.auth_error =
                    Some("The server connection was lost while checking provider sign-in.".into());
                ClientUpdate::shell_changed()
            }
            PendingRequest::AuthStart { .. } | PendingRequest::AuthSignOut { .. } => {
                self.auth_busy = None;
                self.auth_error =
                    Some("The server connection was lost while updating provider sign-in.".into());
                ClientUpdate::shell_changed()
            }
            PendingRequest::ConnectionUpsert { .. }
            | PendingRequest::ConnectionCredential { .. }
            | PendingRequest::ConnectionRemove { .. } => {
                self.connection_busy = None;
                self.connection_error =
                    Some("The server connection was lost while updating API connections.".into());
                ClientUpdate::shell_changed()
            }
            PendingRequest::McpList { .. }
            | PendingRequest::McpMutation { .. }
            | PendingRequest::McpReload { .. }
            | PendingRequest::McpOAuthStart { .. }
            | PendingRequest::McpOAuthCancel { .. } => {
                self.mcp_loading = false;
                self.mcp_busy = None;
                self.clear_orphaned_mcp_oauth_events();
                self.mcp_notice = None;
                self.mcp_error =
                    Some("The server connection was lost while updating MCP settings.".into());
                ClientUpdate::shell_changed()
            }
            PendingRequest::SkillsList { .. }
            | PendingRequest::SkillToggle { .. }
            | PendingRequest::SkillInstall { .. } => {
                self.skills_loading = false;
                self.skills_busy = None;
                self.skills_error =
                    Some("The server connection was lost while updating Agent Skills.".into());
                ClientUpdate::shell_changed()
            }
            PendingRequest::SearchSessions { revision, .. } => {
                ClientUpdate::shell_event(ShellEvent::SessionSearchError {
                    revision,
                    message: "The server connection was lost during search.".into(),
                })
            }
            PendingRequest::WorkspaceInfo { path, generation } => {
                ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                    path,
                    generation,
                    operation: WorkspaceOperation::Info,
                    message: "The server connection was lost while loading workspace status."
                        .into(),
                })
            }
            PendingRequest::WorkspaceBranches { path, generation } => {
                ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                    path,
                    generation,
                    operation: WorkspaceOperation::Branches,
                    message: "The server connection was lost while loading branches.".into(),
                })
            }
            PendingRequest::WorkspaceSwitch {
                path, generation, ..
            } => ClientUpdate::shell_event(ShellEvent::WorkspaceError {
                path,
                generation,
                operation: WorkspaceOperation::Switch,
                message: "The server connection was lost while switching branches.".into(),
            }),
            PendingRequest::Checkpoints {
                thread_id,
                generation,
            } => ClientUpdate::shell_event(ShellEvent::RollbackError {
                thread_id,
                generation,
                operation: RollbackOperation::Checkpoints,
                message: "The server connection was lost while loading checkpoints.".into(),
            }),
            PendingRequest::ChangedSince {
                thread_id,
                generation,
                ..
            } => ClientUpdate::shell_event(ShellEvent::RollbackError {
                thread_id,
                generation,
                operation: RollbackOperation::Inspect,
                message: "The server connection was lost while inspecting the checkpoint.".into(),
            }),
            PendingRequest::Restore {
                thread_id,
                generation,
                ..
            } => ClientUpdate::shell_event(ShellEvent::RollbackError {
                thread_id,
                generation,
                operation: RollbackOperation::Restore,
                message: "The server connection was lost while restoring the checkpoint.".into(),
            }),
            PendingRequest::UndoRestore {
                thread_id,
                generation,
            } => ClientUpdate::shell_event(ShellEvent::RollbackError {
                thread_id,
                generation,
                operation: RollbackOperation::Undo,
                message: "The server connection was lost while undoing the restore.".into(),
            }),
            PendingRequest::Usage { scope, generation } => {
                ClientUpdate::shell_event(ShellEvent::UsageError {
                    scope,
                    generation,
                    message: "The server connection was lost while loading usage.".into(),
                })
            }
            PendingRequest::ProjectMutation { .. }
            | PendingRequest::ThreadSummaryMutation
            | PendingRequest::ThreadLifecycle { .. } => {
                self.notice =
                    Some("The server connection was lost while updating the sidebar.".into());
                ClientUpdate::shell_changed()
            }
            PendingRequest::DeleteUntouched => self.finish_untouched_delete(),
            PendingRequest::ArchiveInspect { thread_id }
            | PendingRequest::ArchiveClose { thread_id, .. }
            | PendingRequest::ArchiveDiscard { thread_id }
            | PendingRequest::ArchiveDelete { thread_id } => {
                self.notice =
                    Some("The server connection was lost while archiving the thread.".into());
                ClientUpdate {
                    shell_changed: true,
                    chat: Vec::new(),
                    shell_events: vec![ShellEvent::ArchiveFailed { thread_id }],
                }
            }
            PendingRequest::StartThread { request } => self.fail_start_thread(
                request,
                "The server connection was lost before the session was created.".into(),
            ),
            PendingRequest::SendTurn {
                thread_id,
                restore_text,
                restore_attachments,
                optimistic_queue_id,
                ..
            } => ClientUpdate::chat(ChatUpdate::TurnError {
                thread_id,
                message: "The server connection was lost before this request completed.".into(),
                restore_text,
                restore_attachments,
                optimistic_queue_id,
            }),
            PendingRequest::RespondApproval {
                thread_id,
                approval_id,
            } => ClientUpdate::chat(ChatUpdate::ApprovalError {
                thread_id,
                approval_id,
                message: "The server connection was lost before this approval completed.".into(),
            }),
            PendingRequest::RespondUserInput {
                thread_id,
                request_id,
            } => ClientUpdate::chat(ChatUpdate::UserInputError {
                thread_id,
                request_id,
                message: "The server connection was lost before these answers were submitted."
                    .into(),
            }),
            PendingRequest::Diff { thread_id } | PendingRequest::ReviewHunk { thread_id } => {
                ClientUpdate::chat(ChatUpdate::DiffError {
                    thread_id,
                    message: "The server connection was lost before the diff request completed."
                        .into(),
                    stale: false,
                })
            }
            PendingRequest::TerminalOpen { thread_id } => {
                ClientUpdate::chat(ChatUpdate::TerminalOpenError {
                    thread_id,
                    message: "The server connection was lost before the terminal opened.".into(),
                })
            }
            PendingRequest::TerminalInput { terminal_id }
            | PendingRequest::TerminalResize { terminal_id }
            | PendingRequest::TerminalClose { terminal_id } => {
                let message = String::from(
                    "The server connection was lost before the terminal request completed.",
                );
                if self.settings_terminal_ids.contains(&terminal_id) {
                    ClientUpdate {
                        shell_changed: true,
                        chat: Vec::new(),
                        shell_events: vec![ShellEvent::ProviderTerminalError {
                            target: None,
                            kind: None,
                            terminal_id: Some(terminal_id),
                            message,
                        }],
                    }
                } else {
                    ClientUpdate::chat(ChatUpdate::TerminalError {
                        terminal_id,
                        message,
                    })
                }
            }
            request => match request.thread_id() {
                Some(thread_id) => ClientUpdate::chat(ChatUpdate::Error {
                    thread_id,
                    message: "The server connection was lost before this request completed.".into(),
                }),
                None => {
                    self.notice = Some("The server connection was lost; refreshing state.".into());
                    ClientUpdate::shell_changed()
                }
            },
        }
    }

    fn handle_projects_response(&mut self, result: Value) -> ClientUpdate {
        match serde_json::from_value::<ProjectsListResult>(result) {
            Ok(result) => {
                self.projects = result.projects;
                self.projects_loaded = true;
                self.notice = None;
            }
            Err(error) => {
                self.notice = Some(format!("projects.list was invalid: {error}"));
            }
        }
        ClientUpdate::shell_changed()
    }

    fn handle_add_project_response(
        &mut self,
        result: Value,
        requested_path: String,
    ) -> ClientUpdate {
        match serde_json::from_value::<ProjectAddedResult>(result) {
            Ok(project) => {
                let path = project.path.clone();
                if let Some(existing) = self
                    .projects
                    .iter_mut()
                    .find(|existing| existing.path == project.path)
                {
                    existing.name = project.name;
                    existing.pinned = project.pinned;
                    existing.created_at = project.created_at;
                } else {
                    self.projects.push(ProjectSummary {
                        path: project.path,
                        name: project.name,
                        pinned: project.pinned,
                        created_at: project.created_at,
                        sessions: Vec::new(),
                    });
                }
                self.projects_loaded = true;
                self.notice = None;
                ClientUpdate::shell_event(ShellEvent::ProjectAdded { path })
            }
            Err(error) => {
                self.notice = Some(format!(
                    "projects.add returned invalid data for {requested_path}: {error}"
                ));
                ClientUpdate::shell_changed()
            }
        }
    }

    fn handle_start_thread_response(
        &mut self,
        result: Value,
        request: NewThreadRequest,
    ) -> ClientUpdate {
        let started = match serde_json::from_value::<ThreadStartResult>(result) {
            Ok(started) => started,
            Err(error) => {
                return self
                    .fail_start_thread(request, format!("thread.start was invalid: {error}"));
            }
        };
        let thread_id = started.thread_id;
        let now = unix_time_ms();
        if let Some(project) = self
            .projects
            .iter_mut()
            .find(|project| project.path == request.project_path)
        {
            let provisional_index = project
                .sessions
                .iter()
                .position(|session| session.id == request.provisional_id)
                .unwrap_or(0);
            project
                .sessions
                .retain(|session| session.id != request.provisional_id && session.id != thread_id);
            project.sessions.insert(
                provisional_index.min(project.sessions.len()),
                SessionSummary {
                    id: thread_id.clone(),
                    title: request.title.clone(),
                    provider: request.choice.provider,
                    agent: request.choice.agent_id.clone(),
                    created_at: now,
                    running: true,
                    pinned: false,
                    status: Some(ThreadInboxStatus::Starting),
                    unread: Some(false),
                    lifecycle: Some(ThreadLifecycle::Active {
                        keep_active: false,
                        woke_at: None,
                    }),
                    closed_at: None,
                    worktree_branch: None,
                },
            );
        }

        self.send_request(
            method::THREAD_RENAME,
            json!({ "threadId": thread_id, "title": request.title }),
            PendingRequest::RenameThread,
        );
        let _ = self.send_turn(
            &thread_id,
            SendTurnRequest {
                text: request.text,
                steer: false,
                attachments: request.attachments,
                model: (!request.choice.model.id.is_empty()).then_some(request.choice.model.id),
                effort: request.effort,
                service_tier: request.service_tier,
                steer_echo_after_row: None,
                started_echo_after_row: None,
            },
            None,
        );
        self.request_projects();
        ClientUpdate::shell_event(ShellEvent::ThreadStarted {
            thread_id,
            project_path: request.project_path,
            title: request.title,
            provider: request.choice.provider,
        })
    }

    fn handle_providers_response(&mut self, result: Value) -> ClientUpdate {
        match serde_json::from_value::<ProvidersListResult>(result) {
            Ok(result) => {
                let providers = result.providers;
                let auth_targets = providers
                    .iter()
                    .filter(|provider| {
                        provider.installed
                            && !matches!(provider.id, ProviderId::Acp | ProviderId::Api)
                    })
                    .map(|provider| AuthTarget::provider(provider.id))
                    .collect::<Vec<_>>();
                for target in auth_targets {
                    self.request_auth_status(target);
                }
                let sources = providers
                    .iter()
                    .filter(|provider| {
                        provider.installed
                            && !matches!(provider.id, ProviderId::Acp | ProviderId::Api)
                    })
                    .enumerate()
                    .map(|(source_index, provider)| ModelSource {
                        key: provider_key(provider.id).into(),
                        provider: provider.id,
                        source_name: provider.display_name.clone(),
                        connection_id: None,
                        agent_id: None,
                        agent_name: None,
                        fallback_model: None,
                        catalog_group: 0,
                        source_index,
                    })
                    .collect::<Vec<_>>();
                self.pending_provider_statuses = providers;
                for source in sources {
                    self.request_models(source, None);
                }
            }
            Err(error) => {
                self.catalog_refresh_failed = true;
                self.notice = Some(format!("providers.list was invalid: {error}"));
            }
        }
        self.finish_catalog_discovery();
        ClientUpdate::shell_changed()
    }

    fn handle_connections_response(&mut self, result: Value) -> ClientUpdate {
        match serde_json::from_value::<ModelConnectionsResult>(result) {
            Ok(result) => {
                self.pending_model_connections = result.connections;
            }
            Err(error) => {
                self.notice = Some(format!("connections.list was invalid: {error}"));
            }
        }
        self.finish_catalog_discovery();
        ClientUpdate::shell_changed()
    }

    fn handle_acp_agents_response(&mut self, result: Value) -> ClientUpdate {
        match serde_json::from_value::<AcpAgentsResult>(result) {
            Ok(result) => {
                self.pending_acp_agents = result.agents;
            }
            Err(error) => {
                self.notice = Some(format!("acp.agents was invalid: {error}"));
            }
        }
        self.finish_catalog_discovery();
        ClientUpdate::shell_changed()
    }

    fn request_models(&mut self, source: ModelSource, params: Option<Value>) {
        let (request_method, params) = match (source.provider, params) {
            (ProviderId::Api, Some(params)) => (method::CONNECTIONS_MODELS, params),
            (_, Some(params)) => (method::MODELS_LIST, params),
            (provider, None) => (
                method::MODELS_LIST,
                json!({ "provider": provider_key(provider) }),
            ),
        };
        if self.send_request(request_method, params, PendingRequest::Models { source }) {
            self.catalog_model_pending += 1;
        }
    }

    fn handle_models_response(&mut self, result: Value, source: ModelSource) -> ClientUpdate {
        match serde_json::from_value::<ModelsListResult>(result) {
            Ok(result) => {
                let models = if result.models.is_empty() {
                    source.fallback_model.clone().into_iter().collect()
                } else {
                    result.models
                };
                self.pending_model_catalog
                    .extend(models.into_iter().enumerate().map(|(model_index, model)| {
                        ModelChoice {
                            key: format!("{}\u{1f}{}", source.key, model.id),
                            provider: source.provider,
                            source_name: source.source_name.clone(),
                            connection_id: source.connection_id.clone(),
                            agent_id: source.agent_id.clone(),
                            agent_name: source.agent_name.clone(),
                            model,
                            catalog_order: (source.catalog_group, source.source_index, model_index),
                        }
                    }));
            }
            Err(error) => {
                self.notice = Some(format!("models.list was invalid: {error}"));
            }
        }
        self.catalog_model_pending = self.catalog_model_pending.saturating_sub(1);
        self.update_catalog_loaded();
        ClientUpdate::shell_changed()
    }

    fn finish_catalog_discovery(&mut self) {
        self.catalog_discovery_pending = self.catalog_discovery_pending.saturating_sub(1);
        self.update_catalog_loaded();
    }

    fn finish_catalog_request(&mut self, request: &PendingRequest) {
        match request {
            PendingRequest::Providers => {
                self.catalog_refresh_failed = true;
                self.finish_catalog_discovery()
            }
            PendingRequest::Connections | PendingRequest::AcpAgents => {
                self.finish_catalog_discovery()
            }
            PendingRequest::Models { .. } => {
                self.catalog_model_pending = self.catalog_model_pending.saturating_sub(1);
                self.update_catalog_loaded();
            }
            _ => {}
        }
    }

    fn handle_connection_upsert_response(
        &mut self,
        result: Value,
        connection_id: String,
        api_key: String,
    ) -> ClientUpdate {
        match serde_json::from_value::<ModelConnectionResult>(result) {
            Ok(result) => {
                self.model_connections
                    .retain(|connection| connection.id != result.connection.id);
                self.model_connections.push(result.connection);
            }
            Err(error) => {
                self.connection_busy = None;
                self.connection_error = Some(format!("connections.upsert was invalid: {error}"));
                return ClientUpdate::shell_changed();
            }
        }
        if api_key.trim().is_empty() {
            self.connection_busy = None;
            self.refresh_model_catalog();
            return ClientUpdate::shell_changed();
        }
        if !self.send_request(
            method::CONNECTIONS_SET_CREDENTIAL,
            json!({ "connectionId": connection_id, "apiKey": api_key }),
            PendingRequest::ConnectionCredential { connection_id },
        ) {
            self.connection_busy = None;
        }
        ClientUpdate::shell_changed()
    }

    fn handle_connection_credential_response(
        &mut self,
        result: Value,
        connection_id: String,
    ) -> ClientUpdate {
        match serde_json::from_value::<CredentialConfiguredResult>(result) {
            Ok(result) if result.credential_configured => {
                self.connection_busy = None;
                self.connection_error = None;
                self.refresh_model_catalog();
            }
            Ok(_) => {
                self.connection_busy = None;
                self.connection_error =
                    Some("The credential store did not confirm the API key.".into());
            }
            Err(error) => {
                self.connection_busy = None;
                self.connection_error = Some(format!(
                    "connections.setCredential was invalid for {connection_id}: {error}"
                ));
            }
        }
        ClientUpdate::shell_changed()
    }

    fn handle_connection_remove_response(&mut self, connection_id: String) -> ClientUpdate {
        self.connection_busy = None;
        self.connection_error = None;
        self.model_connections
            .retain(|connection| connection.id != connection_id);
        self.refresh_model_catalog();
        ClientUpdate::shell_changed()
    }

    fn handle_auth_status_response(&mut self, result: Value, target: AuthTarget) -> ClientUpdate {
        self.voice_statuses.remove(&target.provider);
        match serde_json::from_value::<Account>(result) {
            Ok(account) => {
                let refresh_catalog = self.auth_busy.as_ref() == Some(&target);
                if account.signed_in {
                    self.auth_logins.remove(&target);
                    self.clear_early_auth_events(&target);
                }
                self.accounts.insert(target.clone(), account);
                if refresh_catalog {
                    self.auth_busy = None;
                    self.refresh_model_catalog();
                }
                self.auth_error = None;
            }
            Err(error) => {
                if self.auth_busy.as_ref() == Some(&target) {
                    self.auth_busy = None;
                }
                self.auth_error = Some(format!("auth.status was invalid: {error}"));
            }
        }
        ClientUpdate::shell_changed()
    }

    fn handle_auth_start_response(&mut self, result: Value, target: AuthTarget) -> ClientUpdate {
        match serde_json::from_value::<AuthStartLoginResult>(result) {
            Ok(result)
                if !result.login_id.trim().is_empty()
                    && result.auth_url.as_deref().is_none_or(is_http_url) =>
            {
                if let Some(push) = self.early_auth_events.remove(&result.login_id) {
                    return self.finish_auth_event(push);
                }
                self.auth_logins.insert(
                    target.clone(),
                    AuthLoginSession {
                        login_id: result.login_id,
                    },
                );
                self.auth_busy = Some(target);
                self.auth_error = None;
                ClientUpdate {
                    shell_changed: true,
                    chat: Vec::new(),
                    shell_events: result
                        .auth_url
                        .map(|url| ShellEvent::OpenUrl { url })
                        .into_iter()
                        .collect(),
                }
            }
            Ok(_) => {
                self.auth_busy = None;
                self.auth_error =
                    Some("auth.startLogin returned an invalid login ID or browser URL.".into());
                ClientUpdate::shell_changed()
            }
            Err(error) => {
                self.auth_busy = None;
                self.auth_error = Some(format!("auth.startLogin was invalid: {error}"));
                ClientUpdate::shell_changed()
            }
        }
    }

    fn handle_auth_event(&mut self, push: AuthEventPush) -> ClientUpdate {
        let target = AuthTarget {
            provider: push.provider,
            agent: push.agent.clone(),
        };
        if let Some(login_id) = push.login_id.as_ref() {
            if let Some(session) = self.auth_logins.get(&target) {
                if session.login_id != *login_id {
                    return ClientUpdate::default();
                }
                self.auth_logins.remove(&target);
            } else if self.pending.values().any(|pending| {
                matches!(pending, PendingRequest::AuthStart { target: pending_target }
                    if pending_target == &target)
            }) {
                if self.early_auth_events.len() >= 16
                    && let Some(oldest) = self.early_auth_events.keys().next().cloned()
                {
                    self.early_auth_events.remove(&oldest);
                }
                self.early_auth_events.insert(login_id.clone(), push);
                return ClientUpdate::default();
            }
        } else {
            self.auth_logins.remove(&target);
        }
        self.finish_auth_event(push)
    }

    fn finish_auth_event(&mut self, push: AuthEventPush) -> ClientUpdate {
        let target = AuthTarget {
            provider: push.provider,
            agent: push.agent,
        };
        if push.success {
            self.auth_busy = Some(target.clone());
            self.auth_error = None;
            self.request_auth_status(target);
        } else {
            if self.auth_busy.as_ref() == Some(&target) {
                self.auth_busy = None;
            }
            self.auth_error = Some(
                push.error
                    .unwrap_or_else(|| "Provider sign-in was cancelled.".into()),
            );
        }
        ClientUpdate::shell_changed()
    }

    fn clear_early_auth_events(&mut self, target: &AuthTarget) {
        self.early_auth_events.retain(|_, push| {
            push.provider != target.provider || push.agent.as_ref() != target.agent.as_ref()
        });
    }

    fn handle_auth_sign_out_response(&mut self, target: AuthTarget) -> ClientUpdate {
        self.voice_statuses.remove(&target.provider);
        self.auth_logins.remove(&target);
        self.clear_early_auth_events(&target);
        self.accounts.insert(
            target.clone(),
            Account {
                signed_in: false,
                email: None,
                plan: None,
            },
        );
        if self.auth_busy.as_ref() == Some(&target) {
            self.auth_busy = None;
        }
        self.auth_error = None;
        self.refresh_model_catalog();
        ClientUpdate::shell_changed()
    }

    fn handle_provider_terminal_response(
        &mut self,
        result: Value,
        target: AuthTarget,
        kind: ProviderTerminalKind,
    ) -> ClientUpdate {
        match serde_json::from_value::<TerminalOpenedResult>(result) {
            Ok(opened) => {
                self.provider_terminal_busy = None;
                self.settings_terminal_ids
                    .insert(opened.terminal_id.clone());
                let buffered_output = self.early_terminal_output.take(&opened.terminal_id);
                let early_exit = self.early_terminal_exits.remove(&opened.terminal_id);
                self.clear_orphaned_provider_terminal_events();
                ClientUpdate {
                    shell_changed: true,
                    chat: Vec::new(),
                    shell_events: vec![ShellEvent::ProviderTerminalOpened {
                        target,
                        kind,
                        terminal_id: opened.terminal_id,
                        buffered_output,
                        early_exit,
                    }],
                }
            }
            Err(error) => {
                self.provider_terminal_busy = None;
                let message = format!("Provider terminal response was invalid: {error}");
                self.auth_error = Some(message.clone());
                ClientUpdate {
                    shell_changed: true,
                    chat: Vec::new(),
                    shell_events: vec![ShellEvent::ProviderTerminalError {
                        target: Some(target),
                        kind: Some(kind),
                        terminal_id: None,
                        message,
                    }],
                }
            }
        }
    }

    fn update_catalog_loaded(&mut self) {
        if self.catalog_discovery_pending != 0 || self.catalog_model_pending != 0 {
            return;
        }
        if self.catalog_refresh_failed {
            self.pending_provider_statuses.clear();
            self.pending_model_connections.clear();
            self.pending_acp_agents.clear();
            self.pending_model_catalog.clear();
            return;
        }
        self.pending_model_catalog
            .sort_by_key(|choice| choice.catalog_order);
        self.provider_statuses = std::mem::take(&mut self.pending_provider_statuses);
        self.model_connections = std::mem::take(&mut self.pending_model_connections);
        self.acp_agents = std::mem::take(&mut self.pending_acp_agents);
        self.model_catalog = std::mem::take(&mut self.pending_model_catalog);
        self.model_catalog_loaded = true;
        self.completed_catalog_snapshot_pending = true;
    }

    fn clear_orphaned_provider_terminal_events(&mut self) {
        if self
            .pending
            .values()
            .any(|pending| matches!(pending, PendingRequest::ProviderTerminal { .. }))
        {
            return;
        }
        self.early_terminal_output.clear();
        self.early_terminal_exits.clear();
    }

    fn handle_settings_response(&mut self, result: Value) -> ClientUpdate {
        match serde_json::from_value::<SidebarSettings>(result) {
            Ok(settings) => self.sidebar_settings = settings,
            Err(error) => {
                self.notice = Some(format!("sidebar.settings was invalid: {error}"));
            }
        }
        ClientUpdate::shell_changed()
    }

    fn handle_mcp_response(
        &mut self,
        result: Value,
        provider: ProviderId,
        project_path: String,
        generation: u64,
    ) -> ClientUpdate {
        if self.mcp_scope.as_ref() != Some(&(provider, project_path.clone()))
            || self.mcp_generation != generation
        {
            return ClientUpdate::default();
        }
        self.mcp_loading = false;
        match serde_json::from_value::<McpListResult>(result) {
            Ok(result) => {
                self.mcp_inventory = Some(ScopedMcpInventory {
                    provider,
                    project_path,
                    result,
                });
                self.mcp_error = None;
            }
            Err(error) => {
                self.mcp_error = Some(format!("mcp.list was invalid: {error}"));
            }
        }
        ClientUpdate::shell_changed()
    }

    fn finish_mcp_mutation(
        &mut self,
        provider: ProviderId,
        project_path: String,
        success_message: String,
    ) -> ClientUpdate {
        if self.mcp_scope.as_ref() != Some(&(provider, project_path.clone())) {
            return ClientUpdate::default();
        }
        self.mcp_busy = None;
        self.mcp_notice = Some(success_message.clone());
        let reload = self
            .mcp_inventory
            .as_ref()
            .is_some_and(|inventory| inventory.result.capabilities.reload);
        if reload {
            self.mcp_loading = true;
            if !self.send_request(
                method::MCP_RELOAD,
                json!({ "provider": provider, "projectPath": project_path }),
                PendingRequest::McpReload {
                    provider,
                    project_path,
                    success_message,
                },
            ) {
                self.mcp_loading = false;
                self.mcp_error = self.notice.clone().or_else(|| {
                    Some("The MCP server was saved, but reload could not start.".into())
                });
            }
            ClientUpdate::shell_changed()
        } else {
            self.request_mcp_inventory(provider, project_path)
        }
    }

    fn finish_mcp_reload(
        &mut self,
        provider: ProviderId,
        project_path: String,
        success_message: String,
    ) -> ClientUpdate {
        if self.mcp_scope.as_ref() != Some(&(provider, project_path.clone())) {
            return ClientUpdate::default();
        }
        self.mcp_notice = Some(format!("{success_message} Active sessions reloaded."));
        self.request_mcp_inventory(provider, project_path)
    }

    fn handle_mcp_oauth_start_response(
        &mut self,
        result: Value,
        provider: ProviderId,
        project_path: String,
        server_id: String,
    ) -> ClientUpdate {
        self.mcp_busy = None;
        match serde_json::from_value::<McpOAuthStartResult>(result) {
            Ok(result) if !result.login_id.trim().is_empty() && is_http_url(&result.auth_url) => {
                if let Some(push) = self.early_mcp_oauth.remove(&result.login_id) {
                    return self.finish_mcp_oauth(push);
                }
                self.mcp_oauth = Some(McpOAuthSession {
                    provider,
                    project_path,
                    server_id,
                    login_id: result.login_id,
                });
                self.mcp_error = None;
                self.mcp_notice = Some("Finish signing in in your browser.".into());
                ClientUpdate::shell_event(ShellEvent::OpenUrl {
                    url: result.auth_url,
                })
            }
            Ok(_) => {
                self.clear_orphaned_mcp_oauth_events();
                self.mcp_error = Some("The MCP server returned an unsafe sign-in URL.".into());
                ClientUpdate::shell_changed()
            }
            Err(error) => {
                self.clear_orphaned_mcp_oauth_events();
                self.mcp_error = Some(format!("mcp.startOAuth was invalid: {error}"));
                ClientUpdate::shell_changed()
            }
        }
    }

    fn handle_mcp_oauth_cancel_response(
        &mut self,
        provider: ProviderId,
        project_path: String,
        server_id: String,
    ) -> ClientUpdate {
        self.mcp_busy = None;
        if self.mcp_oauth.as_ref().is_some_and(|session| {
            session.provider == provider
                && session.project_path == project_path
                && session.server_id == server_id
        }) {
            self.mcp_oauth = None;
        }
        self.mcp_error = None;
        self.mcp_notice = Some("MCP sign-in cancelled.".into());
        ClientUpdate::shell_changed()
    }

    fn handle_mcp_oauth_push(&mut self, push: McpOAuthPush) -> ClientUpdate {
        let owns_login = self.mcp_oauth.as_ref().is_some_and(|session| {
            session.provider == push.provider
                && session.project_path == push.project_path
                && session.server_id == push.server_id
                && session.login_id == push.login_id
        });
        let pending_start = self.pending.values().any(|pending| {
            matches!(
                pending,
                PendingRequest::McpOAuthStart {
                    provider,
                    project_path,
                    server_id,
                } if *provider == push.provider
                    && *project_path == push.project_path
                    && *server_id == push.server_id
            )
        });
        if !owns_login && pending_start {
            if self.early_mcp_oauth.len() >= 8
                && !self.early_mcp_oauth.contains_key(&push.login_id)
                && let Some(oldest) = self.early_mcp_oauth.keys().next().cloned()
            {
                self.early_mcp_oauth.remove(&oldest);
            }
            self.early_mcp_oauth.insert(push.login_id.clone(), push);
            return ClientUpdate::default();
        }
        self.finish_mcp_oauth(push)
    }

    fn finish_mcp_oauth(&mut self, push: McpOAuthPush) -> ClientUpdate {
        let in_scope = self.mcp_scope.as_ref() == Some(&(push.provider, push.project_path.clone()));
        if self.mcp_oauth.as_ref().is_some_and(|session| {
            session.provider == push.provider
                && session.project_path == push.project_path
                && session.server_id == push.server_id
                && session.login_id == push.login_id
        }) {
            self.mcp_oauth = None;
        }
        if self.mcp_busy.as_deref() == Some(push.server_id.as_str()) {
            self.mcp_busy = None;
        }
        if !in_scope {
            return ClientUpdate::default();
        }
        if push.success {
            self.mcp_error = None;
            self.mcp_notice = Some("MCP sign-in completed.".into());
            self.request_mcp_inventory(push.provider, push.project_path)
        } else {
            self.mcp_notice = None;
            self.mcp_error = Some(push.error.unwrap_or_else(|| "MCP sign-in failed.".into()));
            ClientUpdate::shell_changed()
        }
    }

    fn clear_orphaned_mcp_oauth_events(&mut self) {
        if !self
            .pending
            .values()
            .any(|pending| matches!(pending, PendingRequest::McpOAuthStart { .. }))
        {
            self.early_mcp_oauth.clear();
        }
    }

    fn handle_skills_response(
        &mut self,
        result: Value,
        provider: ProviderId,
        project_path: String,
        generation: u64,
    ) -> ClientUpdate {
        if self.skills_scope.as_ref() != Some(&(provider, project_path.clone()))
            || self.skills_generation != generation
        {
            return ClientUpdate::default();
        }
        self.skills_loading = false;
        match serde_json::from_value::<SkillsListResult>(result) {
            Ok(result) => {
                self.skills_inventory = Some(ScopedSkillsInventory {
                    provider,
                    project_path,
                    result,
                });
                self.skills_error = None;
            }
            Err(error) => {
                self.skills_error = Some(format!("skills.list was invalid: {error}"));
            }
        }
        ClientUpdate::shell_changed()
    }

    fn handle_skill_toggle_response(
        &mut self,
        result: Value,
        provider: ProviderId,
        project_path: String,
        skill_id: String,
    ) -> ClientUpdate {
        if self.skills_scope.as_ref() != Some(&(provider, project_path.clone())) {
            return ClientUpdate::default();
        }
        self.skills_busy = None;
        match serde_json::from_value::<SkillEnabledResult>(result) {
            Ok(result) => {
                if let Some(inventory) = &mut self.skills_inventory
                    && inventory.provider == provider
                    && inventory.project_path == project_path
                    && let Some(skill) = inventory
                        .result
                        .skills
                        .iter_mut()
                        .find(|skill| skill.id == skill_id)
                {
                    skill.enabled = result.enabled;
                }
                self.skills_error = None;
            }
            Err(error) => {
                self.skills_error = Some(format!("skills.setEnabled was invalid: {error}"));
            }
        }
        ClientUpdate::shell_changed()
    }

    fn handle_skill_install_response(
        &mut self,
        result: Value,
        provider: ProviderId,
        project_path: String,
    ) -> ClientUpdate {
        if self.skills_scope.as_ref() != Some(&(provider, project_path.clone())) {
            return ClientUpdate::default();
        }
        self.skills_busy = None;
        match serde_json::from_value::<SkillInstalledResult>(result) {
            Ok(result) => {
                if let Some(inventory) = &mut self.skills_inventory
                    && inventory.provider == provider
                    && inventory.project_path == project_path
                {
                    inventory
                        .result
                        .skills
                        .retain(|skill| skill.id != result.skill.id);
                    inventory.result.skills.push(result.skill);
                } else {
                    return self.request_skills_inventory(provider, project_path);
                }
                self.skills_error = None;
            }
            Err(error) => {
                self.skills_error = Some(format!("skills.installFromFolder was invalid: {error}"));
            }
        }
        ClientUpdate::shell_changed()
    }

    fn handle_push(&mut self, channel_name: &str, data: Value) -> ClientUpdate {
        match channel_name {
            channel::SERVER_WELCOME => self.handle_welcome(data),
            channel::PREVIEW_CAPTURE_REQUESTED => {
                match serde_json::from_value::<PreviewCaptureRequest>(data) {
                    Ok(request)
                        if self.preview_capture_available
                            && crate::preview_capture::validate_request(&request).is_ok() =>
                    {
                        ClientUpdate {
                            shell_changed: false,
                            chat: Vec::new(),
                            shell_events: vec![ShellEvent::PreviewCaptureRequested(request)],
                        }
                    }
                    Ok(_) | Err(_) => ClientUpdate::default(),
                }
            }
            channel::AUTH_EVENT => match serde_json::from_value::<AuthEventPush>(data) {
                Ok(push) => self.handle_auth_event(push),
                Err(error) => {
                    self.auth_busy = None;
                    self.auth_error = Some(format!("auth.event push was invalid: {error}"));
                    ClientUpdate::shell_changed()
                }
            },
            channel::SIDEBAR_SETTINGS => {
                match serde_json::from_value::<SidebarSettings>(data) {
                    Ok(settings) => self.sidebar_settings = settings,
                    Err(error) => {
                        self.notice = Some(format!("sidebar.settings push was invalid: {error}"));
                    }
                }
                ClientUpdate::shell_changed()
            }
            channel::MCP_OAUTH => match serde_json::from_value::<McpOAuthPush>(data) {
                Ok(push) => self.handle_mcp_oauth_push(push),
                Err(error) => {
                    self.mcp_busy = None;
                    self.mcp_error = Some(format!("mcp.oauth push was invalid: {error}"));
                    ClientUpdate::shell_changed()
                }
            },
            channel::MCP_CHANGED => match serde_json::from_value::<ProviderProjectPush>(data) {
                Ok(push)
                    if self.mcp_scope.as_ref()
                        == Some(&(push.provider, push.project_path.clone())) =>
                {
                    self.request_mcp_inventory(push.provider, push.project_path)
                }
                Ok(_) => ClientUpdate::default(),
                Err(error) => {
                    self.mcp_error = Some(format!("mcp.changed push was invalid: {error}"));
                    ClientUpdate::shell_changed()
                }
            },
            channel::SKILLS_CHANGED => match serde_json::from_value::<ProviderProjectPush>(data) {
                Ok(push)
                    if self.skills_scope.as_ref()
                        == Some(&(push.provider, push.project_path.clone())) =>
                {
                    self.request_skills_inventory(push.provider, push.project_path)
                }
                Ok(_) => ClientUpdate::default(),
                Err(error) => {
                    self.skills_error = Some(format!("skills.changed push was invalid: {error}"));
                    ClientUpdate::shell_changed()
                }
            },
            channel::THREAD_LIFECYCLE => {
                match serde_json::from_value::<ThreadLifecyclePush>(data) {
                    Ok(push) => {
                        if let Some(session) = self.session_mut(&push.thread_id) {
                            session.lifecycle = Some(push.lifecycle);
                        } else {
                            self.request_projects();
                        }
                    }
                    Err(error) => {
                        self.notice = Some(format!("thread.lifecycle push was invalid: {error}"));
                    }
                }
                ClientUpdate::shell_changed()
            }
            channel::THREAD_EVENT => self.handle_thread_event(data),
            channel::THREAD_QUEUE => match serde_json::from_value::<ThreadQueuePush>(data) {
                Ok(push) => ClientUpdate::chat(ChatUpdate::Queue {
                    thread_id: push.thread_id,
                    queue: ThreadQueueResult {
                        items: push.items,
                        can_steer: push.can_steer,
                    },
                }),
                Err(error) => {
                    self.notice = Some(format!("thread.queue push was invalid: {error}"));
                    ClientUpdate::shell_changed()
                }
            },
            channel::TERMINAL_OUTPUT => {
                match serde_json::from_value::<TerminalOutputPush>(data) {
                    Ok(push) if self.settings_terminal_ids.contains(&push.terminal_id) => {
                        ClientUpdate {
                            shell_changed: false,
                            chat: Vec::new(),
                            shell_events: vec![ShellEvent::ProviderTerminalOutput(push)],
                        }
                    }
                    Ok(push) => {
                        if self.pending.values().any(|pending| {
                            matches!(pending, PendingRequest::ProviderTerminal { .. })
                        }) {
                            self.early_terminal_output
                                .push(push.terminal_id.clone(), push.data.clone());
                        }
                        ClientUpdate::chat(ChatUpdate::TerminalOutput(push))
                    }
                    Err(error) => {
                        self.notice = Some(format!("terminal.output push was invalid: {error}"));
                        ClientUpdate::shell_changed()
                    }
                }
            }
            channel::TERMINAL_EXIT => match serde_json::from_value::<TerminalExitPush>(data) {
                Ok(push) if self.settings_terminal_ids.remove(&push.terminal_id) => ClientUpdate {
                    shell_changed: true,
                    chat: Vec::new(),
                    shell_events: vec![ShellEvent::ProviderTerminalExit(push)],
                },
                Ok(push) => {
                    if self
                        .pending
                        .values()
                        .any(|pending| matches!(pending, PendingRequest::ProviderTerminal { .. }))
                    {
                        if self.early_terminal_exits.len() >= EARLY_TERMINAL_EXIT_LIMIT
                            && !self.early_terminal_exits.contains_key(&push.terminal_id)
                            && let Some(oldest) = self.early_terminal_exits.keys().next().cloned()
                        {
                            self.early_terminal_exits.remove(&oldest);
                        }
                        self.early_terminal_exits
                            .insert(push.terminal_id.clone(), push.exit_code);
                    }
                    ClientUpdate::chat(ChatUpdate::TerminalExit(push))
                }
                Err(error) => {
                    self.notice = Some(format!("terminal.exit push was invalid: {error}"));
                    ClientUpdate::shell_changed()
                }
            },
            _ => ClientUpdate::default(),
        }
    }

    fn handle_welcome(&mut self, data: Value) -> ClientUpdate {
        match serde_json::from_value::<ServerWelcome>(data) {
            Ok(welcome) if welcome.protocol_version == PROTOCOL_VERSION => ClientUpdate::default(),
            Ok(welcome) => {
                self.notice = Some(format!(
                    "Protocol mismatch: native client expects v{PROTOCOL_VERSION}, server sent v{}.",
                    welcome.protocol_version
                ));
                ClientUpdate::shell_changed()
            }
            Err(error) => {
                self.notice = Some(format!("server.welcome was invalid: {error}"));
                ClientUpdate::shell_changed()
            }
        }
    }

    fn handle_thread_event(&mut self, data: Value) -> ClientUpdate {
        let Ok(push) = serde_json::from_value::<ThreadEventPush>(data) else {
            self.notice = Some("thread.event push was invalid.".into());
            return ClientUpdate::shell_changed();
        };
        let shell_changed = self.apply_session_status(&push);
        ClientUpdate {
            shell_changed,
            chat: vec![ChatUpdate::Event(push)],
            shell_events: Vec::new(),
        }
    }

    fn apply_session_status(&mut self, push: &ThreadEventPush) -> bool {
        let (running, status) = match &push.event {
            DomainEvent::TurnStarted { .. } => (Some(true), Some(ThreadInboxStatus::Working)),
            DomainEvent::TurnCompleted { .. } => (Some(false), Some(ThreadInboxStatus::Ready)),
            DomainEvent::ThreadError { .. } => (Some(false), Some(ThreadInboxStatus::Failed)),
            DomainEvent::ApprovalRequested { .. } => (None, Some(ThreadInboxStatus::Approval)),
            DomainEvent::UserInputRequested { .. } => (None, Some(ThreadInboxStatus::Input)),
            DomainEvent::ApprovalResolved { .. } | DomainEvent::UserInputResolved { .. } => {
                let running = self
                    .session(&push.thread_id)
                    .is_some_and(|session| session.running);
                (
                    None,
                    Some(if running {
                        ThreadInboxStatus::Working
                    } else {
                        ThreadInboxStatus::Ready
                    }),
                )
            }
            DomainEvent::ThreadStarted { .. } => {
                self.request_projects();
                return true;
            }
            DomainEvent::ItemStarted { .. }
            | DomainEvent::ItemDelta { .. }
            | DomainEvent::ItemCompleted { .. }
            | DomainEvent::PlanUpdated { .. }
            | DomainEvent::UsageUpdated { .. }
            | DomainEvent::DiffUpdated { .. }
            | DomainEvent::ApprovalReviewStarted { .. }
            | DomainEvent::ApprovalReviewCompleted { .. } => return false,
        };

        if let Some(session) = self.session_mut(&push.thread_id) {
            if let Some(running) = running {
                session.running = running;
            }
            session.status = status;
        } else {
            self.request_projects();
        }
        true
    }

    fn session(&self, thread_id: &str) -> Option<&harness_protocol::SessionSummary> {
        self.projects
            .iter()
            .flat_map(|project| project.sessions.iter())
            .find(|session| session.id == thread_id)
    }

    fn session_mut(&mut self, thread_id: &str) -> Option<&mut harness_protocol::SessionSummary> {
        self.projects
            .iter_mut()
            .flat_map(|project| project.sessions.iter_mut())
            .find(|session| session.id == thread_id)
    }

    fn remove_session(&mut self, thread_id: &str) {
        for project in &mut self.projects {
            project.sessions.retain(|session| session.id != thread_id);
        }
    }
}

impl PendingRequest {
    fn is_catalog_request(&self) -> bool {
        matches!(
            self,
            Self::Providers | Self::Connections | Self::AcpAgents | Self::Models { .. }
        )
    }

    fn thread_id(self) -> Option<String> {
        match self {
            Self::History { thread_id, .. }
            | Self::Queue { thread_id }
            | Self::QueueMutation { thread_id }
            | Self::SendTurn { thread_id, .. }
            | Self::Steer { thread_id, .. }
            | Self::Interrupt { thread_id }
            | Self::RespondApproval { thread_id, .. }
            | Self::RespondUserInput { thread_id, .. }
            | Self::Diff { thread_id }
            | Self::ReviewHunk { thread_id }
            | Self::ThreadLifecycle { thread_id, .. }
            | Self::ArchiveInspect { thread_id }
            | Self::ArchiveClose { thread_id, .. }
            | Self::ArchiveDiscard { thread_id }
            | Self::ArchiveDelete { thread_id }
            | Self::Checkpoints { thread_id, .. }
            | Self::ChangedSince { thread_id, .. }
            | Self::Restore { thread_id, .. }
            | Self::UndoRestore { thread_id, .. }
            | Self::TerminalOpen { thread_id } => Some(thread_id),
            Self::Capabilities
            | Self::PreviewCaptureResult
            | Self::SystemInfo
            | Self::UpdateCheck
            | Self::VoiceStatus { .. }
            | Self::VoiceTranscribe { .. }
            | Self::VoiceCancel
            | Self::Projects
            | Self::SidebarSettings
            | Self::UpdateSidebarSettings
            | Self::AddProject { .. }
            | Self::ProjectMutation { .. }
            | Self::DeleteUntouched
            | Self::SearchSessions { .. }
            | Self::WorkspaceInfo { .. }
            | Self::WorkspaceBranches { .. }
            | Self::WorkspaceSwitch { .. }
            | Self::Usage { .. }
            | Self::StartThread { .. }
            | Self::RenameThread
            | Self::ThreadSummaryMutation
            | Self::Providers
            | Self::Connections
            | Self::ConnectionUpsert { .. }
            | Self::ConnectionCredential { .. }
            | Self::ConnectionRemove { .. }
            | Self::AuthStatus { .. }
            | Self::AuthStart { .. }
            | Self::AuthSignOut { .. }
            | Self::ProviderTerminal { .. }
            | Self::AcpAgents
            | Self::Models { .. }
            | Self::McpList { .. }
            | Self::McpMutation { .. }
            | Self::McpReload { .. }
            | Self::McpOAuthStart { .. }
            | Self::McpOAuthCancel { .. }
            | Self::SkillsList { .. }
            | Self::SkillToggle { .. }
            | Self::SkillInstall { .. }
            | Self::TerminalInput { .. }
            | Self::TerminalResize { .. }
            | Self::TerminalClose { .. } => None,
        }
    }
}

fn failed_update_check(message: String) -> UpdateCheckResult {
    UpdateCheckResult {
        local_commit: None,
        remote: None,
        up_to_date: None,
        error: Some(message),
    }
}

fn unix_time_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_millis() as f64)
}

fn bounded_utf8_tail(value: String, maximum: usize) -> String {
    let mut start = value.len().saturating_sub(maximum);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_owned()
}

fn send_turn_params(thread_id: &str, request: SendTurnRequest) -> Value {
    let mut params = serde_json::Map::from_iter([
        ("threadId".into(), json!(thread_id)),
        ("text".into(), json!(request.text)),
    ]);
    if !request.attachments.is_empty() {
        params.insert("attachments".into(), json!(request.attachments));
    }
    if let Some(model) = request.model {
        params.insert("model".into(), json!(model));
    }
    if let Some(effort) = request.effort {
        params.insert("effort".into(), json!(effort));
    }
    if let Some(service_tier) = request.service_tier {
        params.insert("serviceTier".into(), json!(service_tier));
    }
    Value::Object(params)
}

fn queue_mutation_params(
    thread_id: &str,
    queued_turn_id: &str,
    direction: Option<QueueDirection>,
) -> Value {
    let mut params = serde_json::Map::from_iter([
        ("threadId".into(), json!(thread_id)),
        ("queuedTurnId".into(), json!(queued_turn_id)),
    ]);
    if let Some(direction) = direction {
        params.insert("direction".into(), json!(direction));
    }
    Value::Object(params)
}

fn provider_key(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Codex => "codex",
        ProviderId::ClaudeCode => "claude-code",
        ProviderId::Grok => "grok",
        ProviderId::Cursor => "cursor",
        ProviderId::OpenCode => "opencode",
        ProviderId::Antigravity => "antigravity",
        ProviderId::Acp => "acp",
        ProviderId::Api => "api",
    }
}

fn auth_params(target: &AuthTarget) -> Value {
    let mut params = serde_json::Map::from_iter([(
        "provider".into(),
        serde_json::to_value(target.provider).expect("provider ids always serialize"),
    )]);
    if let Some(agent) = &target.agent {
        params.insert("agent".into(), Value::String(agent.clone()));
    }
    Value::Object(params)
}

fn is_http_url(value: &str) -> bool {
    url::Url::parse(value)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_protocol::{PreviewViewport, Push};
    use serde_json::json;

    fn model_choice(id: &str) -> ModelChoice {
        ModelChoice {
            key: format!("codex\u{1f}{id}"),
            provider: ProviderId::Codex,
            source_name: "Codex".into(),
            connection_id: None,
            agent_id: None,
            agent_name: None,
            model: Model {
                id: id.into(),
                display_name: id.into(),
                description: None,
                is_default: true,
                reasoning_efforts: vec!["low".into(), "high".into()],
                default_reasoning_effort: Some("high".into()),
                service_tiers: Vec::new(),
                default_service_tier: None,
            },
            catalog_order: (0, 0, 0),
        }
    }

    fn new_thread_request(provisional_id: &str) -> NewThreadRequest {
        NewThreadRequest {
            provisional_id: provisional_id.into(),
            project_path: "/workspace".into(),
            text: "Build it".into(),
            title: "Build it".into(),
            attachments: Vec::new(),
            choice: model_choice("gpt-test"),
            effort: Some("high".into()),
            service_tier: None,
            approval: ApprovalMode::Ask,
            isolate: false,
        }
    }

    fn provisional_session(id: &str) -> SessionSummary {
        SessionSummary {
            id: id.into(),
            title: "Build it".into(),
            provider: ProviderId::Codex,
            agent: None,
            created_at: 1.0,
            running: true,
            pinned: false,
            status: Some(ThreadInboxStatus::Starting),
            unread: Some(false),
            lifecycle: Some(ThreadLifecycle::Active {
                keep_active: false,
                woke_at: None,
            }),
            closed_at: None,
            worktree_branch: None,
        }
    }

    fn sidebar_session(id: &str, title: &str) -> SessionSummary {
        let mut session = provisional_session(id);
        session.title = title.into();
        session.running = false;
        session.status = Some(ThreadInboxStatus::Idle);
        session
    }

    #[test]
    fn streamed_delta_routes_to_chat_without_invalidating_the_shell() {
        let mut state = ClientState::new(true);
        let update = state.handle_event(ClientEvent::Push(Push {
            channel: channel::THREAD_EVENT.into(),
            sequence: 1,
            data: json!({
                "threadId": "thread-1",
                "event": {
                    "type": "item.delta",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "textDelta": "hello"
                },
                "seq": 4
            }),
        }));

        assert!(!update.shell_changed);
        assert_eq!(update.chat.len(), 1);
        assert!(matches!(update.chat[0], ChatUpdate::Event(_)));
    }

    #[test]
    fn projects_response_replaces_the_snapshot() {
        let mut state = ClientState::new(true);
        state
            .pending
            .insert("native-1".into(), PendingRequest::Projects);

        let update = state.handle_response(Response::Success {
            id: "native-1".into(),
            result: json!({
                "projects": [{
                    "path": "/workspace",
                    "name": "TasteCode",
                    "pinned": true,
                    "createdAt": 1,
                    "sessions": []
                }]
            }),
        });
        assert!(update.shell_changed);
        assert!(state.projects_loaded);
        assert_eq!(state.projects[0].name, "TasteCode");
    }

    #[test]
    fn new_draft_removes_only_untouched_sessions_in_its_project() {
        let mut state = ClientState::new(true);
        state.projects = vec![
            ProjectSummary {
                path: "/workspace".into(),
                name: "TasteCode".into(),
                pinned: false,
                created_at: 1.0,
                sessions: vec![
                    sidebar_session("empty-1", "New session"),
                    sidebar_session("kept", "Keep this work"),
                    sidebar_session("empty-2", "New session"),
                ],
            },
            ProjectSummary {
                path: "/other".into(),
                name: "Other".into(),
                pinned: false,
                created_at: 2.0,
                sessions: vec![sidebar_session("other-empty", "New session")],
            },
        ];

        assert!(state.delete_untouched_sessions("/workspace"));
        assert_eq!(state.projects[0].sessions.len(), 1);
        assert_eq!(state.projects[0].sessions[0].id, "kept");
        assert_eq!(state.projects[1].sessions[0].id, "other-empty");
        assert!(!state.delete_untouched_sessions("/missing"));
    }

    #[test]
    fn search_response_keeps_revision_pagination_and_highlights() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "native-search".into(),
            PendingRequest::SearchSessions {
                revision: 7,
                append: true,
            },
        );

        let update = state.handle_response(Response::Success {
            id: "native-search".into(),
            result: json!({
                "results": [{
                    "projectPath": "/workspace",
                    "projectName": "TasteCode",
                    "threadId": "thread-1",
                    "threadTitle": "Queue controls",
                    "turnId": "turn-2",
                    "provider": "codex",
                    "createdAt": 1_000,
                    "snippet": [
                        {"text": "queue ", "highlighted": false},
                        {"text": "controls", "highlighted": true}
                    ]
                }],
                "nextCursor": "cursor-2"
            }),
        });

        assert!(matches!(
            update.shell_events.as_slice(),
            [ShellEvent::SessionSearchResults {
                revision: 7,
                append: true,
                page,
            }] if page.next_cursor.as_deref() == Some("cursor-2")
                && page.results[0].snippet[1].highlighted
        ));
    }

    #[test]
    fn lifecycle_response_updates_the_sidebar_and_marks_hidden_selection() {
        let mut state = ClientState::new(true);
        state.projects = serde_json::from_value::<ProjectsListResult>(json!({
            "projects": [{
                "path": "/workspace",
                "name": "TasteCode",
                "pinned": false,
                "createdAt": 1,
                "sessions": [{
                    "id": "thread-1",
                    "title": "Native sidebar",
                    "provider": "codex",
                    "createdAt": 2,
                    "running": false,
                    "lifecycle": { "state": "active", "keepActive": false }
                }]
            }]
        }))
        .unwrap()
        .projects;
        state.pending.insert(
            "settle-1".into(),
            PendingRequest::ThreadLifecycle {
                thread_id: "thread-1".into(),
                hide: true,
            },
        );

        let update = state.handle_response(Response::Success {
            id: "settle-1".into(),
            result: json!({
                "lifecycle": {
                    "state": "settled",
                    "settledAt": 3,
                    "reason": "manual"
                }
            }),
        });

        assert!(matches!(
            state.projects[0].sessions[0].lifecycle,
            Some(ThreadLifecycle::Settled { settled_at: 3, .. })
        ));
        assert!(matches!(
            update.shell_events.as_slice(),
            [ShellEvent::ThreadHidden { thread_id }] if thread_id == "thread-1"
        ));
    }

    #[test]
    fn removing_a_project_notifies_the_shell_after_server_confirmation() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "remove-1".into(),
            PendingRequest::ProjectMutation {
                removed_path: Some("/workspace".into()),
            },
        );

        let update = state.handle_response(Response::Success {
            id: "remove-1".into(),
            result: json!({}),
        });

        assert!(matches!(
            update.shell_events.as_slice(),
            [ShellEvent::ProjectRemoved { path }] if path == "/workspace"
        ));
    }

    #[test]
    fn dirty_isolated_archive_requires_confirmation_before_deletion() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "archive-inspect".into(),
            PendingRequest::ArchiveInspect {
                thread_id: "thread-1".into(),
            },
        );

        let update = state.handle_response(Response::Success {
            id: "archive-inspect".into(),
            result: json!({ "isolated": true, "uncommitted": true }),
        });

        assert!(matches!(
            update.shell_events.as_slice(),
            [ShellEvent::ArchiveNeedsConfirmation { thread_id }] if thread_id == "thread-1"
        ));
    }

    #[test]
    fn failed_archive_releases_the_confirmation_busy_state() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "archive-discard".into(),
            PendingRequest::ArchiveDiscard {
                thread_id: "thread-1".into(),
            },
        );

        let update = state.handle_response(Response::Failure {
            id: "archive-discard".into(),
            error: harness_protocol::WireError {
                code: ErrorCode::BadRequest,
                message: "The checkout could not be discarded".into(),
                detail: None,
            },
        });

        assert!(matches!(
            update.shell_events.as_slice(),
            [ShellEvent::ArchiveFailed { thread_id }] if thread_id == "thread-1"
        ));
        assert_eq!(
            state.notice.as_deref(),
            Some("The checkout could not be discarded")
        );
    }

    #[test]
    fn interrupted_archive_releases_the_confirmation_busy_state() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "archive-delete".into(),
            PendingRequest::ArchiveDelete {
                thread_id: "thread-1".into(),
            },
        );

        let update = state.handle_aborted_request("archive-delete");

        assert!(matches!(
            update.shell_events.as_slice(),
            [ShellEvent::ArchiveFailed { thread_id }] if thread_id == "thread-1"
        ));
        assert_eq!(
            state.notice.as_deref(),
            Some("The server connection was lost while archiving the thread.")
        );
    }

    #[test]
    fn completed_archive_removes_the_sidebar_row() {
        let mut state = ClientState::new(true);
        state.projects = serde_json::from_value::<ProjectsListResult>(json!({
            "projects": [{
                "path": "/workspace",
                "name": "TasteCode",
                "pinned": false,
                "createdAt": 1,
                "sessions": [{
                    "id": "thread-1",
                    "title": "Native sidebar",
                    "provider": "codex",
                    "createdAt": 2,
                    "running": false
                }]
            }]
        }))
        .unwrap()
        .projects;
        state.pending.insert(
            "archive-delete".into(),
            PendingRequest::ArchiveDelete {
                thread_id: "thread-1".into(),
            },
        );

        let update = state.handle_response(Response::Success {
            id: "archive-delete".into(),
            result: json!({}),
        });

        assert!(state.projects[0].sessions.is_empty());
        assert!(matches!(
            update.shell_events.as_slice(),
            [ShellEvent::ThreadArchived { thread_id }] if thread_id == "thread-1"
        ));
    }

    #[test]
    fn workspace_responses_keep_the_requested_scope_and_generation() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "workspace-info".into(),
            PendingRequest::WorkspaceInfo {
                path: "/workspace".into(),
                generation: 7,
            },
        );
        state.pending.insert(
            "workspace-branches".into(),
            PendingRequest::WorkspaceBranches {
                path: "/workspace".into(),
                generation: 7,
            },
        );
        state.pending.insert(
            "workspace-switch".into(),
            PendingRequest::WorkspaceSwitch {
                path: "/workspace".into(),
                branch: "feature/native".into(),
                generation: 8,
            },
        );

        let info = state.handle_response(Response::Success {
            id: "workspace-info".into(),
            result: json!({ "branch": "main", "added": 3, "removed": 1, "dirtyFiles": 2 }),
        });
        let branches = state.handle_response(Response::Success {
            id: "workspace-branches".into(),
            result: json!({ "branches": ["main", "feature/native"] }),
        });
        let switched = state.handle_response(Response::Success {
            id: "workspace-switch".into(),
            result: json!({
                "branch": "feature/native",
                "added": 0,
                "removed": 0,
                "dirtyFiles": 0
            }),
        });

        assert!(matches!(
            info.shell_events.as_slice(),
            [ShellEvent::WorkspaceInfo { path, generation: 7, info }]
                if path == "/workspace" && info.branch.as_deref() == Some("main")
        ));
        assert!(matches!(
            branches.shell_events.as_slice(),
            [ShellEvent::WorkspaceBranches { path, generation: 7, branches }]
                if path == "/workspace" && branches == &["main", "feature/native"]
        ));
        assert!(matches!(
            switched.shell_events.as_slice(),
            [ShellEvent::WorkspaceSwitched {
                path,
                branch,
                generation: 8,
                info,
            }] if path == "/workspace"
                && branch == "feature/native"
                && info.branch.as_deref() == Some("feature/native")
        ));
    }

    #[test]
    fn rollback_responses_keep_thread_checkpoint_and_undo_identity() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "checkpoints".into(),
            PendingRequest::Checkpoints {
                thread_id: "thread-1".into(),
                generation: 4,
            },
        );
        state.pending.insert(
            "changed-since".into(),
            PendingRequest::ChangedSince {
                thread_id: "thread-1".into(),
                checkpoint_id: 11,
                generation: 5,
            },
        );
        state.pending.insert(
            "restore".into(),
            PendingRequest::Restore {
                thread_id: "thread-1".into(),
                checkpoint_id: 11,
                generation: 5,
            },
        );
        state.pending.insert(
            "undo".into(),
            PendingRequest::UndoRestore {
                thread_id: "thread-1".into(),
                generation: 6,
            },
        );

        let checkpoints = state.handle_response(Response::Success {
            id: "checkpoints".into(),
            result: json!({
                "checkpoints": [{
                    "id": 11,
                    "seq": 20,
                    "label": "change header",
                    "createdAt": 1_786_000_000_000_f64
                }]
            }),
        });
        let changed = state.handle_response(Response::Success {
            id: "changed-since".into(),
            result: json!({ "files": ["src/app.rs"] }),
        });
        let restored = state.handle_response(Response::Success {
            id: "restore".into(),
            result: json!({ "undo": "restore-token" }),
        });
        let undone = state.handle_response(Response::Success {
            id: "undo".into(),
            result: json!({}),
        });

        assert!(matches!(
            checkpoints.shell_events.as_slice(),
            [ShellEvent::Checkpoints { thread_id, generation: 4, checkpoints }]
                if thread_id == "thread-1" && checkpoints[0].id == 11
        ));
        assert!(matches!(
            changed.shell_events.as_slice(),
            [ShellEvent::ChangedSince {
                thread_id,
                checkpoint_id: 11,
                generation: 5,
                files,
            }] if thread_id == "thread-1" && files == &["src/app.rs"]
        ));
        assert!(matches!(
            restored.shell_events.as_slice(),
            [ShellEvent::CheckpointRestored {
                thread_id,
                checkpoint_id: 11,
                generation: 5,
                undo,
            }] if thread_id == "thread-1" && undo == "restore-token"
        ));
        assert!(matches!(
            undone.shell_events.as_slice(),
            [ShellEvent::RestoreUndone { thread_id, generation: 6 }]
                if thread_id == "thread-1"
        ));
    }

    #[test]
    fn usage_responses_reach_the_native_shell() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "usage".into(),
            PendingRequest::Usage {
                scope: UsageScope::Thread("thread-1".into()),
                generation: 9,
            },
        );
        let usage = state.handle_response(Response::Success {
            id: "usage".into(),
            result: json!({
                "session": {
                    "inputTokens": 10,
                    "cachedInputTokens": 2,
                    "outputTokens": 3,
                    "reasoningTokens": 1,
                    "totalTokens": 16,
                    "costUsd": 0.01
                },
                "today": {
                    "inputTokens": 20,
                    "cachedInputTokens": 4,
                    "outputTokens": 6,
                    "reasoningTokens": 2,
                    "totalTokens": 32,
                    "costUsd": 0.02
                },
                "limits": [{ "label": "Weekly", "usedPercent": 37.5 }]
            }),
        });
        assert!(matches!(
            usage.shell_events.as_slice(),
            [ShellEvent::UsageSummary {
                scope: UsageScope::Thread(thread_id),
                generation: 9,
                summary,
            }] if thread_id == "thread-1"
                && summary.limits[0].label == "Weekly"
                && summary.limits[0].used_percent == 37.5
        ));
    }

    #[test]
    fn system_metadata_and_update_checks_are_retained_for_about_settings() {
        let mut state = ClientState::new(true);
        state
            .pending
            .insert("native-info".into(), PendingRequest::SystemInfo);
        state
            .pending
            .insert("native-update".into(), PendingRequest::UpdateCheck);
        state.update_checking = true;

        state.handle_response(Response::Success {
            id: "native-info".into(),
            result: json!({
                "serverVersion": "0.0.0",
                "protocolVersion": 2,
                "platform": "darwin"
            }),
        });
        let update = state.handle_response(Response::Success {
            id: "native-update".into(),
            result: json!({
                "localCommit": "1111111",
                "remote": {
                    "sha": "2222222",
                    "message": "Latest change",
                    "date": "2026-08-06T12:00:00Z"
                },
                "upToDate": false
            }),
        });

        assert!(update.shell_changed);
        assert!(!state.update_checking);
        assert_eq!(state.system_info.unwrap().protocol_version, 2);
        assert_eq!(state.update_check.unwrap().remote.unwrap().sha, "2222222");
    }

    #[test]
    fn voice_capability_and_transcript_responses_keep_the_request_identity() {
        let mut state = ClientState::new(true);
        state.voice_status_pending.insert(ProviderId::Codex);
        state.pending.insert(
            "voice-status".into(),
            PendingRequest::VoiceStatus {
                provider: ProviderId::Codex,
            },
        );
        state.pending.insert(
            "voice-transcribe".into(),
            PendingRequest::VoiceTranscribe {
                request_id: "3a7c0fb4-222e-471a-97de-f062ad676df4".into(),
            },
        );

        let status = state.handle_response(Response::Success {
            id: "voice-status".into(),
            result: json!({ "available": true }),
        });
        let transcript = state.handle_response(Response::Success {
            id: "voice-transcribe".into(),
            result: json!({ "text": "spoken words" }),
        });

        assert!(status.shell_changed);
        assert!(state.voice_statuses[&ProviderId::Codex].available);
        assert!(matches!(
            transcript.chat.as_slice(),
            [ChatUpdate::VoiceTranscribed { request_id, text }]
                if request_id == "3a7c0fb4-222e-471a-97de-f062ad676df4"
                    && text == "spoken words"
        ));
    }

    #[test]
    fn model_response_builds_a_provider_owned_choice() {
        let mut state = ClientState::new(true);
        state.model_catalog_loaded = false;
        state.catalog_model_pending = 1;
        state.pending.insert(
            "native-model".into(),
            PendingRequest::Models {
                source: ModelSource {
                    key: "codex".into(),
                    provider: ProviderId::Codex,
                    source_name: "Codex".into(),
                    connection_id: None,
                    agent_id: None,
                    agent_name: None,
                    fallback_model: None,
                    catalog_group: 0,
                    source_index: 0,
                },
            },
        );

        let update = state.handle_response(Response::Success {
            id: "native-model".into(),
            result: json!({
                "models": [{
                    "id": "gpt-test",
                    "displayName": "GPT Test",
                    "isDefault": true,
                    "reasoningEfforts": ["low", "high"],
                    "serviceTiers": []
                }]
            }),
        });

        assert!(update.shell_changed);
        assert!(state.model_catalog_loaded);
        assert_eq!(state.model_catalog[0].provider, ProviderId::Codex);
        assert_eq!(state.model_catalog[0].model.id, "gpt-test");
    }

    #[test]
    fn model_refresh_keeps_the_previous_catalog_until_every_source_finishes() {
        let mut state = ClientState::new(true);
        state.model_catalog = vec![model_choice("cached")];
        state.catalog_model_pending = 2;
        for (request_id, source_index) in [("model-one", 0), ("model-two", 1)] {
            state.pending.insert(
                request_id.into(),
                PendingRequest::Models {
                    source: ModelSource {
                        key: "codex".into(),
                        provider: ProviderId::Codex,
                        source_name: "Codex".into(),
                        connection_id: None,
                        agent_id: None,
                        agent_name: None,
                        fallback_model: None,
                        catalog_group: 0,
                        source_index,
                    },
                },
            );
        }

        state.handle_response(Response::Success {
            id: "model-one".into(),
            result: json!({ "models": [{
                "id": "fresh-one",
                "displayName": "Fresh One",
                "isDefault": true,
                "reasoningEfforts": [],
                "serviceTiers": []
            }] }),
        });
        assert_eq!(state.model_catalog[0].model.id, "cached");

        state.handle_response(Response::Success {
            id: "model-two".into(),
            result: json!({ "models": [{
                "id": "fresh-two",
                "displayName": "Fresh Two",
                "isDefault": false,
                "reasoningEfforts": [],
                "serviceTiers": []
            }] }),
        });
        assert_eq!(
            state
                .model_catalog
                .iter()
                .map(|choice| choice.model.id.as_str())
                .collect::<Vec<_>>(),
            ["fresh-one", "fresh-two"]
        );
        assert_eq!(
            state.take_completed_model_catalog_snapshot().unwrap().len(),
            2
        );
        assert!(state.take_completed_model_catalog_snapshot().is_none());
    }

    #[test]
    fn failed_provider_refresh_keeps_the_last_complete_catalog() {
        let mut state = ClientState::new(true);
        state.model_catalog = vec![model_choice("cached")];
        state.catalog_discovery_pending = 1;
        state
            .pending
            .insert("providers".into(), PendingRequest::Providers);

        state.handle_aborted_request("providers");

        assert!(state.model_catalog_loaded);
        assert_eq!(state.model_catalog[0].model.id, "cached");
        assert!(state.pending_model_catalog.is_empty());
        assert!(state.take_completed_model_catalog_snapshot().is_none());
    }

    #[test]
    fn starting_a_thread_promotes_the_draft_and_adds_the_sidebar_row() {
        let mut state = ClientState::new(true);
        state.projects.push(ProjectSummary {
            path: "/workspace".into(),
            name: "TasteCode".into(),
            pinned: false,
            created_at: 1.0,
            sessions: vec![provisional_session("pending:native-start")],
        });
        state.pending.insert(
            "native-start".into(),
            PendingRequest::StartThread {
                request: new_thread_request("pending:native-start"),
            },
        );

        let update = state.handle_response(Response::Success {
            id: "native-start".into(),
            result: json!({ "threadId": "thread-1" }),
        });

        assert!(matches!(
            update.shell_events.as_slice(),
            [ShellEvent::ThreadStarted { thread_id, .. }] if thread_id == "thread-1"
        ));
        assert_eq!(state.projects[0].sessions.len(), 1);
        assert_eq!(state.projects[0].sessions[0].id, "thread-1");
        assert_eq!(
            state.projects[0].sessions[0].status,
            Some(ThreadInboxStatus::Starting)
        );
    }

    #[test]
    fn failed_thread_start_removes_the_provisional_sidebar_row() {
        let mut state = ClientState::new(true);
        state.projects.push(ProjectSummary {
            path: "/workspace".into(),
            name: "TasteCode".into(),
            pinned: false,
            created_at: 1.0,
            sessions: vec![provisional_session("pending:native-start")],
        });
        state.pending.insert(
            "native-start".into(),
            PendingRequest::StartThread {
                request: new_thread_request("pending:native-start"),
            },
        );

        let update = state.handle_response(Response::Failure {
            id: "native-start".into(),
            error: harness_protocol::WireError {
                code: ErrorCode::BadRequest,
                message: "The project cannot be opened".into(),
                detail: None,
            },
        });

        assert!(update.shell_changed);
        assert!(state.projects[0].sessions.is_empty());
        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::DraftError { message, restore_text, .. }]
                if message == "The project cannot be opened" && restore_text == "Build it"
        ));
    }

    #[test]
    fn unavailable_server_never_leaves_a_provisional_sidebar_row() {
        let mut state = ClientState::new(true);
        state.projects.push(ProjectSummary {
            path: "/workspace".into(),
            name: "TasteCode".into(),
            pinned: false,
            created_at: 1.0,
            sessions: Vec::new(),
        });

        let update = state.start_thread(new_thread_request("pending:native-start"));

        assert!(update.shell_changed);
        assert!(state.projects[0].sessions.is_empty());
        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::DraftError { message, .. }]
                if message == "The session could not be started because the server is unavailable."
        ));
    }

    #[test]
    fn turn_params_preserve_design_model_effort_and_fast_tier() {
        let params = send_turn_params(
            "thread-1",
            SendTurnRequest {
                text: "Design it".into(),
                steer: false,
                attachments: vec!["personal-harness://design-brief-v1".into()],
                model: Some("gpt-test".into()),
                effort: Some("high".into()),
                service_tier: Some("priority".into()),
                steer_echo_after_row: None,
                started_echo_after_row: None,
            },
        );

        assert_eq!(
            params,
            json!({
                "threadId": "thread-1",
                "text": "Design it",
                "attachments": ["personal-harness://design-brief-v1"],
                "model": "gpt-test",
                "effort": "high",
                "serviceTier": "priority"
            })
        );
    }

    #[test]
    fn unavailable_server_restores_an_existing_chat_submission() {
        let mut state = ClientState::new(true);

        let update = state.send_turn(
            "thread-1",
            SendTurnRequest {
                text: "Try again".into(),
                steer: false,
                attachments: vec!["reference.png".into()],
                model: Some("gpt-test".into()),
                effort: Some("high".into()),
                service_tier: None,
                steer_echo_after_row: None,
                started_echo_after_row: None,
            },
            None,
        );

        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::TurnError {
                thread_id,
                restore_text,
                restore_attachments,
                ..
            }] if thread_id == "thread-1"
                && restore_text == "Try again"
                && restore_attachments == &["reference.png"]
        ));
    }

    #[test]
    fn queued_send_response_replaces_the_matching_optimistic_row() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "native-send".into(),
            PendingRequest::SendTurn {
                thread_id: "thread-1".into(),
                steer: false,
                restore_text: "Queue this next".into(),
                restore_attachments: Vec::new(),
                optimistic_queue_id: Some("pending:1".into()),
                steer_echo_after_row: None,
                started_echo_after_row: None,
            },
        );

        let update = state.handle_response(Response::Success {
            id: "native-send".into(),
            result: json!({
                "queued": true,
                "queuedTurn": {
                    "id": "queued-1",
                    "text": "Queue this next",
                    "attachments": [],
                    "createdAt": 1
                }
            }),
        });

        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::QueueSubmissionResolved {
                thread_id,
                optimistic_queue_id: Some(optimistic_queue_id),
                queued_turn: Some(queued_turn),
            }] if thread_id == "thread-1"
                && optimistic_queue_id == "pending:1"
                && queued_turn.id == "queued-1"
        ));
    }

    #[test]
    fn running_send_that_starts_immediately_echoes_the_returned_turn() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "native-send".into(),
            PendingRequest::SendTurn {
                thread_id: "thread-1".into(),
                steer: false,
                restore_text: "Start this next".into(),
                restore_attachments: Vec::new(),
                optimistic_queue_id: Some("pending:1".into()),
                steer_echo_after_row: None,
                started_echo_after_row: Some(7),
            },
        );

        let update = state.handle_response(Response::Success {
            id: "native-send".into(),
            result: json!({
                "queued": false,
                "turnId": "turn-2"
            }),
        });

        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::RunningSubmissionStarted {
                thread_id,
                turn_id,
                optimistic_queue_id: Some(optimistic_queue_id),
                text,
                created_at,
                echo_after_row,
            }] if thread_id == "thread-1"
                && turn_id == "turn-2"
                && optimistic_queue_id == "pending:1"
                && text == "Start this next"
                && *created_at > 0.0
                && *echo_after_row == 7
        ));
    }

    #[test]
    fn steer_acknowledgement_carries_the_missing_local_echo() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "native-steer".into(),
            PendingRequest::Steer {
                thread_id: "thread-1".into(),
                echo: Some(SteerEcho {
                    text: "Use this direction now".into(),
                    created_at: 42.0,
                    after_row: 3,
                }),
            },
        );

        let update = state.handle_response(Response::Success {
            id: "native-steer".into(),
            result: json!({}),
        });

        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::SteerAccepted {
                thread_id,
                text,
                created_at,
                echo_after_row,
            }] if thread_id == "thread-1"
                && text == "Use this direction now"
                && *created_at == 42.0
                && *echo_after_row == 3
        ));
    }

    #[test]
    fn queue_mutation_params_match_delete_move_and_steer_contracts() {
        assert_eq!(
            queue_mutation_params("thread-1", "queued-1", None),
            json!({
                "threadId": "thread-1",
                "queuedTurnId": "queued-1"
            })
        );
        assert_eq!(
            queue_mutation_params("thread-1", "queued-2", Some(QueueDirection::Down)),
            json!({
                "threadId": "thread-1",
                "queuedTurnId": "queued-2",
                "direction": "down"
            })
        );
    }

    #[test]
    fn failed_structured_response_identifies_the_card_to_restore() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "native-approval".into(),
            PendingRequest::RespondApproval {
                thread_id: "thread-1".into(),
                approval_id: "approval-1".into(),
            },
        );

        let update = state.handle_response(Response::Failure {
            id: "native-approval".into(),
            error: harness_protocol::WireError {
                code: harness_protocol::ErrorCode::BadRequest,
                message: "That approval is no longer pending".into(),
                detail: None,
            },
        });

        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::ApprovalError {
                thread_id,
                approval_id,
                message,
            }] if thread_id == "thread-1"
                && approval_id == "approval-1"
                && message == "That approval is no longer pending"
        ));
    }

    #[test]
    fn diff_response_is_decoded_for_the_selected_chat() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "native-diff".into(),
            PendingRequest::Diff {
                thread_id: "thread-1".into(),
            },
        );

        let update = state.handle_response(Response::Success {
            id: "native-diff".into(),
            result: json!({
                "threadId": "thread-1",
                "version": "snapshot-1",
                "files": []
            }),
        });

        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::DiffSnapshot { thread_id, diff }]
                if thread_id == "thread-1" && diff.version == "snapshot-1"
        ));
    }

    #[test]
    fn stale_hunk_decision_requests_an_authoritative_refresh() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "native-review".into(),
            PendingRequest::ReviewHunk {
                thread_id: "thread-1".into(),
            },
        );

        let update = state.handle_response(Response::Failure {
            id: "native-review".into(),
            error: harness_protocol::WireError {
                code: ErrorCode::StaleSnapshot,
                message: "Refresh the diff and try again.".into(),
                detail: None,
            },
        });

        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::DiffError {
                thread_id,
                stale: true,
                ..
            }] if thread_id == "thread-1"
        ));
    }

    #[test]
    fn terminal_open_response_keeps_the_owning_thread() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "native-terminal".into(),
            PendingRequest::TerminalOpen {
                thread_id: "thread-1".into(),
            },
        );

        let update = state.handle_response(Response::Success {
            id: "native-terminal".into(),
            result: json!({ "terminalId": "terminal-1" }),
        });

        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::TerminalOpened {
                thread_id,
                terminal_id,
            }] if thread_id == "thread-1" && terminal_id == "terminal-1"
        ));
    }

    #[test]
    fn terminal_output_routes_without_invalidating_the_shell() {
        let mut state = ClientState::new(true);
        let update = state.handle_push(
            channel::TERMINAL_OUTPUT,
            json!({ "terminalId": "terminal-1", "data": "hello" }),
        );

        assert!(!update.shell_changed);
        assert!(matches!(
            update.chat.as_slice(),
            [ChatUpdate::TerminalOutput(push)]
                if push.terminal_id == "terminal-1" && push.data == "hello"
        ));
    }

    #[test]
    fn provider_terminal_replays_output_that_arrives_before_the_open_response() {
        let mut state = ClientState::new(true);
        let target = AuthTarget::provider(ProviderId::OpenCode);
        state.pending.insert(
            "provider-install".into(),
            PendingRequest::ProviderTerminal {
                target: target.clone(),
                kind: ProviderTerminalKind::Install,
            },
        );

        let early = state.handle_push(
            channel::TERMINAL_OUTPUT,
            json!({ "terminalId": "install-1", "data": "Downloading…" }),
        );
        assert!(matches!(
            early.chat.as_slice(),
            [ChatUpdate::TerminalOutput(push)] if push.terminal_id == "install-1"
        ));

        let opened = state.handle_response(Response::Success {
            id: "provider-install".into(),
            result: json!({ "terminalId": "install-1" }),
        });
        assert!(matches!(
            opened.shell_events.as_slice(),
            [ShellEvent::ProviderTerminalOpened {
                target: opened_target,
                kind: ProviderTerminalKind::Install,
                terminal_id,
                buffered_output,
                early_exit: None,
            }] if opened_target == &target
                && terminal_id == "install-1"
                && buffered_output == &["Downloading…"]
        ));

        let live = state.handle_push(
            channel::TERMINAL_OUTPUT,
            json!({ "terminalId": "install-1", "data": "Done" }),
        );
        assert!(!live.shell_changed);
        assert!(matches!(
            live.shell_events.as_slice(),
            [ShellEvent::ProviderTerminalOutput(push)]
                if push.terminal_id == "install-1" && push.data == "Done"
        ));

        let exit = state.handle_push(
            channel::TERMINAL_EXIT,
            json!({ "terminalId": "install-1", "exitCode": 0 }),
        );
        assert!(matches!(
            exit.shell_events.as_slice(),
            [ShellEvent::ProviderTerminalExit(push)]
                if push.terminal_id == "install-1" && push.exit_code == Some(0)
        ));
    }

    #[test]
    fn provider_terminal_preserves_an_exit_that_wins_the_open_race() {
        let mut state = ClientState::new(true);
        let target = AuthTarget::agent(ProviderId::Acp, "gemini".into());
        state.pending.insert(
            "provider-login".into(),
            PendingRequest::ProviderTerminal {
                target,
                kind: ProviderTerminalKind::SignIn,
            },
        );
        state.handle_push(
            channel::TERMINAL_EXIT,
            json!({ "terminalId": "login-1", "exitCode": 7 }),
        );

        let opened = state.handle_response(Response::Success {
            id: "provider-login".into(),
            result: json!({ "terminalId": "login-1" }),
        });
        assert!(matches!(
            opened.shell_events.as_slice(),
            [ShellEvent::ProviderTerminalOpened {
                kind: ProviderTerminalKind::SignIn,
                early_exit: Some(Some(7)),
                ..
            }]
        ));
    }

    #[test]
    fn stale_mcp_inventory_cannot_replace_a_newer_refresh() {
        let mut state = ClientState::new(true);
        state.mcp_scope = Some((ProviderId::Codex, "project".into()));
        state.mcp_generation = 2;

        let stale = state.handle_mcp_response(
            json!({
                "capabilities": {
                    "inventory": true,
                    "add": true,
                    "update": true,
                    "remove": true,
                    "reload": true,
                    "startOAuth": true,
                    "cancelOAuth": true
                },
                "servers": []
            }),
            ProviderId::Codex,
            "project".into(),
            1,
        );

        assert!(!stale.shell_changed);
        assert!(state.mcp_inventory.is_none());

        let current = state.handle_mcp_response(
            json!({
                "capabilities": {
                    "inventory": true,
                    "add": false,
                    "update": false,
                    "remove": false,
                    "reload": false,
                    "startOAuth": false,
                    "cancelOAuth": false
                },
                "servers": []
            }),
            ProviderId::Codex,
            "project".into(),
            2,
        );

        assert!(current.shell_changed);
        assert!(state.mcp_inventory.is_some());
    }

    #[test]
    fn mcp_oauth_opens_only_a_valid_http_url_and_refreshes_on_completion() {
        let mut state = ClientState::new(true);
        state.mcp_scope = Some((ProviderId::Codex, "/project".into()));
        state.mcp_busy = Some("docs".into());
        state.pending.insert(
            "mcp-login".into(),
            PendingRequest::McpOAuthStart {
                provider: ProviderId::Codex,
                project_path: "/project".into(),
                server_id: "docs".into(),
            },
        );

        let started = state.handle_response(Response::Success {
            id: "mcp-login".into(),
            result: json!({
                "loginId": "login-1",
                "authUrl": "https://example.com/oauth"
            }),
        });
        assert!(matches!(
            started.shell_events.as_slice(),
            [ShellEvent::OpenUrl { url }] if url == "https://example.com/oauth"
        ));
        assert_eq!(
            state
                .mcp_oauth
                .as_ref()
                .map(|session| session.login_id.as_str()),
            Some("login-1")
        );

        let finished = state.handle_push(
            channel::MCP_OAUTH,
            json!({
                "provider": "codex",
                "projectPath": "/project",
                "serverId": "docs",
                "loginId": "login-1",
                "success": true,
                "error": null
            }),
        );
        assert!(finished.shell_changed);
        assert!(state.mcp_oauth.is_none());
        assert_eq!(state.mcp_notice.as_deref(), Some("MCP sign-in completed."));
    }

    #[test]
    fn mcp_oauth_rejects_non_http_browser_targets() {
        let mut state = ClientState::new(true);
        state.pending.insert(
            "mcp-login".into(),
            PendingRequest::McpOAuthStart {
                provider: ProviderId::Codex,
                project_path: "/project".into(),
                server_id: "docs".into(),
            },
        );

        let update = state.handle_response(Response::Success {
            id: "mcp-login".into(),
            result: json!({ "loginId": "login-1", "authUrl": "file:///tmp/oauth" }),
        });
        assert!(update.shell_events.is_empty());
        assert_eq!(
            state.mcp_error.as_deref(),
            Some("The MCP server returned an unsafe sign-in URL.")
        );
    }

    #[test]
    fn mcp_oauth_completion_can_win_the_start_response_race() {
        let mut state = ClientState::new(true);
        state.mcp_scope = Some((ProviderId::Codex, "/project".into()));
        state.pending.insert(
            "mcp-login".into(),
            PendingRequest::McpOAuthStart {
                provider: ProviderId::Codex,
                project_path: "/project".into(),
                server_id: "docs".into(),
            },
        );
        let early = state.handle_push(
            channel::MCP_OAUTH,
            json!({
                "provider": "codex",
                "projectPath": "/project",
                "serverId": "docs",
                "loginId": "login-1",
                "success": true,
                "error": null
            }),
        );
        assert!(!early.shell_changed);

        let response = state.handle_response(Response::Success {
            id: "mcp-login".into(),
            result: json!({
                "loginId": "login-1",
                "authUrl": "https://example.com/oauth"
            }),
        });
        assert!(response.shell_changed);
        assert!(response.shell_events.is_empty());
        assert!(state.mcp_oauth.is_none());
        assert_eq!(state.mcp_notice.as_deref(), Some("MCP sign-in completed."));
    }

    #[test]
    fn browser_auth_retains_the_login_id_and_rejects_unsafe_urls() {
        let mut state = ClientState::new(true);
        let target = AuthTarget::provider(ProviderId::Codex);
        state.auth_busy = Some(target.clone());
        state.pending.insert(
            "auth-start".into(),
            PendingRequest::AuthStart {
                target: target.clone(),
            },
        );

        let started = state.handle_response(Response::Success {
            id: "auth-start".into(),
            result: json!({
                "loginId": "login-1",
                "authUrl": "https://example.com/oauth"
            }),
        });
        assert!(matches!(
            started.shell_events.as_slice(),
            [ShellEvent::OpenUrl { url }] if url == "https://example.com/oauth"
        ));
        assert_eq!(
            state
                .auth_logins
                .get(&target)
                .map(|session| session.login_id.as_str()),
            Some("login-1")
        );

        state.pending.insert(
            "unsafe-auth".into(),
            PendingRequest::AuthStart {
                target: target.clone(),
            },
        );
        let unsafe_result = state.handle_response(Response::Success {
            id: "unsafe-auth".into(),
            result: json!({ "loginId": "login-2", "authUrl": "file:///tmp/oauth" }),
        });
        assert!(unsafe_result.shell_events.is_empty());
        assert_eq!(
            state.auth_error.as_deref(),
            Some("auth.startLogin returned an invalid login ID or browser URL.")
        );
    }

    #[test]
    fn browser_auth_completion_can_win_the_start_response_race() {
        let mut state = ClientState::new(true);
        let target = AuthTarget::provider(ProviderId::Codex);
        state.pending.insert(
            "auth-start".into(),
            PendingRequest::AuthStart {
                target: target.clone(),
            },
        );

        let early = state.handle_push(
            channel::AUTH_EVENT,
            json!({
                "provider": "codex",
                "loginId": "login-1",
                "success": true,
                "error": null
            }),
        );
        assert!(!early.shell_changed);

        let started = state.handle_response(Response::Success {
            id: "auth-start".into(),
            result: json!({
                "loginId": "login-1",
                "authUrl": "https://example.com/oauth"
            }),
        });
        assert!(started.shell_changed);
        assert!(started.shell_events.is_empty());
        assert!(!state.auth_logins.contains_key(&target));
        assert_eq!(state.auth_busy.as_ref(), Some(&target));
        assert!(state.early_auth_events.is_empty());
    }

    #[test]
    fn preview_capture_pushes_only_reach_a_capable_native_runtime() {
        let data = json!({
            "requestId": "019fd8e9-c08d-78a0-b208-c0063be8769d",
            "url": "http://127.0.0.1:5183/",
            "viewports": [{ "width": 1440, "height": 900 }]
        });
        let mut state = ClientState::new(true);
        assert!(
            state
                .handle_push(channel::PREVIEW_CAPTURE_REQUESTED, data.clone())
                .shell_events
                .is_empty()
        );

        state.set_preview_capture_available(true);
        let update = state.handle_push(channel::PREVIEW_CAPTURE_REQUESTED, data);
        assert!(!update.shell_changed);
        assert!(matches!(
            update.shell_events.as_slice(),
            [ShellEvent::PreviewCaptureRequested(request)]
                if request.request_id == "019fd8e9-c08d-78a0-b208-c0063be8769d"
                    && request.viewports == vec![PreviewViewport { width: 1_440, height: 900 }]
        ));
    }

    #[test]
    fn preview_capture_pushes_are_validated_before_browser_work() {
        let mut state = ClientState::new(true);
        state.set_preview_capture_available(true);
        for data in [
            json!({
                "requestId": "not-a-uuid",
                "url": "http://127.0.0.1:5183/",
                "viewports": [{ "width": 1440, "height": 900 }]
            }),
            json!({
                "requestId": "019fd8e9-c08d-78a0-b208-c0063be8769d",
                "url": "https://example.com/",
                "viewports": [{ "width": 1440, "height": 900 }]
            }),
            json!({
                "requestId": "019fd8e9-c08d-78a0-b208-c0063be8769d",
                "url": "http://127.0.0.1:5183/",
                "viewports": [{ "width": 200, "height": 900 }]
            }),
        ] {
            assert!(
                state
                    .handle_push(channel::PREVIEW_CAPTURE_REQUESTED, data)
                    .shell_events
                    .is_empty()
            );
        }
    }

    #[test]
    fn auth_targets_preserve_optional_acp_agent_identity() {
        assert_eq!(
            auth_params(&AuthTarget::provider(ProviderId::Codex)),
            json!({ "provider": "codex" })
        );
        assert_eq!(
            auth_params(&AuthTarget::agent(ProviderId::Acp, "gemini".into())),
            json!({ "provider": "acp", "agent": "gemini" })
        );
    }
}
