use crate::ServerState;
use crate::api_workspace_tools::ApiWorkspaceToolFactory;
use crate::design_preview_runner::start_design_preview;
use crate::design_workflow::{
    DESIGN_REPAIR_LIMIT, DesignFlow, DesignFlowPhase, DesignInput, DesignLiveState,
    DesignOperation, design_attachments, open_turn, parse_stored_design_flow, prompt_for_phase,
    unresolved_design_input,
};
use crate::model_connections::ModelConnectionStore;
use harness_adapter_acp::AcpRuntime;
use harness_adapter_antigravity::AntigravityRuntime;
use harness_adapter_api::{ApiRuntime, ApiToolFactory};
use harness_adapter_claude_code::ClaudeCodeRuntime;
use harness_adapter_codex::CodexRuntime;
use harness_adapter_cursor::CursorRuntime;
use harness_adapter_grok::GrokRuntime;
use harness_adapter_opencode::OpenCodeRuntime;
use harness_agent::{
    AgentError, AgentHandlers, AgentRuntime, AgentSession, AgentSessionState, CancellationToken,
    ControlHandlers, CredentialValues, ProviderControl, StartOptions, TurnOptions,
};
use harness_credentials::CredentialStore;
use harness_design_agent::{
    BriefingOutput, BriefingQuestion, BuildPhaseOutput, DESIGN_BRIEF_ATTACHMENT,
    ExplicitBriefAnswer, RepairPhaseOutput, ReviewScreenshot, ReviewVerdict, design_asset_prompt,
    design_brand_prompt, design_briefing_continuation, design_briefing_prompt, design_build_prompt,
    design_page_prompt, design_phase_correction_prompt, design_preview_prompt,
    design_repair_prompt, final_briefing_question, parse_asset_phase_output,
    parse_brand_phase_output, parse_briefing_output, parse_build_phase_output,
    parse_page_phase_output, parse_preview_phase_output, parse_repair_phase_output,
    parse_review_phase_output, read_brand_system, read_design_brief, read_page_blueprint,
    write_asset_manifest, write_brand_system, write_design_brief, write_page_blueprint,
    write_visual_review,
};
use harness_protocol::{
    Account, ApprovalDecision, AuthEventPush, AuthStartLoginResult, DomainEvent, Item, ItemStatus,
    ItemType, McpAuth, McpCapabilities, McpConfigValue, McpListResult, McpOAuthPush,
    McpOAuthStartResult, McpServer, McpServerConfig, McpServerScope, McpStartupStatus,
    McpTransport, MessageRole, Model, PanicStopResult, PanicStopSessionResult, ProviderId,
    QueueDirection, QueuedTurn, SendTurnResult, Skill, SkillCapabilities, SkillSource,
    SkillsListResult, Thread, ThreadEventPush, ThreadInboxStatus, ThreadLifecyclePush,
    ThreadQueuePush, ThreadQueueResult, TurnStatus, UserInputOption, UserInputQuestion,
    UserInputRequest, VoiceStatusReason, VoiceStatusResult, VoiceTranscribeParams, channel,
};
use harness_store::{NewCheckpoint, NewThread};
use harness_workspace::Worktree;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const REPLY_STYLE_INSTRUCTIONS: &str = "Write like a clear, capable teammate.\n\n- Lead with the useful answer or outcome.\n- Use plain, specific language. Avoid generic AI filler, canned praise, and throat-clearing.\n- Keep routine replies compact, but include detail when the task needs it.\n- Prefer short paragraphs and only use lists when they improve scanning.\n- Do not use em dashes. Use a comma, colon, parentheses, or a new sentence instead.\n- Be warm and direct without slang overload or forced personality.\n- Never omit risks, blockers, or verification results just to sound concise.";
const PANIC_STOP_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) trait RuntimeRegistry: Send + Sync {
    fn runtime(
        &self,
        provider: ProviderId,
        agent: Option<&str>,
        connection_id: Option<&str>,
    ) -> Result<Arc<dyn AgentRuntime>, AgentError>;

    fn mcp_capabilities(&self, _provider: ProviderId) -> McpCapabilities {
        unsupported_mcp_capabilities()
    }

    fn skill_capabilities(&self, _provider: ProviderId) -> SkillCapabilities {
        unsupported_skill_capabilities()
    }
}

pub(crate) struct NativeRuntimes {
    codex: Arc<CodexRuntime>,
    claude: Arc<ClaudeCodeRuntime>,
    grok: Arc<GrokRuntime>,
    cursor: Arc<CursorRuntime>,
    opencode: Arc<OpenCodeRuntime>,
    antigravity: Arc<AntigravityRuntime>,
    acp: Mutex<HashMap<String, Arc<AcpRuntime>>>,
    model_connections: Arc<Mutex<ModelConnectionStore>>,
    credentials: Arc<dyn CredentialStore>,
    api_tools: Arc<ApiWorkspaceToolFactory>,
}

impl NativeRuntimes {
    pub(crate) fn new(
        model_connections: Arc<Mutex<ModelConnectionStore>>,
        credentials: Arc<dyn CredentialStore>,
    ) -> Self {
        Self {
            codex: Arc::new(CodexRuntime::default()),
            claude: Arc::new(ClaudeCodeRuntime::default()),
            grok: Arc::new(GrokRuntime::default()),
            cursor: Arc::new(CursorRuntime::default()),
            opencode: Arc::new(OpenCodeRuntime::default()),
            antigravity: Arc::new(AntigravityRuntime::default()),
            acp: Mutex::new(HashMap::new()),
            model_connections,
            credentials,
            api_tools: Arc::new(ApiWorkspaceToolFactory),
        }
    }
}

impl RuntimeRegistry for NativeRuntimes {
    fn runtime(
        &self,
        provider: ProviderId,
        agent: Option<&str>,
        connection_id: Option<&str>,
    ) -> Result<Arc<dyn AgentRuntime>, AgentError> {
        match provider {
            ProviderId::Codex if agent.is_none() && connection_id.is_none() => {
                Ok(self.codex.clone())
            }
            ProviderId::Codex => Err(AgentError::Failed(
                "Codex does not accept an ACP agent or model connection".into(),
            )),
            ProviderId::ClaudeCode if agent.is_none() && connection_id.is_none() => {
                Ok(self.claude.clone())
            }
            ProviderId::ClaudeCode => Err(AgentError::Failed(
                "Claude Code does not accept an ACP agent or model connection".into(),
            )),
            ProviderId::Grok if agent.is_none() && connection_id.is_none() => Ok(self.grok.clone()),
            ProviderId::Grok => Err(AgentError::Failed(
                "Grok does not accept an ACP agent or model connection".into(),
            )),
            ProviderId::Cursor if agent.is_none() && connection_id.is_none() => {
                Ok(self.cursor.clone())
            }
            ProviderId::Cursor => Err(AgentError::Failed(
                "Cursor does not accept an ACP agent or model connection".into(),
            )),
            ProviderId::OpenCode if agent.is_none() && connection_id.is_none() => {
                Ok(self.opencode.clone())
            }
            ProviderId::OpenCode => Err(AgentError::Failed(
                "OpenCode does not accept an ACP agent or model connection".into(),
            )),
            ProviderId::Antigravity if agent.is_none() && connection_id.is_none() => {
                Ok(self.antigravity.clone())
            }
            ProviderId::Antigravity => Err(AgentError::Failed(
                "Antigravity does not accept an ACP agent or model connection".into(),
            )),
            ProviderId::Acp if connection_id.is_some() => Err(AgentError::Failed(
                "ACP sessions do not accept a model connection".into(),
            )),
            ProviderId::Acp => {
                let agent = agent
                    .filter(|agent| !agent.is_empty())
                    .ok_or_else(|| AgentError::Failed("no ACP agent chosen".into()))?;
                let mut runtimes = lock(&self.acp);
                if let Some(runtime) = runtimes.get(agent) {
                    return Ok(runtime.clone());
                }
                let runtime = Arc::new(AcpRuntime::new(agent, Default::default())?);
                runtimes.insert(agent.into(), runtime.clone());
                Ok(runtime)
            }
            ProviderId::Api if agent.is_none() => {
                let connection_id = connection_id.ok_or_else(|| {
                    AgentError::Failed("connectionId is required for direct API sessions".into())
                })?;
                let connection = lock(&self.model_connections)
                    .get(connection_id)
                    .map_err(|error| AgentError::Failed(error.to_string()))?;
                if !connection.enabled {
                    return Err(AgentError::Failed(format!(
                        "model connection \"{connection_id}\" is disabled"
                    )));
                }
                let api_key = self
                    .credentials
                    .read(&connection.credential_ref)
                    .map_err(|error| AgentError::Failed(error.to_string()))?;
                let tools: Arc<dyn ApiToolFactory> = self.api_tools.clone();
                Ok(Arc::new(ApiRuntime::new(
                    connection.input(),
                    api_key,
                    tools,
                )))
            }
            ProviderId::Api => Err(AgentError::Failed(
                "direct API sessions do not accept an ACP agent".into(),
            )),
        }
    }

    fn mcp_capabilities(&self, provider: ProviderId) -> McpCapabilities {
        match provider {
            ProviderId::Codex => harness_adapter_codex::CODEX_MCP_CAPABILITIES,
            ProviderId::OpenCode => McpCapabilities {
                inventory: false,
                add: true,
                update: true,
                remove: true,
                reload: false,
                start_o_auth: false,
                cancel_o_auth: false,
            },
            ProviderId::ClaudeCode
            | ProviderId::Grok
            | ProviderId::Cursor
            | ProviderId::Antigravity
            | ProviderId::Acp
            | ProviderId::Api => unsupported_mcp_capabilities(),
        }
    }

    fn skill_capabilities(&self, provider: ProviderId) -> SkillCapabilities {
        if provider == ProviderId::Codex {
            harness_adapter_codex::CODEX_SKILL_CAPABILITIES
        } else {
            unsupported_skill_capabilities()
        }
    }
}

pub(crate) struct StartThreadRequest {
    pub provider: ProviderId,
    pub agent: Option<String>,
    pub connection_id: Option<String>,
    pub workspace_path: String,
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub effort: Option<String>,
    pub approval: Option<harness_protocol::ApprovalMode>,
    pub isolate: bool,
}

pub(crate) struct SubmitTurnRequest {
    pub thread_id: String,
    pub text: String,
    pub attachments: Vec<String>,
    pub options: TurnOptions,
}

#[derive(Clone)]
struct QueuedEntry {
    turn: QueuedTurn,
    options: TurnOptions,
}

type ProjectSession = (String, Arc<dyn AgentSession>);

#[derive(Default)]
struct LiveState {
    sessions: HashMap<String, Arc<dyn AgentSession>>,
    event_bridges: HashMap<String, Weak<EventBridge>>,
    session_order: Vec<String>,
    active_turns: HashSet<String>,
    starting_turns: HashSet<String>,
    terminal_while_starting: HashSet<String>,
    queues: HashMap<String, VecDeque<QueuedEntry>>,
    draining: HashSet<String>,
    design: DesignLiveState,
}

enum DesignOutputAction {
    Continue,
    RequestInput {
        questions: Vec<BriefingQuestion>,
        final_question: bool,
    },
    NotDesign,
}

enum DesignContinuation {
    None,
    Prompt {
        prompt: String,
        attachments: Vec<String>,
    },
    Operation(DesignOperation),
    Complete(String),
}

struct ResumeSlot {
    result: Mutex<Option<Result<Arc<dyn AgentSession>, String>>>,
    ready: Condvar,
}

impl ResumeSlot {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            ready: Condvar::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ControlKey {
    provider: ProviderId,
    agent: Option<String>,
}

struct ControlSlot {
    result: Mutex<Option<Result<Arc<dyn ProviderControl>, String>>>,
    ready: Condvar,
}

impl ControlSlot {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            ready: Condvar::new(),
        }
    }
}

pub(crate) struct AgentManager {
    runtimes: Arc<dyn RuntimeRegistry>,
    live: Mutex<LiveState>,
    resumes: Mutex<HashMap<String, Arc<ResumeSlot>>>,
    controls: Mutex<HashMap<ControlKey, Arc<dyn ProviderControl>>>,
    control_starts: Mutex<HashMap<ControlKey, Arc<ControlSlot>>>,
    watched_mcp_projects: Arc<Mutex<HashMap<ProviderId, HashSet<String>>>>,
    watched_skill_projects: Arc<Mutex<HashMap<ProviderId, HashSet<String>>>>,
    worktree_root: PathBuf,
    panic_stopping: AtomicBool,
    panic_generation: AtomicU64,
    panic_lock: Mutex<()>,
}

impl AgentManager {
    pub(crate) fn mcp_capabilities(&self, provider: ProviderId) -> McpCapabilities {
        self.runtimes.mcp_capabilities(provider)
    }

    pub(crate) fn new(runtimes: Arc<dyn RuntimeRegistry>) -> Self {
        Self {
            runtimes,
            live: Mutex::new(LiveState::default()),
            resumes: Mutex::new(HashMap::new()),
            controls: Mutex::new(HashMap::new()),
            control_starts: Mutex::new(HashMap::new()),
            watched_mcp_projects: Arc::new(Mutex::new(HashMap::new())),
            watched_skill_projects: Arc::new(Mutex::new(HashMap::new())),
            worktree_root: std::env::temp_dir().join("personal-harness-trees"),
            panic_stopping: AtomicBool::new(false),
            panic_generation: AtomicU64::new(0),
            panic_lock: Mutex::new(()),
        }
    }

    pub(crate) fn account(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        agent: Option<&str>,
    ) -> Result<Account, String> {
        self.control(state, provider, agent)?
            .account()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn start_login(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        agent: Option<&str>,
    ) -> Result<AuthStartLoginResult, String> {
        self.control(state, provider, agent)?
            .start_login()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn cancel_login(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        agent: Option<&str>,
        login_id: &str,
    ) -> Result<(), String> {
        self.control(state, provider, agent)?
            .cancel_login(login_id)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn use_api_key(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        agent: Option<&str>,
        api_key: &str,
    ) -> Result<Account, String> {
        self.control(state, provider, agent)?
            .use_api_key(api_key)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn sign_out(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        agent: Option<&str>,
    ) -> Result<(), String> {
        self.control(state, provider, agent)?
            .sign_out()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn voice_status(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
    ) -> Result<VoiceStatusResult, String> {
        if provider != ProviderId::Codex {
            return Ok(VoiceStatusResult {
                available: false,
                reason: Some(VoiceStatusReason::ProviderUnsupported),
            });
        }
        self.control(state, provider, None)?
            .voice_status()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn transcribe_voice(
        &self,
        state: &Arc<ServerState>,
        input: &VoiceTranscribeParams,
        cancellation: &CancellationToken,
    ) -> Result<String, String> {
        if input.provider != ProviderId::Codex {
            return Err("voice transcription is only available through Codex".into());
        }
        self.control(state, ProviderId::Codex, None)?
            .transcribe_voice(input, cancellation)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn list_mcp_servers(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        project_path: &str,
    ) -> Result<McpListResult, String> {
        let capabilities = self.runtimes.mcp_capabilities(provider);
        if capabilities == unsupported_mcp_capabilities() {
            return Ok(McpListResult {
                capabilities,
                servers: Vec::new(),
            });
        }
        watch_project(&self.watched_mcp_projects, provider, project_path);
        let mut inventory = if capabilities.inventory {
            let active = self.project_session(state, provider, project_path)?;
            match active {
                Some((thread_id, session)) => match session.list_mcp_servers(&thread_id) {
                    Ok(inventory) => inventory,
                    Err(AgentError::Unsupported(_)) => self
                        .control(state, provider, None)?
                        .list_mcp_servers()
                        .map_err(|error| error.to_string())?,
                    Err(error) => return Err(error.to_string()),
                },
                None => self
                    .control(state, provider, None)?
                    .list_mcp_servers()
                    .map_err(|error| error.to_string())?,
            }
        } else {
            McpListResult {
                capabilities,
                servers: Vec::new(),
            }
        };
        inventory.capabilities = capabilities;
        let configured = lock(&state.mcp_config)
            .list(provider, project_path)
            .map_err(|error| error.to_string())?;
        let mut positions = inventory
            .servers
            .iter()
            .enumerate()
            .map(|(index, server)| (server.id.clone(), index))
            .collect::<HashMap<_, _>>();
        for config in configured {
            let index = positions.get(&config.id).copied().unwrap_or_else(|| {
                inventory.servers.push(McpServer {
                    id: config.id.clone(),
                    display_name: None,
                    description: None,
                    version: None,
                    scope: McpServerScope::Project,
                    enabled: config.enabled,
                    transport: None,
                    auth: McpAuth::NotRequired,
                    startup: McpStartupStatus::Stopped,
                    tools: Vec::new(),
                    resources: Vec::new(),
                    resource_templates: Vec::new(),
                });
                let index = inventory.servers.len() - 1;
                positions.insert(config.id.clone(), index);
                index
            });
            let server = &mut inventory.servers[index];
            server.scope = McpServerScope::Project;
            server.enabled = config.enabled;
            if config.enabled {
                server.transport = config.transport;
                if config.display_name.is_some() {
                    server.display_name = config.display_name;
                }
            } else {
                server.startup = McpStartupStatus::Stopped;
            }
        }
        Ok(inventory)
    }

    pub(crate) fn reload_mcp_servers(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        project_path: &str,
    ) -> Result<(), String> {
        if !self.runtimes.mcp_capabilities(provider).reload {
            return Err("this provider cannot reload MCP servers".into());
        }
        let (thread_id, session) = self
            .project_session(state, provider, project_path)?
            .ok_or_else(|| {
                "start a compatible session for this project before reloading MCP servers"
                    .to_owned()
            })?;
        let (servers, credentials) = self.mcp_runtime_config(state, provider, project_path)?;
        session
            .reload_mcp_servers(&thread_id, &servers, &credentials)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn start_mcp_o_auth(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        project_path: &str,
        server_id: &str,
    ) -> Result<McpOAuthStartResult, String> {
        if !self.runtimes.mcp_capabilities(provider).start_o_auth {
            return Err("this provider cannot start MCP OAuth".into());
        }
        let (thread_id, session) = self
            .project_session(state, provider, project_path)?
            .ok_or_else(|| {
                "start a compatible session for this project before signing in to an MCP server"
                    .to_owned()
            })?;
        session
            .start_mcp_o_auth(server_id, &thread_id)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn cancel_mcp_o_auth(&self, provider: ProviderId) -> Result<(), String> {
        Err(format!(
            "provider \"{}\" cannot cancel MCP OAuth; close the browser flow instead",
            provider_key(provider)
        ))
    }

    pub(crate) fn list_skills(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        project_path: &str,
    ) -> Result<SkillsListResult, String> {
        let capabilities = self.runtimes.skill_capabilities(provider);
        if !capabilities.inventory {
            return Ok(SkillsListResult {
                capabilities,
                skills: Vec::new(),
                errors: Vec::new(),
            });
        }
        watch_project(&self.watched_skill_projects, provider, project_path);
        let mut inventory = self
            .control(state, provider, None)?
            .list_skills(project_path)
            .map_err(|error| error.to_string())?;
        inventory.capabilities = capabilities;
        Ok(inventory)
    }

    pub(crate) fn set_skill_enabled(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        project_path: &str,
        skill_id: &str,
        enabled: bool,
    ) -> Result<bool, String> {
        if !self.runtimes.skill_capabilities(provider).configure {
            return Err("this provider cannot configure skills".into());
        }
        watch_project(&self.watched_skill_projects, provider, project_path);
        self.control(state, provider, None)?
            .set_skill_enabled(skill_id, enabled)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn install_skill(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        project_path: &str,
        folder_path: &str,
    ) -> Result<Skill, String> {
        if !self.runtimes.skill_capabilities(provider).install {
            return Err("this provider cannot install skills".into());
        }
        watch_project(&self.watched_skill_projects, provider, project_path);
        let control = self.control(state, provider, None)?;
        let current = control
            .list_skills(project_path)
            .map_err(|error| error.to_string())?;
        if !current.capabilities.install {
            return Err("this provider cannot install skills".into());
        }
        let destination = crate::skill_install::install_local_skill(project_path, folder_path)
            .map_err(|error| error.to_string())?;
        let discovered = control
            .list_skills(project_path)
            .map_err(|error| error.to_string())
            .and_then(|inventory| {
                inventory
                    .skills
                    .into_iter()
                    .find(|skill| match &skill.source {
                        SkillSource::Folder { path } => same_path(path, &destination),
                        SkillSource::Provider => false,
                    })
                    .ok_or_else(|| {
                        inventory
                            .errors
                            .iter()
                            .find(|error| path_inside(&destination, &error.path))
                            .map(|error| error.message.clone())
                            .unwrap_or_else(|| {
                                "provider did not discover the installed skill".into()
                            })
                    })
            });
        if discovered.is_err() {
            let _ = std::fs::remove_dir_all(destination);
        }
        discovered
    }

    pub(crate) fn list_models(
        &self,
        provider: ProviderId,
        agent: Option<&str>,
    ) -> Result<Vec<Model>, String> {
        self.runtimes
            .runtime(provider, agent, None)
            .and_then(|runtime| runtime.list_models())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn list_connection_models(
        &self,
        state: &ServerState,
        connection_id: &str,
    ) -> Result<Vec<Model>, String> {
        let connection = lock(&state.model_connections)
            .get(connection_id)
            .map_err(|error| error.to_string())?;
        let api_key = state
            .credentials
            .read(&connection.credential_ref)
            .map_err(|error| error.to_string())?;
        harness_adapter_api::list_models(&connection.input(), &api_key)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn start_thread(
        &self,
        state: &Arc<ServerState>,
        request: StartThreadRequest,
    ) -> Result<Thread, String> {
        let stored_connection_id = request.connection_id.clone();
        let (mcp_servers, mcp_credentials) =
            self.mcp_runtime_config(state, request.provider, &request.workspace_path)?;
        let provisional_id = format!("{}-{}", provider_key(request.provider), Uuid::new_v4());
        let worktree = request
            .isolate
            .then(|| {
                harness_workspace::create_worktree(
                    &request.workspace_path,
                    &provisional_id,
                    &self.worktree_root,
                )
                .map_err(|error| error.to_string())
            })
            .transpose()?;
        let runtime = match self.runtimes.runtime(
            request.provider,
            request.agent.as_deref(),
            request.connection_id.as_deref(),
        ) {
            Ok(runtime) => runtime,
            Err(error) => {
                cleanup_failed_worktree(worktree.as_ref());
                return Err(error.to_string());
            }
        };
        let bridge = Arc::new(EventBridge::new(Arc::downgrade(state)));
        let event_bridge = Arc::clone(&bridge);
        let handlers = session_handlers(
            state,
            event_bridge,
            request.provider,
            request.workspace_path.clone(),
        );
        let options = StartOptions {
            instructions: Some(REPLY_STYLE_INSTRUCTIONS.into()),
            model: request.model,
            service_tier: request.service_tier,
            effort: request.effort,
            approval: request.approval,
            mcp_servers,
            mcp_credentials,
            resume_state: None,
        };
        let workspace = worktree
            .as_ref()
            .map(|worktree| worktree.path.to_string_lossy().into_owned())
            .unwrap_or_else(|| request.workspace_path.clone());
        let (thread, session) = match runtime.start(&workspace, &options, handlers) {
            Ok(started) => started,
            Err(error) => {
                cleanup_failed_worktree(worktree.as_ref());
                return Err(error.to_string());
            }
        };
        let initial_state = match session.export_state() {
            Ok(state) => state,
            Err(_) => {
                session.dispose();
                cleanup_failed_worktree(worktree.as_ref());
                return Err("provider could not prepare durable session state".into());
            }
        };
        let mut inserted = false;
        let stored = {
            let store = lock(&state.store);
            store
                .add_project(&request.workspace_path, None)
                .and_then(|_| {
                    store.add_thread_with_connection(
                        NewThread {
                            id: thread.id.clone(),
                            project_path: request.workspace_path,
                            provider: request.provider,
                            agent: request.agent,
                            title: "New session".into(),
                            created_at: Some(timestamp_i64(thread.created_at)),
                            worktree_path: worktree
                                .as_ref()
                                .map(|entry| entry.path.to_string_lossy().into_owned()),
                            worktree_branch: worktree.as_ref().map(|entry| entry.branch.clone()),
                        },
                        stored_connection_id.as_deref(),
                    )
                })
                .and_then(|stored| {
                    inserted = true;
                    if let Some(initial_state) = initial_state.as_ref() {
                        store.set_provider_session_state(&thread.id, initial_state.value())?;
                    }
                    Ok(stored)
                })
        };
        if let Err(error) = stored {
            if inserted {
                let mut store = lock(&state.store);
                let _ = store.forget_worktree(&thread.id);
                let _ = store.delete_thread(&thread.id);
            }
            session.dispose();
            cleanup_failed_worktree(worktree.as_ref());
            return Err(error.to_string());
        }
        self.attach_session(&thread.id, session, &bridge);
        bridge.attach(thread.id.clone());
        Ok(thread)
    }

    pub(crate) fn submit_turn(
        &self,
        state: &Arc<ServerState>,
        request: SubmitTurnRequest,
    ) -> Result<SendTurnResult, String> {
        if self.panic_stopping.load(Ordering::Acquire) {
            return Err("turn cancelled by panic stop".into());
        }
        let panic_generation = self.panic_generation.load(Ordering::Acquire);
        let session = self.ensure_session(state, &request.thread_id)?;
        if self.panic_stopping.load(Ordering::Acquire)
            || self.panic_generation.load(Ordering::Acquire) != panic_generation
        {
            return Err("turn cancelled by panic stop".into());
        }
        let queued = {
            let mut live = lock(&self.live);
            let busy = live.active_turns.contains(&request.thread_id)
                || live.starting_turns.contains(&request.thread_id)
                || live.design.owns_thread(&request.thread_id)
                || live
                    .queues
                    .get(&request.thread_id)
                    .is_some_and(|queue| !queue.is_empty());
            if busy {
                let turn = QueuedTurn {
                    id: Uuid::new_v4().to_string(),
                    text: request.text.clone(),
                    attachments: request.attachments.clone(),
                    created_at: now_ms(),
                };
                live.queues
                    .entry(request.thread_id.clone())
                    .or_default()
                    .push_back(QueuedEntry {
                        turn: turn.clone(),
                        options: request.options.clone(),
                    });
                Some(turn)
            } else {
                live.starting_turns.insert(request.thread_id.clone());
                None
            }
        };
        if let Some(queued_turn) = queued {
            self.notify_queue(state, &request.thread_id);
            return Ok(SendTurnResult::Queued {
                queued: true,
                queued_turn,
            });
        }
        let turn_id = match self.run_started_turn(
            state,
            &request.thread_id,
            &request.text,
            &request.attachments,
            &request.options,
            &session,
        ) {
            Ok(turn_id) => turn_id,
            Err(error) => {
                schedule_drain(state, request.thread_id);
                return Err(error);
            }
        };
        Ok(SendTurnResult::Started {
            queued: false,
            turn_id,
        })
    }

    pub(crate) fn queue(&self, thread_id: &str) -> ThreadQueueResult {
        let live = lock(&self.live);
        queue_result(&live, thread_id)
    }

    pub(crate) fn delete_queued(&self, state: &ServerState, thread_id: &str, queued_turn_id: &str) {
        let changed = {
            let mut live = lock(&self.live);
            let Some(queue) = live.queues.get_mut(thread_id) else {
                return;
            };
            let Some(index) = queue
                .iter()
                .position(|entry| entry.turn.id == queued_turn_id)
            else {
                return;
            };
            queue.remove(index);
            true
        };
        if changed {
            self.notify_queue(state, thread_id);
        }
    }

    pub(crate) fn move_queued(
        &self,
        state: &ServerState,
        thread_id: &str,
        queued_turn_id: &str,
        direction: QueueDirection,
    ) {
        let changed = {
            let mut live = lock(&self.live);
            let Some(queue) = live.queues.get_mut(thread_id) else {
                return;
            };
            let Some(from) = queue
                .iter()
                .position(|entry| entry.turn.id == queued_turn_id)
            else {
                return;
            };
            let to = match direction {
                QueueDirection::Up => from.checked_sub(1),
                QueueDirection::Down => from.checked_add(1).filter(|to| *to < queue.len()),
            };
            let Some(to) = to else {
                return;
            };
            queue.swap(from, to);
            true
        };
        if changed {
            self.notify_queue(state, thread_id);
        }
    }

    pub(crate) fn steer_queued(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        queued_turn_id: &str,
    ) -> Result<(), String> {
        let (session, entry, index) = {
            let mut live = lock(&self.live);
            if !live.active_turns.contains(thread_id) {
                return Err("there is no running turn to steer".into());
            }
            let session = live
                .sessions
                .get(thread_id)
                .cloned()
                .ok_or_else(|| format!("no such live thread: {thread_id}"))?;
            if !session.capabilities().steer {
                return Err("this agent does not support steering a running turn".into());
            }
            let queue = live.queues.entry(thread_id.into()).or_default();
            let index = queue
                .iter()
                .position(|entry| entry.turn.id == queued_turn_id)
                .ok_or_else(|| "queued prompt not found".to_owned())?;
            let entry = queue.remove(index).expect("queued entry disappeared");
            (session, entry, index)
        };
        self.notify_queue(state, thread_id);
        if let Err(error) = session.steer(thread_id, &entry.turn.text, &entry.turn.attachments) {
            lock(&self.live)
                .queues
                .entry(thread_id.into())
                .or_default()
                .insert(index, entry);
            self.notify_queue(state, thread_id);
            return Err(error.to_string());
        }
        Ok(())
    }

    pub(crate) fn respond_to_approval(
        &self,
        thread_id: &str,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        let session = self.live_session(thread_id)?;
        session
            .respond_to_approval(approval_id, decision)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn respond_to_user_input(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        request_id: &str,
        answers: &HashMap<String, Vec<String>>,
    ) -> Result<(), String> {
        let design_input = {
            let mut live = lock(&self.live);
            let matches = live
                .design
                .inputs
                .get(request_id)
                .is_some_and(|input| input.thread_id == thread_id);
            if matches {
                live.design.input_by_thread.remove(thread_id);
                live.design.inputs.remove(request_id)
            } else {
                None
            }
        };
        if let Some(input) = design_input {
            record_event(
                state,
                thread_id,
                DomainEvent::UserInputResolved {
                    id: request_id.into(),
                },
            );
            let mut flow = self.take_design_flow(thread_id)?;
            let no_more_details = input.final_question
                && answers
                    .get(harness_design_agent::FINAL_BRIEFING_QUESTION_ID)
                    .into_iter()
                    .flatten()
                    .any(|answer| answer.starts_with("No, that's everything"));
            if !no_more_details {
                for question in &input.questions {
                    let answer = answers
                        .get(&question.id)
                        .map(|answers| answers.join(", "))
                        .unwrap_or_default();
                    let answer = answer.trim();
                    if !answer.is_empty() {
                        flow.explicit_answers.push(ExplicitBriefAnswer {
                            question: question.question.clone(),
                            answer: answer.into(),
                        });
                    }
                }
            }
            let prompt = if no_more_details {
                if let Some(brief) = flow.pending_brief.take() {
                    match self.complete_design_brief(&mut flow, brief) {
                        Ok(()) => flow
                            .pending_prompt
                            .take()
                            .ok_or_else(|| "design prompt is unavailable".to_owned())?,
                        Err(error) if !flow.correcting => {
                            flow.correcting = true;
                            design_phase_correction_prompt(&error)
                        }
                        Err(error) => {
                            self.put_design_flow(state, thread_id, flow)?;
                            self.fail_design_flow(state, thread_id, &error);
                            return Ok(());
                        }
                    }
                } else {
                    design_briefing_continuation(&input.questions, answers)
                }
            } else {
                design_briefing_continuation(&input.questions, answers)
            };
            self.put_design_flow(state, thread_id, flow)?;
            self.schedule_design_prompt(state, thread_id, prompt, Vec::new());
            return Ok(());
        }
        let session = self.live_session(thread_id)?;
        session
            .respond_to_user_input(request_id, answers)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn interrupt(&self, thread_id: &str) -> Result<(), String> {
        let session = lock(&self.live).sessions.get(thread_id).cloned();
        session
            .map(|session| session.interrupt(thread_id))
            .transpose()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn panic_stop(&self, state: &Arc<ServerState>) -> PanicStopResult {
        let _panic = lock(&self.panic_lock);
        self.panic_stopping.store(true, Ordering::Release);
        self.panic_generation.fetch_add(1, Ordering::AcqRel);
        let (sessions, queued_threads, design_threads) = {
            let mut live = lock(&self.live);
            let sessions = live
                .session_order
                .iter()
                .filter_map(|thread_id| {
                    live.sessions
                        .get(thread_id)
                        .cloned()
                        .map(|session| (thread_id.clone(), session))
                })
                .collect::<Vec<_>>();
            let queued_threads = live
                .queues
                .iter()
                .filter(|(_, queue)| !queue.is_empty())
                .map(|(thread_id, _)| thread_id.clone())
                .collect::<Vec<_>>();
            let design_threads = live.design.flows.keys().cloned().collect::<Vec<_>>();
            live.queues.clear();
            live.starting_turns.clear();
            (sessions, queued_threads, design_threads)
        };
        for thread_id in queued_threads {
            self.notify_queue(state, &thread_id);
        }

        let deadline = Instant::now() + PANIC_STOP_TIMEOUT;
        let mut pending = Vec::with_capacity(sessions.len());
        for (thread_id, session) in sessions {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let interrupt_thread_id = thread_id.clone();
            thread::spawn(move || {
                let result = session
                    .interrupt(&interrupt_thread_id)
                    .map_err(|error| error.to_string());
                let _ = sender.send(result);
            });
            pending.push((thread_id, receiver));
        }

        let mut results = Vec::with_capacity(pending.len());
        let mut failed = Vec::new();
        for (thread_id, receiver) in pending {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = match receiver.recv_timeout(remaining) {
                Ok(result) => result,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    Err("interrupt timed out; session was force-stopped".to_owned())
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    Err("interrupt worker stopped unexpectedly".to_owned())
                }
            };
            match result {
                Ok(()) => results.push(PanicStopSessionResult::Interrupted { thread_id }),
                Err(error) => {
                    let error = if error.trim().is_empty() {
                        "Unknown error".into()
                    } else {
                        error
                    };
                    failed.push(thread_id.clone());
                    results.push(PanicStopSessionResult::Failed { thread_id, error });
                }
            }
        }

        for thread_id in &design_threads {
            self.complete_design_activities_for_thread(state, thread_id, ItemStatus::Failed);
            self.clear_design_flow(state, thread_id);
        }
        {
            let mut live = lock(&self.live);
            for result in &results {
                let thread_id = match result {
                    PanicStopSessionResult::Interrupted { thread_id }
                    | PanicStopSessionResult::Failed { thread_id, .. } => thread_id,
                };
                live.active_turns.remove(thread_id);
                live.starting_turns.remove(thread_id);
            }
        }
        for thread_id in failed {
            self.close(&thread_id);
            state.terminals.close_thread(&thread_id);
        }
        self.panic_stopping.store(false, Ordering::Release);
        PanicStopResult { sessions: results }
    }

    pub(crate) fn close(&self, thread_id: &str) {
        let (session, preview, bridge) = {
            let mut live = lock(&self.live);
            live.active_turns.remove(thread_id);
            live.starting_turns.remove(thread_id);
            live.terminal_while_starting.remove(thread_id);
            live.queues.remove(thread_id);
            live.draining.remove(thread_id);
            live.session_order
                .retain(|candidate| candidate != thread_id);
            (
                live.sessions.remove(thread_id),
                live.design.clear_thread(thread_id),
                live.event_bridges
                    .remove(thread_id)
                    .and_then(|bridge| bridge.upgrade()),
            )
        };
        if let Some(bridge) = bridge {
            bridge.set_design_active(false);
        }
        if let Some(preview) = preview {
            let _ = preview.stop();
        }
        if let Some(session) = session {
            session.dispose();
        }
    }

    pub(crate) fn dispose_all(&self) {
        let (sessions, previews) = {
            let mut live = lock(&self.live);
            live.active_turns.clear();
            live.starting_turns.clear();
            live.terminal_while_starting.clear();
            live.queues.clear();
            live.draining.clear();
            live.session_order.clear();
            live.event_bridges.clear();
            let sessions = live
                .sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>();
            let previews = live
                .design
                .previews
                .drain()
                .map(|(_, preview)| preview)
                .collect::<Vec<_>>();
            live.design = DesignLiveState::default();
            (sessions, previews)
        };
        for preview in previews {
            let _ = preview.stop();
        }
        for session in sessions {
            session.dispose();
        }
        let controls = lock(&self.controls)
            .drain()
            .map(|(_, control)| control)
            .collect::<Vec<_>>();
        for control in controls {
            control.dispose();
        }
    }

    pub(crate) fn is_running(&self, thread_id: &str) -> bool {
        let live = lock(&self.live);
        live.active_turns.contains(thread_id) || live.starting_turns.contains(thread_id)
    }

    pub(crate) fn activity_status(&self, thread_id: &str) -> Option<ThreadInboxStatus> {
        let live = lock(&self.live);
        if live.starting_turns.contains(thread_id) {
            Some(ThreadInboxStatus::Starting)
        } else if live.active_turns.contains(thread_id) {
            Some(ThreadInboxStatus::Working)
        } else if live
            .queues
            .get(thread_id)
            .is_some_and(|queue| !queue.is_empty())
        {
            Some(ThreadInboxStatus::Queued)
        } else {
            None
        }
    }

    fn run_started_turn(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        options: &TurnOptions,
        session: &Arc<dyn AgentSession>,
    ) -> Result<String, String> {
        let panic_generation = self.panic_generation.load(Ordering::Acquire);
        if self.turn_cancelled_by_panic(panic_generation) {
            self.clear_starting_turn(thread_id);
            return Err("turn cancelled by panic stop".into());
        }
        self.checkpoint(state, thread_id, text);
        if self.turn_cancelled_by_panic(panic_generation) {
            self.clear_starting_turn(thread_id);
            return Err("turn cancelled by panic stop".into());
        }
        if attachments
            .iter()
            .any(|attachment| attachment == DESIGN_BRIEF_ATTACHMENT)
        {
            let workspace_path = match self.thread_workspace_path(state, thread_id) {
                Ok(workspace_path) => workspace_path,
                Err(error) => {
                    self.clear_starting_turn(thread_id);
                    return Err(error);
                }
            };
            let flow = DesignFlow::new(workspace_path, text.into(), options);
            if let Err(error) = self.replace_design_flow(state, thread_id, flow) {
                self.clear_starting_turn(thread_id);
                return Err(error);
            }
            let visible_attachments = attachments
                .iter()
                .filter(|attachment| attachment.as_str() != DESIGN_BRIEF_ATTACHMENT)
                .cloned()
                .collect::<Vec<_>>();
            return self.run_design_turn_with_session(
                state,
                thread_id,
                &design_briefing_prompt(text),
                &visible_attachments,
                session,
                false,
            );
        }
        let result = session
            .send_turn(thread_id, text, attachments, options)
            .map_err(|error| error.to_string());
        let cancelled = self.turn_cancelled_by_panic(panic_generation);
        let completed_during_start = {
            let mut live = lock(&self.live);
            live.starting_turns.remove(thread_id);
            let completed = live.terminal_while_starting.remove(thread_id);
            if result.is_ok() && !completed && !cancelled {
                live.active_turns.insert(thread_id.into());
            }
            completed
        };
        if completed_during_start {
            schedule_drain(state, thread_id.into());
        }
        if cancelled {
            let _ = session.interrupt(thread_id);
            return Err("turn cancelled by panic stop".into());
        }
        result
    }

    fn turn_cancelled_by_panic(&self, generation: u64) -> bool {
        self.panic_stopping.load(Ordering::Acquire)
            || self.panic_generation.load(Ordering::Acquire) != generation
    }

    fn clear_starting_turn(&self, thread_id: &str) {
        let mut live = lock(&self.live);
        live.starting_turns.remove(thread_id);
        live.design.starting_threads.remove(thread_id);
    }

    fn run_design_turn_with_session(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        prompt: &str,
        attachments: &[String],
        session: &Arc<dyn AgentSession>,
        report_failure: bool,
    ) -> Result<String, String> {
        let panic_generation = self.panic_generation.load(Ordering::Acquire);
        if self.turn_cancelled_by_panic(panic_generation) {
            self.clear_design_flow(state, thread_id);
            self.clear_starting_turn(thread_id);
            return Err("turn cancelled by panic stop".into());
        }
        let options = {
            let mut live = lock(&self.live);
            let flow = live
                .design
                .flows
                .get(thread_id)
                .ok_or_else(|| "design flow is unavailable".to_owned())?;
            let options = flow.options.turn_options();
            live.starting_turns.insert(thread_id.into());
            live.design.starting_threads.insert(thread_id.into());
            options
        };
        let result = session
            .send_turn(thread_id, prompt, attachments, &options)
            .map_err(|error| error.to_string());
        let cancelled = self.turn_cancelled_by_panic(panic_generation);
        let completed_during_start = {
            let mut live = lock(&self.live);
            live.starting_turns.remove(thread_id);
            live.design.starting_threads.remove(thread_id);
            let completed = live.terminal_while_starting.remove(thread_id);
            if let Ok(turn_id) = &result
                && !completed
                && !cancelled
            {
                live.active_turns.insert(thread_id.into());
                live.design
                    .turns
                    .entry(turn_id.clone())
                    .or_insert_with(|| thread_id.into());
            }
            completed
        };
        if completed_during_start {
            schedule_drain(state, thread_id.into());
        }
        if cancelled {
            let _ = session.interrupt(thread_id);
            self.clear_design_flow(state, thread_id);
            return Err("turn cancelled by panic stop".into());
        }
        if let Err(error) = &result {
            if report_failure {
                self.fail_design_flow(state, thread_id, error);
            } else {
                self.clear_design_flow(state, thread_id);
            }
        }
        result
    }

    fn send_design_turn(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        prompt: String,
        attachments: Vec<String>,
    ) -> Result<String, String> {
        let session = self.live_session(thread_id)?;
        self.run_design_turn_with_session(state, thread_id, &prompt, &attachments, &session, true)
    }

    fn thread_workspace_path(
        &self,
        state: &ServerState,
        thread_id: &str,
    ) -> Result<String, String> {
        let thread = lock(&state.store)
            .thread(thread_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("no such thread: {thread_id}"))?;
        Ok(thread.worktree_path.unwrap_or(thread.project_path))
    }

    fn replace_design_flow(
        &self,
        state: &ServerState,
        thread_id: &str,
        flow: DesignFlow,
    ) -> Result<(), String> {
        let (preview, bridge) = {
            let mut live = lock(&self.live);
            let preview = live.design.clear_thread(thread_id);
            live.design.flows.insert(thread_id.into(), flow);
            let bridge = live.event_bridges.get(thread_id).and_then(Weak::upgrade);
            (preview, bridge)
        };
        if let Some(bridge) = bridge {
            bridge.set_design_active(true);
        }
        if let Some(preview) = preview {
            let _ = preview.stop();
        }
        if let Err(error) = self.persist_design_flow(state, thread_id) {
            self.clear_design_flow(state, thread_id);
            return Err(error);
        }
        Ok(())
    }

    fn persist_design_flow(&self, state: &ServerState, thread_id: &str) -> Result<(), String> {
        let value = {
            let live = lock(&self.live);
            live.design
                .flows
                .get(thread_id)
                .map(serde_json::to_value)
                .transpose()
                .map_err(|error| error.to_string())?
        };
        if let Some(value) = value {
            lock(&state.store)
                .set_design_run(thread_id, &value)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn take_design_flow(&self, thread_id: &str) -> Result<DesignFlow, String> {
        let mut live = lock(&self.live);
        let flow = live
            .design
            .flows
            .remove(thread_id)
            .ok_or_else(|| "design flow is unavailable".to_owned())?;
        live.design.processing.insert(thread_id.into());
        Ok(flow)
    }

    fn put_design_flow(
        &self,
        state: &ServerState,
        thread_id: &str,
        flow: DesignFlow,
    ) -> Result<(), String> {
        {
            let mut live = lock(&self.live);
            live.design.processing.remove(thread_id);
            live.design.flows.insert(thread_id.into(), flow);
        }
        self.persist_design_flow(state, thread_id)
    }

    fn clear_design_flow(&self, state: &ServerState, thread_id: &str) {
        let (preview, bridge) = {
            let mut live = lock(&self.live);
            let preview = live.design.clear_thread(thread_id);
            let bridge = live.event_bridges.get(thread_id).and_then(Weak::upgrade);
            (preview, bridge)
        };
        if let Some(bridge) = bridge {
            bridge.set_design_active(false);
        }
        if let Some(preview) = preview {
            let _ = preview.stop();
        }
        let _ = lock(&state.store).delete_design_run(thread_id);
    }

    fn complete_design_activity(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        turn_id: &str,
        status: ItemStatus,
    ) {
        let item = lock(&self.live).design.activity_items.remove(turn_id);
        if let Some(mut item) = item {
            item.status = status;
            record_event(state, thread_id, DomainEvent::ItemCompleted { item });
        }
    }

    fn complete_design_activities_for_thread(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        status: ItemStatus,
    ) {
        let turn_ids = {
            let live = lock(&self.live);
            live.design
                .turns
                .iter()
                .filter(|(_, owner)| owner.as_str() == thread_id)
                .map(|(turn_id, _)| turn_id.clone())
                .collect::<Vec<_>>()
        };
        for turn_id in turn_ids {
            self.complete_design_activity(state, thread_id, &turn_id, status);
        }
    }

    fn fail_design_flow(&self, state: &Arc<ServerState>, thread_id: &str, error: &str) {
        self.complete_design_activities_for_thread(state, thread_id, ItemStatus::Failed);
        self.clear_design_flow(state, thread_id);
        record_event(
            state,
            thread_id,
            DomainEvent::ThreadError {
                thread_id: thread_id.into(),
                message: format!("Design mode failed: {error}"),
            },
        );
    }

    fn finish_design_flow(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        turn_id: &str,
        summary: &str,
    ) {
        self.clear_design_flow(state, thread_id);
        record_event(
            state,
            thread_id,
            DomainEvent::ItemCompleted {
                item: Item {
                    id: format!("design-complete-{}", Uuid::new_v4()),
                    turn_id: turn_id.into(),
                    item_type: ItemType::Message,
                    status: ItemStatus::Completed,
                    role: Some(MessageRole::Assistant),
                    text: Some(format!("Website built. {summary}")),
                    command: None,
                    exit_code: None,
                    duration_ms: None,
                    path: None,
                    lines_added: None,
                    lines_removed: None,
                    created_at: now_ms(),
                },
            },
        );
        schedule_drain(state, thread_id.into());
    }

    fn request_design_input(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        turn_id: &str,
        questions: Vec<BriefingQuestion>,
        final_question: bool,
    ) {
        let request_id = Uuid::new_v4().to_string();
        let request = UserInputRequest {
            id: request_id.clone(),
            turn_id: turn_id.into(),
            questions: questions
                .iter()
                .map(|question| UserInputQuestion {
                    id: question.id.clone(),
                    header: question.header.clone(),
                    question: question.question.clone(),
                    allow_other: question.allow_other,
                    secret: false,
                    options: Some(
                        question
                            .options
                            .iter()
                            .map(|option| UserInputOption {
                                label: option.label.clone(),
                                description: option.description.clone(),
                            })
                            .collect(),
                    ),
                })
                .collect(),
            auto_resolution_ms: None,
            created_at: now_ms(),
        };
        {
            let mut live = lock(&self.live);
            live.design.inputs.insert(
                request_id.clone(),
                DesignInput {
                    thread_id: thread_id.into(),
                    questions,
                    final_question,
                },
            );
            live.design
                .input_by_thread
                .insert(thread_id.into(), request_id);
        }
        record_event(
            state,
            thread_id,
            DomainEvent::UserInputRequested { request },
        );
    }

    fn accept_design_output(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        turn_id: &str,
        text: &str,
    ) -> Result<bool, String> {
        let mut flow = self.take_design_flow(thread_id)?;
        let action = self.apply_design_output(&mut flow, text);
        let action = match action {
            Ok(action) => action,
            Err(error) => {
                let persistence = self.put_design_flow(state, thread_id, flow);
                return Err(persistence.err().unwrap_or(error));
            }
        };
        if matches!(action, DesignOutputAction::NotDesign) {
            self.complete_design_activity(state, thread_id, turn_id, ItemStatus::Completed);
            self.clear_design_flow(state, thread_id);
            record_event(
                state,
                thread_id,
                DomainEvent::ItemCompleted {
                    item: Item {
                        id: format!("design-not-applicable-{}", Uuid::new_v4()),
                        turn_id: turn_id.into(),
                        item_type: ItemType::Message,
                        status: ItemStatus::Completed,
                        role: Some(MessageRole::Assistant),
                        text: Some(
                            "Design mode was turned off because this request is not a website design task."
                                .into(),
                        ),
                        command: None,
                        exit_code: None,
                        duration_ms: None,
                        path: None,
                        lines_added: None,
                        lines_removed: None,
                        created_at: now_ms(),
                    },
                },
            );
            return Ok(false);
        }
        self.put_design_flow(state, thread_id, flow)?;
        if let DesignOutputAction::RequestInput {
            questions,
            final_question,
        } = action
        {
            self.request_design_input(state, thread_id, turn_id, questions, final_question);
        }
        Ok(true)
    }

    fn apply_design_output(
        &self,
        flow: &mut DesignFlow,
        text: &str,
    ) -> Result<DesignOutputAction, String> {
        if flow.phase == DesignFlowPhase::Brief {
            let output = parse_briefing_output(text).map_err(|error| error.to_string())?;
            flow.correcting = false;
            return match output {
                BriefingOutput::Questions { questions, .. } => {
                    flow.asked_questions = true;
                    flow.final_asked = false;
                    flow.pending_brief = None;
                    Ok(DesignOutputAction::RequestInput {
                        questions,
                        final_question: false,
                    })
                }
                BriefingOutput::NotDesign { .. } => Ok(DesignOutputAction::NotDesign),
                BriefingOutput::Complete { brief, .. }
                    if flow.asked_questions && !flow.final_asked =>
                {
                    flow.pending_brief = Some(brief);
                    flow.final_asked = true;
                    Ok(DesignOutputAction::RequestInput {
                        questions: vec![final_briefing_question()],
                        final_question: true,
                    })
                }
                BriefingOutput::Complete { brief, .. } => {
                    self.complete_design_brief(flow, brief)?;
                    Ok(DesignOutputAction::Continue)
                }
            };
        }

        let workspace = Path::new(&flow.workspace_path);
        match flow.phase {
            DesignFlowPhase::Brand => {
                let output = parse_brand_phase_output(text).map_err(|error| error.to_string())?;
                let value = serde_json::to_value(output).map_err(|error| error.to_string())?;
                let brand =
                    write_brand_system(workspace, &value).map_err(|error| error.to_string())?;
                flow.correcting = false;
                flow.phase = DesignFlowPhase::Page;
                flow.pending_prompt = Some(design_page_prompt(
                    &read_design_brief(workspace).map_err(|error| error.to_string())?,
                    &brand,
                ));
            }
            DesignFlowPhase::Page => {
                let output = parse_page_phase_output(text).map_err(|error| error.to_string())?;
                let value = serde_json::to_value(output).map_err(|error| error.to_string())?;
                let page =
                    write_page_blueprint(workspace, &value).map_err(|error| error.to_string())?;
                flow.correcting = false;
                flow.phase = DesignFlowPhase::Assets;
                flow.pending_prompt = Some(design_asset_prompt(
                    &read_design_brief(workspace).map_err(|error| error.to_string())?,
                    &read_brand_system(workspace).map_err(|error| error.to_string())?,
                    &page,
                ));
            }
            DesignFlowPhase::Assets => {
                let output = parse_asset_phase_output(text).map_err(|error| error.to_string())?;
                let value = serde_json::to_value(output).map_err(|error| error.to_string())?;
                let assets =
                    write_asset_manifest(workspace, &value).map_err(|error| error.to_string())?;
                flow.correcting = false;
                flow.phase = DesignFlowPhase::Build;
                flow.pending_prompt = Some(design_build_prompt(
                    &read_design_brief(workspace).map_err(|error| error.to_string())?,
                    &read_brand_system(workspace).map_err(|error| error.to_string())?,
                    &read_page_blueprint(workspace).map_err(|error| error.to_string())?,
                    &assets,
                ));
            }
            DesignFlowPhase::Build => {
                let output = parse_build_phase_output(text).map_err(|error| error.to_string())?;
                if let BuildPhaseOutput::Failed { error, .. } = output {
                    return Err(error);
                }
                flow.correcting = false;
                flow.phase = DesignFlowPhase::Preview;
                flow.pending_prompt = Some(design_preview_prompt());
            }
            DesignFlowPhase::Preview => {
                let plan = parse_preview_phase_output(text).map_err(|error| error.to_string())?;
                flow.correcting = false;
                flow.preview_url = Some(plan.url.clone());
                flow.preview_plan = Some(plan);
                flow.pending_operation = Some(DesignOperation::StartPreview);
            }
            DesignFlowPhase::Review => {
                let review = parse_review_phase_output(text).map_err(|error| error.to_string())?;
                let review =
                    write_visual_review(workspace, &review).map_err(|error| error.to_string())?;
                flow.correcting = false;
                flow.review = Some(review.clone());
                let preview_url = flow
                    .preview_url
                    .as_deref()
                    .ok_or_else(|| "preview URL is unavailable".to_owned())?;
                if review.verdict == ReviewVerdict::Pass {
                    flow.phase = DesignFlowPhase::Complete;
                    let repaired = if flow.repair_attempt == 0 {
                        String::new()
                    } else {
                        format!(
                            " after {} repair attempt{}",
                            flow.repair_attempt,
                            if flow.repair_attempt == 1 { "" } else { "s" }
                        )
                    };
                    flow.completion = Some(format!(
                        "Preview ready at {preview_url}. Visual review passed{repaired}."
                    ));
                } else if flow.repair_attempt >= DESIGN_REPAIR_LIMIT {
                    flow.phase = DesignFlowPhase::Complete;
                    let finding_count = review.findings.len();
                    flow.completion = Some(format!(
                        "Preview ready at {preview_url}. Visual review stopped after {DESIGN_REPAIR_LIMIT} repair attempts with {finding_count} finding{} remaining.",
                        if finding_count == 1 { "" } else { "s" }
                    ));
                } else {
                    flow.phase = DesignFlowPhase::Repair;
                    flow.repair_attempt += 1;
                    flow.pending_prompt = Some(
                        design_repair_prompt(&review, flow.repair_attempt, DESIGN_REPAIR_LIMIT)
                            .map_err(|error| error.to_string())?,
                    );
                }
            }
            DesignFlowPhase::Repair => {
                let output = parse_repair_phase_output(text).map_err(|error| error.to_string())?;
                if let RepairPhaseOutput::Failed { summary, .. } = output {
                    return Err(summary);
                }
                flow.correcting = false;
                flow.pending_operation = Some(DesignOperation::CaptureReview);
            }
            DesignFlowPhase::Brief | DesignFlowPhase::Complete => {
                return Err(format!("unexpected design phase {:?}", flow.phase));
            }
        }
        Ok(DesignOutputAction::Continue)
    }

    fn complete_design_brief(&self, flow: &mut DesignFlow, brief: Value) -> Result<(), String> {
        let mut brief = brief
            .as_object()
            .cloned()
            .ok_or_else(|| "completed briefing output must contain a brief".to_owned())?;
        brief.insert(
            "explicitAnswers".into(),
            serde_json::to_value(&flow.explicit_answers).map_err(|error| error.to_string())?,
        );
        let brief = write_design_brief(Path::new(&flow.workspace_path), &Value::Object(brief))
            .map_err(|error| error.to_string())?;
        flow.phase = DesignFlowPhase::Brand;
        flow.pending_brief = None;
        flow.pending_prompt = Some(design_brand_prompt(&brief));
        Ok(())
    }

    fn handle_session_event(&self, state: &Arc<ServerState>, thread_id: &str, event: DomainEvent) {
        if matches!(event, DomainEvent::ThreadError { .. })
            && lock(&self.live).design.owns_thread(thread_id)
        {
            self.complete_design_activities_for_thread(state, thread_id, ItemStatus::Failed);
            self.clear_design_flow(state, thread_id);
            record_event(state, thread_id, event.clone());
            return;
        }

        if let DomainEvent::TurnStarted { turn } = &event {
            let activity = {
                let mut live = lock(&self.live);
                let design_turn = live.design.starting_threads.contains(thread_id)
                    || live
                        .design
                        .turns
                        .get(&turn.id)
                        .is_some_and(|owner| owner == thread_id);
                if design_turn && live.design.flows.contains_key(thread_id) {
                    live.design.turns.insert(turn.id.clone(), thread_id.into());
                    let phase = live
                        .design
                        .flows
                        .get(thread_id)
                        .map(|flow| flow.phase)
                        .expect("checked design flow disappeared");
                    let item = Item {
                        id: format!("design-activity-{}", Uuid::new_v4()),
                        turn_id: turn.id.clone(),
                        item_type: ItemType::ToolCall,
                        status: ItemStatus::Started,
                        role: None,
                        text: Some(format!("design:{}", design_phase_key(phase))),
                        command: None,
                        exit_code: None,
                        duration_ms: None,
                        path: None,
                        lines_added: None,
                        lines_removed: None,
                        created_at: now_ms(),
                    };
                    live.design
                        .activity_items
                        .insert(turn.id.clone(), item.clone());
                    Some(item)
                } else {
                    None
                }
            };
            record_event(state, thread_id, event);
            if let Some(item) = activity {
                record_event(state, thread_id, DomainEvent::ItemStarted { item });
            }
            return;
        }

        let Some(turn_id) = event_turn_id(&event) else {
            record_event(state, thread_id, event);
            return;
        };
        let is_design_turn = lock(&self.live)
            .design
            .turns
            .get(turn_id)
            .is_some_and(|owner| owner == thread_id);
        if !is_design_turn {
            record_event(state, thread_id, event);
            return;
        }

        if let DomainEvent::ItemStarted { item } | DomainEvent::ItemCompleted { item } = &event
            && item.item_type == ItemType::Message
            && item.role == Some(MessageRole::User)
        {
            let replacement = lock(&self.live)
                .design
                .flows
                .get(thread_id)
                .filter(|flow| !flow.asked_questions)
                .map(|flow| flow.original_request.clone());
            if let Some(text) = replacement {
                let mut item = item.clone();
                item.text = Some(text);
                let visible = match event {
                    DomainEvent::ItemStarted { .. } => DomainEvent::ItemStarted { item },
                    DomainEvent::ItemCompleted { .. } => DomainEvent::ItemCompleted { item },
                    _ => unreachable!(),
                };
                record_event(state, thread_id, visible);
            }
            return;
        }

        if let DomainEvent::ItemStarted { item } = &event
            && item.item_type == ItemType::Message
            && item.role == Some(MessageRole::Assistant)
        {
            lock(&self.live)
                .design
                .message_items
                .insert(item.id.clone());
            return;
        }
        if let DomainEvent::ItemDelta { item_id, .. } = &event
            && lock(&self.live).design.message_items.contains(item_id)
        {
            return;
        }
        if let DomainEvent::ItemCompleted { item } = &event
            && item.item_type == ItemType::Message
            && item.role == Some(MessageRole::Assistant)
        {
            let already_accepted = {
                let mut live = lock(&self.live);
                live.design.message_items.remove(&item.id);
                live.design.accepted_outputs.contains(turn_id)
            };
            if already_accepted {
                return;
            }
            match self.accept_design_output(
                state,
                thread_id,
                turn_id,
                item.text.as_deref().unwrap_or_default(),
            ) {
                Ok(true) => {
                    let mut live = lock(&self.live);
                    if live
                        .design
                        .turns
                        .get(turn_id)
                        .is_some_and(|owner| owner == thread_id)
                    {
                        live.design.accepted_outputs.insert(turn_id.into());
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    lock(&self.live)
                        .design
                        .output_errors
                        .insert(turn_id.into(), error);
                }
            }
            return;
        }

        if let DomainEvent::TurnCompleted { status, .. } = &event {
            let (activity, accepted, output_error) = {
                let mut live = lock(&self.live);
                let activity = live.design.activity_items.remove(turn_id);
                let accepted = live.design.accepted_outputs.remove(turn_id);
                let output_error = live.design.output_errors.remove(turn_id);
                live.design.turns.remove(turn_id);
                (activity, accepted, output_error)
            };
            if let Some(mut item) = activity {
                item.status = if *status == TurnStatus::Completed {
                    ItemStatus::Completed
                } else {
                    ItemStatus::Failed
                };
                record_event(state, thread_id, DomainEvent::ItemCompleted { item });
            }
            if *status != TurnStatus::Completed {
                self.clear_design_flow(state, thread_id);
                record_event(state, thread_id, event);
                return;
            }

            let output_error = if accepted {
                None
            } else {
                Some(output_error.unwrap_or_else(|| {
                    "design response did not contain a completed assistant message".into()
                }))
            };
            let continuation =
                self.prepare_design_continuation(state, thread_id, output_error.as_deref());
            record_event(state, thread_id, event.clone());
            match continuation {
                Ok(DesignContinuation::None) => {}
                Ok(DesignContinuation::Prompt {
                    prompt,
                    attachments,
                }) => self.schedule_design_prompt(state, thread_id, prompt, attachments),
                Ok(DesignContinuation::Operation(operation)) => {
                    self.schedule_design_operation(state, thread_id, turn_id, operation)
                }
                Ok(DesignContinuation::Complete(summary)) => {
                    self.finish_design_flow(state, thread_id, turn_id, &summary);
                }
                Err(error) => self.fail_design_flow(state, thread_id, &error),
            }
            return;
        }

        record_event(state, thread_id, event);
    }

    fn prepare_design_continuation(
        &self,
        state: &ServerState,
        thread_id: &str,
        output_error: Option<&str>,
    ) -> Result<DesignContinuation, String> {
        let mut flow = self.take_design_flow(thread_id)?;
        if let Some(error) = output_error {
            if flow.correcting {
                self.put_design_flow(state, thread_id, flow)?;
                return Err(error.into());
            }
            flow.correcting = true;
            flow.pending_prompt = Some(design_phase_correction_prompt(error));
        }
        let continuation = if let Some(summary) = flow.completion.clone() {
            DesignContinuation::Complete(summary)
        } else if let Some(prompt) = flow.pending_prompt.take() {
            let attachments = design_attachments(&flow);
            DesignContinuation::Prompt {
                prompt,
                attachments,
            }
        } else if let Some(operation) = flow.pending_operation.take() {
            DesignContinuation::Operation(operation)
        } else {
            DesignContinuation::None
        };
        self.put_design_flow(state, thread_id, flow)?;
        Ok(continuation)
    }

    fn schedule_design_prompt(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        prompt: String,
        attachments: Vec<String>,
    ) {
        let weak_state = Arc::downgrade(state);
        let thread_id = thread_id.to_owned();
        let _ = thread::Builder::new()
            .name("harness-design-turn".into())
            .spawn(move || {
                let Some(state) = weak_state.upgrade() else {
                    return;
                };
                if let Err(error) =
                    state
                        .agents
                        .send_design_turn(&state, &thread_id, prompt, attachments)
                    && lock(&state.agents.live).design.owns_thread(&thread_id)
                {
                    state.agents.fail_design_flow(&state, &thread_id, &error);
                }
            });
    }

    fn schedule_design_operation(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        turn_id: &str,
        operation: DesignOperation,
    ) {
        let weak_state = Arc::downgrade(state);
        let thread_id = thread_id.to_owned();
        let turn_id = turn_id.to_owned();
        let _ = thread::Builder::new()
            .name("harness-design-preview".into())
            .spawn(move || {
                let Some(state) = weak_state.upgrade() else {
                    return;
                };
                if let Err(error) = state
                    .agents
                    .run_design_operation(&state, &thread_id, &turn_id, operation)
                    && lock(&state.agents.live).design.owns_thread(&thread_id)
                {
                    state.agents.fail_design_flow(&state, &thread_id, &error);
                }
            });
    }

    fn run_design_operation(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        turn_id: &str,
        operation: DesignOperation,
    ) -> Result<(), String> {
        let flow = lock(&self.live)
            .design
            .flows
            .get(thread_id)
            .cloned()
            .ok_or_else(|| "design flow is unavailable".to_owned())?;
        let plan = flow
            .preview_plan
            .clone()
            .ok_or_else(|| "Preview plan is unavailable".to_owned())?;
        let preview = if operation == DesignOperation::StartPreview {
            let old_preview = lock(&self.live).design.previews.remove(thread_id);
            if let Some(old_preview) = old_preview {
                let _ = old_preview.stop();
            }
            Arc::new(
                start_design_preview(
                    Path::new(&flow.workspace_path),
                    &plan,
                    Duration::from_secs(30),
                )
                .map_err(|error| error.to_string())?,
            )
        } else if let Some(preview) = lock(&self.live).design.previews.get(thread_id).cloned() {
            preview
        } else {
            Arc::new(
                start_design_preview(
                    Path::new(&flow.workspace_path),
                    &plan,
                    Duration::from_secs(30),
                )
                .map_err(|error| error.to_string())?,
            )
        };
        {
            let mut live = lock(&self.live);
            if live
                .design
                .flows
                .get(thread_id)
                .is_none_or(|current| current.id != flow.id)
            {
                drop(live);
                let _ = preview.stop();
                return Ok(());
            }
            live.design
                .previews
                .insert(thread_id.into(), Arc::clone(&preview));
        }
        {
            let mut current = self.take_design_flow(thread_id)?;
            current.preview_url = Some(preview.url().into());
            self.put_design_flow(state, thread_id, current)?;
        }

        let session = self.live_session(thread_id)?;
        if !session.capabilities().images {
            self.finish_without_visual_review(
                state,
                thread_id,
                turn_id,
                "the selected provider does not declare image support",
            );
            return Ok(());
        }
        if !state.preview_capture.available() {
            self.finish_without_visual_review(
                state,
                thread_id,
                turn_id,
                "desktop capture is unavailable",
            );
            return Ok(());
        }
        let screenshots = match state.preview_capture.capture(
            preview.url().into(),
            preview
                .viewports()
                .iter()
                .map(|viewport| harness_protocol::PreviewViewport {
                    width: viewport.width,
                    height: viewport.height,
                })
                .collect(),
        ) {
            Ok(screenshots) => screenshots,
            Err(crate::preview_capture::PreviewCaptureError::Unavailable) => {
                self.finish_without_visual_review(
                    state,
                    thread_id,
                    turn_id,
                    "desktop capture is unavailable",
                );
                return Ok(());
            }
            Err(error) => return Err(error.to_string()),
        };
        let screenshots = screenshots
            .into_iter()
            .map(|screenshot| ReviewScreenshot {
                path: screenshot.path,
                width: screenshot.width,
                height: screenshot.height,
            })
            .collect::<Vec<_>>();
        let mut current = self.take_design_flow(thread_id)?;
        current.phase = DesignFlowPhase::Review;
        current.screenshots = Some(screenshots);
        let prompt = prompt_for_phase(&current)?;
        let attachments = design_attachments(&current);
        self.put_design_flow(state, thread_id, current)?;
        self.schedule_design_prompt(state, thread_id, prompt, attachments);
        Ok(())
    }

    fn finish_without_visual_review(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
        turn_id: &str,
        reason: &str,
    ) {
        let preview_url = lock(&self.live)
            .design
            .flows
            .get(thread_id)
            .and_then(|flow| flow.preview_url.clone())
            .unwrap_or_else(|| "the local preview".into());
        self.finish_design_flow(
            state,
            thread_id,
            turn_id,
            &format!("Preview ready at {preview_url}. Visual review skipped because {reason}."),
        );
    }

    fn checkpoint(&self, state: &ServerState, thread_id: &str, label: &str) {
        let stored = lock(&state.store).thread(thread_id).ok().flatten();
        let Some(stored) = stored else {
            return;
        };
        let path = stored.worktree_path.unwrap_or(stored.project_path);
        let Ok(snapshot) = harness_workspace::take_snapshot(path) else {
            return;
        };
        let store = lock(&state.store);
        let Ok(seq) = store.last_seq(thread_id) else {
            return;
        };
        let label = label.trim().chars().take(60).collect::<String>();
        let _ = store.add_checkpoint(NewCheckpoint {
            thread_id: thread_id.into(),
            seq,
            commit: snapshot.commit,
            label: if label.is_empty() {
                "Turn".into()
            } else {
                label
            },
        });
    }

    fn ensure_session(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
    ) -> Result<Arc<dyn AgentSession>, String> {
        if let Some(session) = lock(&self.live).sessions.get(thread_id).cloned() {
            return Ok(session);
        }
        let (slot, leader) = {
            let mut resumes = lock(&self.resumes);
            match resumes.get(thread_id) {
                Some(slot) => (Arc::clone(slot), false),
                None => {
                    let slot = Arc::new(ResumeSlot::new());
                    resumes.insert(thread_id.into(), Arc::clone(&slot));
                    (slot, true)
                }
            }
        };
        if leader {
            let result = self.resume_session(state, thread_id);
            *lock(&slot.result) = Some(result.clone());
            slot.ready.notify_all();
            lock(&self.resumes).remove(thread_id);
            result
        } else {
            let mut result = lock(&slot.result);
            while result.is_none() {
                result = slot
                    .ready
                    .wait(result)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            result.clone().expect("resume result disappeared")
        }
    }

    fn project_session(
        &self,
        state: &ServerState,
        provider: ProviderId,
        project_path: &str,
    ) -> Result<Option<ProjectSession>, String> {
        let candidates = {
            let live = lock(&self.live);
            live.session_order
                .iter()
                .filter_map(|thread_id| {
                    live.sessions
                        .get(thread_id)
                        .cloned()
                        .map(|session| (thread_id.clone(), session))
                })
                .collect::<Vec<_>>()
        };
        let store = lock(&state.store);
        for (thread_id, session) in candidates {
            let Some(thread) = store
                .thread(&thread_id)
                .map_err(|error| error.to_string())?
            else {
                continue;
            };
            if thread.closed_at.is_none()
                && thread.provider == provider
                && thread.project_path == project_path
            {
                return Ok(Some((thread_id, session)));
            }
        }
        Ok(None)
    }

    fn mcp_runtime_config(
        &self,
        state: &ServerState,
        provider: ProviderId,
        project_path: &str,
    ) -> Result<(Vec<McpServerConfig>, CredentialValues), String> {
        if !self.runtimes.mcp_capabilities(provider).add {
            return Ok((Vec::new(), CredentialValues::default()));
        }
        let servers = lock(&state.mcp_config)
            .list(provider, project_path)
            .map_err(|error| error.to_string())?;
        let mut credentials = CredentialValues::default();
        for server in servers.iter().filter(|server| server.enabled) {
            let values = match server.transport.as_ref() {
                Some(McpTransport::Stdio { environment, .. }) => environment.as_ref(),
                Some(McpTransport::Http { headers, .. }) => headers.as_ref(),
                None => None,
            };
            for value in values.into_iter().flat_map(|values| values.values()) {
                let McpConfigValue::Credential { credential_ref } = value else {
                    continue;
                };
                if credentials.get(credential_ref).is_none() {
                    let secret = state
                        .credentials
                        .read(credential_ref)
                        .map_err(|error| error.to_string())?;
                    credentials.insert(credential_ref.clone(), secret);
                }
            }
        }
        Ok((servers, credentials))
    }

    fn control(
        &self,
        state: &Arc<ServerState>,
        provider: ProviderId,
        agent: Option<&str>,
    ) -> Result<Arc<dyn ProviderControl>, String> {
        let key = ControlKey {
            provider,
            agent: agent.map(str::to_owned),
        };
        if let Some(control) = lock(&self.controls).get(&key).cloned() {
            return Ok(control);
        }
        let (slot, leader) = {
            let mut starts = lock(&self.control_starts);
            match starts.get(&key) {
                Some(slot) => (Arc::clone(slot), false),
                None => {
                    let slot = Arc::new(ControlSlot::new());
                    starts.insert(key.clone(), Arc::clone(&slot));
                    (slot, true)
                }
            }
        };
        if leader {
            let result = self.open_control(state, &key);
            if let Ok(control) = &result {
                lock(&self.controls).insert(key.clone(), Arc::clone(control));
            }
            *lock(&slot.result) = Some(result.clone());
            slot.ready.notify_all();
            lock(&self.control_starts).remove(&key);
            result
        } else {
            let mut result = lock(&slot.result);
            while result.is_none() {
                result = slot
                    .ready
                    .wait(result)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            result.clone().expect("control result disappeared")
        }
    }

    fn open_control(
        &self,
        state: &Arc<ServerState>,
        key: &ControlKey,
    ) -> Result<Arc<dyn ProviderControl>, String> {
        let runtime = self
            .runtimes
            .runtime(key.provider, key.agent.as_deref(), None)
            .map_err(|error| error.to_string())?;
        let auth_state = Arc::downgrade(state);
        let provider = key.provider;
        let agent = key.agent.clone();
        let mcp_state = Arc::downgrade(state);
        let mcp_projects = Arc::clone(&self.watched_mcp_projects);
        let skill_state = Arc::downgrade(state);
        let skill_projects = Arc::clone(&self.watched_skill_projects);
        runtime
            .open_control(
                ControlHandlers::new(
                    move |event| {
                        if let Some(state) = auth_state.upgrade() {
                            let _ = state.push.broadcast(
                                channel::AUTH_EVENT,
                                AuthEventPush {
                                    provider,
                                    agent: agent.clone(),
                                    login_id: event.login_id,
                                    success: event.success,
                                    error: event.error,
                                },
                            );
                        }
                    },
                    |line| eprintln!("[agent control] {line}"),
                )
                .with_mcp_changed(move |_| {
                    if let Some(state) = mcp_state.upgrade() {
                        broadcast_watched_projects(
                            &state,
                            &mcp_projects,
                            channel::MCP_CHANGED,
                            provider,
                        );
                    }
                })
                .with_skills_changed(move || {
                    if let Some(state) = skill_state.upgrade() {
                        broadcast_watched_projects(
                            &state,
                            &skill_projects,
                            channel::SKILLS_CHANGED,
                            provider,
                        );
                    }
                }),
            )
            .map_err(|error| error.to_string())
    }

    fn resume_session(
        &self,
        state: &Arc<ServerState>,
        thread_id: &str,
    ) -> Result<Arc<dyn AgentSession>, String> {
        let (stored, connection_id, resume_state) = {
            let store = lock(&state.store);
            let stored = store
                .thread(thread_id)
                .map_err(|error| error.to_string())?
                .filter(|thread| thread.closed_at.is_none())
                .ok_or_else(|| format!("no such thread: {thread_id}"))?;
            let connection_id = store
                .thread_connection_id(thread_id)
                .map_err(|error| error.to_string())?;
            let resume_state = store
                .provider_session_state(thread_id)
                .map_err(|error| error.to_string())?;
            (stored, connection_id, resume_state)
        };
        let runtime = self
            .runtimes
            .runtime(
                stored.provider,
                stored.agent.as_deref(),
                connection_id.as_deref(),
            )
            .map_err(|error| error.to_string())?;
        let bridge = Arc::new(EventBridge::new(Arc::downgrade(state)));
        let event_bridge = Arc::clone(&bridge);
        let handlers = session_handlers(
            state,
            event_bridge,
            stored.provider,
            stored.project_path.clone(),
        );
        let workspace = stored
            .worktree_path
            .as_deref()
            .unwrap_or(&stored.project_path);
        let (mcp_servers, mcp_credentials) =
            self.mcp_runtime_config(state, stored.provider, &stored.project_path)?;
        let options = StartOptions {
            mcp_servers,
            mcp_credentials,
            resume_state: resume_state.map(AgentSessionState::new),
            ..StartOptions::default()
        };
        let (thread, session) = runtime
            .resume(thread_id, workspace, &options, handlers)
            .map_err(|error| error.to_string())?;
        if thread.id != thread_id {
            session.dispose();
            return Err(format!("provider resumed unexpected thread {}", thread.id));
        }
        if lock(&state.store)
            .thread(thread_id)
            .map_err(|error| error.to_string())?
            .is_none_or(|thread| thread.closed_at.is_some())
        {
            session.dispose();
            return Err(format!("thread {thread_id} was closed while resuming"));
        }
        self.attach_session(thread_id, Arc::clone(&session), &bridge);
        self.restore_design_flow(state, thread_id, workspace);
        bridge.attach(thread_id.into());
        Ok(session)
    }

    fn restore_design_flow(&self, state: &Arc<ServerState>, thread_id: &str, workspace_path: &str) {
        let (stored, history) = {
            let store = lock(&state.store);
            let stored = store.design_run(thread_id).ok().flatten();
            let history = store.history(thread_id, 0).unwrap_or_default();
            (stored, history)
        };
        let Some(mut flow) =
            stored.and_then(|value| parse_stored_design_flow(value, workspace_path.to_owned()))
        else {
            return;
        };
        let flow_id = flow.id.clone();
        let pending_prompt = flow.pending_prompt.take();
        let pending_operation = flow.pending_operation.take();
        let completion = flow.completion.clone();
        {
            let mut live = lock(&self.live);
            live.design.flows.insert(thread_id.into(), flow.clone());
            if let Some(bridge) = live.event_bridges.get(thread_id).and_then(Weak::upgrade) {
                bridge.set_design_active(true);
            }
            if let Some((request_id, mut input)) = unresolved_design_input(&history) {
                input.thread_id = thread_id.into();
                live.design
                    .input_by_thread
                    .insert(thread_id.into(), request_id.clone());
                live.design.inputs.insert(request_id, input);
                return;
            }
            if let Some(turn_id) = open_turn(&history) {
                live.design.turns.insert(turn_id, thread_id.into());
                return;
            }
        }

        if let Some(summary) = completion {
            self.finish_design_flow(
                state,
                thread_id,
                &format!("design-resumed-{}", Uuid::new_v4()),
                &summary,
            );
            return;
        }
        if let Some(operation) = pending_operation {
            if lock(&self.live)
                .design
                .flows
                .get(thread_id)
                .is_some_and(|current| current.id == flow_id)
            {
                let _ = self.persist_design_flow(state, thread_id);
                self.schedule_design_operation(
                    state,
                    thread_id,
                    &format!("design-resumed-{}", Uuid::new_v4()),
                    operation,
                );
            }
            return;
        }
        let prompt = match pending_prompt {
            Some(prompt) => Ok(prompt),
            None => prompt_for_phase(&flow),
        };
        match prompt {
            Ok(prompt) => {
                if let Err(error) = self.persist_design_flow(state, thread_id) {
                    self.fail_design_flow(state, thread_id, &error);
                    return;
                }
                self.schedule_design_prompt(state, thread_id, prompt, design_attachments(&flow));
            }
            Err(error) => self.fail_design_flow(state, thread_id, &error),
        }
    }

    fn attach_session(
        &self,
        thread_id: &str,
        session: Arc<dyn AgentSession>,
        bridge: &Arc<EventBridge>,
    ) {
        let (previous, previous_bridge) = {
            let mut live = lock(&self.live);
            if !live.sessions.contains_key(thread_id) {
                live.session_order.push(thread_id.into());
            }
            let previous = live.sessions.insert(thread_id.into(), session);
            let previous_bridge = live
                .event_bridges
                .insert(thread_id.into(), Arc::downgrade(bridge))
                .and_then(|bridge| bridge.upgrade());
            (previous, previous_bridge)
        };
        if let Some(previous_bridge) = previous_bridge {
            previous_bridge.set_design_active(false);
        }
        if let Some(previous) = previous {
            previous.dispose();
        }
    }

    fn live_session(&self, thread_id: &str) -> Result<Arc<dyn AgentSession>, String> {
        lock(&self.live)
            .sessions
            .get(thread_id)
            .cloned()
            .ok_or_else(|| format!("no such live thread: {thread_id}"))
    }

    fn export_provider_session_state(&self, thread_id: &str) -> Option<AgentSessionState> {
        let session = lock(&self.live).sessions.get(thread_id).cloned()?;
        match session.export_state() {
            Ok(state) => state,
            Err(_) => {
                eprintln!("[server] could not export provider state for {thread_id}");
                None
            }
        }
    }

    fn notify_queue(&self, state: &ServerState, thread_id: &str) {
        let queue = {
            let live = lock(&self.live);
            let result = queue_result(&live, thread_id);
            ThreadQueuePush {
                thread_id: thread_id.into(),
                items: result.items,
                can_steer: result.can_steer,
            }
        };
        let _ = state.push.broadcast(channel::THREAD_QUEUE, queue);
    }

    fn drain_queue(&self, state: &Arc<ServerState>, thread_id: &str) {
        if self.panic_stopping.load(Ordering::Acquire) {
            return;
        }
        let selected = {
            let mut live = lock(&self.live);
            if live.active_turns.contains(thread_id)
                || live.starting_turns.contains(thread_id)
                || live.design.owns_thread(thread_id)
                || !live.draining.insert(thread_id.into())
            {
                return;
            }
            let entry = live.queues.get_mut(thread_id).and_then(VecDeque::pop_front);
            let session = live.sessions.get(thread_id).cloned();
            match (entry, session) {
                (Some(entry), Some(session)) => {
                    live.starting_turns.insert(thread_id.into());
                    Some((entry, session))
                }
                (entry, _) => {
                    if let Some(entry) = entry {
                        live.queues
                            .entry(thread_id.into())
                            .or_default()
                            .push_front(entry);
                    }
                    live.draining.remove(thread_id);
                    None
                }
            }
        };
        let Some((entry, session)) = selected else {
            return;
        };
        self.notify_queue(state, thread_id);
        let result = self.run_started_turn(
            state,
            thread_id,
            &entry.turn.text,
            &entry.turn.attachments,
            &entry.options,
            &session,
        );
        {
            let mut live = lock(&self.live);
            live.draining.remove(thread_id);
            if let Err(error) = &result {
                eprintln!("[agent] queued turn failed: {error}");
                live.queues
                    .entry(thread_id.into())
                    .or_default()
                    .push_front(entry);
            }
        }
        self.notify_queue(state, thread_id);
    }
}

fn unsupported_mcp_capabilities() -> McpCapabilities {
    McpCapabilities {
        inventory: false,
        add: false,
        update: false,
        remove: false,
        reload: false,
        start_o_auth: false,
        cancel_o_auth: false,
    }
}

fn unsupported_skill_capabilities() -> SkillCapabilities {
    SkillCapabilities {
        inventory: false,
        configure: false,
        install: false,
    }
}

fn session_handlers(
    state: &Arc<ServerState>,
    event_bridge: Arc<EventBridge>,
    provider: ProviderId,
    project_path: String,
) -> AgentHandlers {
    let oauth_state = Arc::downgrade(state);
    let oauth_project = project_path.clone();
    let mcp_state = Arc::downgrade(state);
    let mcp_project = project_path.clone();
    let skills_state = Arc::downgrade(state);
    AgentHandlers::new(
        move |event| event_bridge.emit(event),
        |line| eprintln!("[agent] {line}"),
    )
    .with_control_handlers(
        ControlHandlers::new(|_| {}, |_| {})
            .with_mcp_o_auth(move |event| {
                if let Some(state) = oauth_state.upgrade() {
                    let _ = state.push.broadcast(
                        channel::MCP_OAUTH,
                        McpOAuthPush {
                            provider,
                            project_path: oauth_project.clone(),
                            server_id: event.server_id,
                            login_id: event.login_id,
                            success: event.success,
                            error: event.error,
                        },
                    );
                }
            })
            .with_mcp_changed(move |_| {
                if let Some(state) = mcp_state.upgrade() {
                    broadcast_project_changed(&state, channel::MCP_CHANGED, provider, &mcp_project);
                }
            })
            .with_skills_changed(move || {
                if let Some(state) = skills_state.upgrade() {
                    broadcast_project_changed(
                        &state,
                        channel::SKILLS_CHANGED,
                        provider,
                        &project_path,
                    );
                }
            }),
    )
}

fn watch_project(
    projects: &Mutex<HashMap<ProviderId, HashSet<String>>>,
    provider: ProviderId,
    project_path: &str,
) {
    lock(projects)
        .entry(provider)
        .or_default()
        .insert(project_path.into());
}

fn broadcast_watched_projects(
    state: &ServerState,
    projects: &Mutex<HashMap<ProviderId, HashSet<String>>>,
    channel_name: &str,
    provider: ProviderId,
) {
    let projects = lock(projects).get(&provider).cloned().unwrap_or_default();
    for project_path in projects {
        broadcast_project_changed(state, channel_name, provider, &project_path);
    }
}

fn broadcast_project_changed(
    state: &ServerState,
    channel_name: &str,
    provider: ProviderId,
    project_path: &str,
) {
    let _ = state.push.broadcast(
        channel_name,
        serde_json::json!({ "provider": provider, "projectPath": project_path }),
    );
}

struct EventBridge {
    state: Weak<ServerState>,
    route: Mutex<EventRoute>,
    design_active: AtomicBool,
}

#[derive(Default)]
struct EventRoute {
    thread_id: Option<String>,
    buffered: Vec<DomainEvent>,
}

impl EventBridge {
    fn new(state: Weak<ServerState>) -> Self {
        Self {
            state,
            route: Mutex::new(EventRoute::default()),
            design_active: AtomicBool::new(false),
        }
    }

    fn set_design_active(&self, active: bool) {
        self.design_active.store(active, Ordering::Release);
    }

    fn forward(&self, state: &Arc<ServerState>, thread_id: &str, event: DomainEvent) {
        if self.design_active.load(Ordering::Acquire) {
            state.agents.handle_session_event(state, thread_id, event);
        } else {
            record_event(state, thread_id, event);
        }
    }

    fn emit(&self, event: DomainEvent) {
        let mut route = lock(&self.route);
        let Some(thread_id) = route.thread_id.clone() else {
            route.buffered.push(event);
            return;
        };
        drop(route);
        if let Some(state) = self.state.upgrade() {
            self.forward(&state, &thread_id, event);
        }
    }

    fn attach(&self, thread_id: String) {
        let buffered = {
            let mut route = lock(&self.route);
            route.thread_id = Some(thread_id.clone());
            std::mem::take(&mut route.buffered)
        };
        if let Some(state) = self.state.upgrade() {
            for event in buffered {
                self.forward(&state, &thread_id, event);
            }
        }
    }
}

fn record_event(state: &Arc<ServerState>, thread_id: &str, event: DomainEvent) {
    let terminal = matches!(
        event,
        DomainEvent::TurnCompleted { .. } | DomainEvent::ThreadError { .. }
    );
    let provider_state = terminal
        .then(|| state.agents.export_provider_session_state(thread_id))
        .flatten();
    let lifecycle = {
        let mut store = lock(&state.store);
        let provider_state = provider_state.as_ref().map(AgentSessionState::value);
        let Ok(seq) = store.append_with_provider_state(thread_id, &event, provider_state) else {
            eprintln!("[server] could not persist agent event for {thread_id}");
            return;
        };
        let lifecycle = store.touch_thread(thread_id, terminal, None).ok();
        if state
            .push
            .broadcast(
                channel::THREAD_EVENT,
                ThreadEventPush {
                    thread_id: thread_id.into(),
                    event: event.clone(),
                    seq: Some(seq),
                },
            )
            .is_err()
        {
            eprintln!("[server] could not encode agent event for {thread_id}");
        }
        lifecycle
    };
    if let Some(lifecycle) = lifecycle {
        let _ = state.push.broadcast(
            channel::THREAD_LIFECYCLE,
            ThreadLifecyclePush {
                thread_id: thread_id.into(),
                lifecycle,
            },
        );
    }
    {
        let mut live = lock(&state.agents.live);
        match event {
            DomainEvent::TurnStarted { .. } => {
                live.active_turns.insert(thread_id.into());
            }
            DomainEvent::TurnCompleted { .. } | DomainEvent::ThreadError { .. } => {
                live.active_turns.remove(thread_id);
                if live.starting_turns.contains(thread_id) {
                    live.terminal_while_starting.insert(thread_id.into());
                }
            }
            _ => return,
        }
    }
    if terminal {
        schedule_drain(state, thread_id.into());
    }
}

fn schedule_drain(state: &Arc<ServerState>, thread_id: String) {
    let state = Arc::downgrade(state);
    let _ = thread::Builder::new()
        .name("harness-queue-drain".into())
        .spawn(move || {
            if let Some(state) = state.upgrade() {
                state.agents.drain_queue(&state, &thread_id);
            }
        });
}

fn queue_result(live: &LiveState, thread_id: &str) -> ThreadQueueResult {
    let items = live
        .queues
        .get(thread_id)
        .into_iter()
        .flatten()
        .map(|entry| entry.turn.clone())
        .collect();
    let can_steer = live
        .sessions
        .get(thread_id)
        .is_some_and(|session| session.capabilities().steer);
    ThreadQueueResult { items, can_steer }
}

fn event_turn_id(event: &DomainEvent) -> Option<&str> {
    match event {
        DomainEvent::TurnStarted { turn } => Some(&turn.id),
        DomainEvent::ItemStarted { item } | DomainEvent::ItemCompleted { item } => {
            Some(&item.turn_id)
        }
        DomainEvent::ItemDelta { turn_id, .. }
        | DomainEvent::TurnCompleted { turn_id, .. }
        | DomainEvent::PlanUpdated { turn_id, .. }
        | DomainEvent::DiffUpdated { turn_id, .. } => Some(turn_id),
        DomainEvent::UserInputRequested { request } => Some(&request.turn_id),
        DomainEvent::ApprovalReviewStarted { review }
        | DomainEvent::ApprovalReviewCompleted { review } => Some(&review.turn_id),
        DomainEvent::ThreadStarted { .. }
        | DomainEvent::ThreadError { .. }
        | DomainEvent::UsageUpdated { .. }
        | DomainEvent::ApprovalRequested { .. }
        | DomainEvent::ApprovalResolved { .. }
        | DomainEvent::UserInputResolved { .. } => None,
    }
}

fn design_phase_key(phase: DesignFlowPhase) -> &'static str {
    match phase {
        DesignFlowPhase::Brief => "brief",
        DesignFlowPhase::Brand => "brand",
        DesignFlowPhase::Page => "page",
        DesignFlowPhase::Assets => "assets",
        DesignFlowPhase::Build => "build",
        DesignFlowPhase::Preview => "preview",
        DesignFlowPhase::Review => "review",
        DesignFlowPhase::Repair => "repair",
        DesignFlowPhase::Complete => "complete",
    }
}

fn cleanup_failed_worktree(worktree: Option<&Worktree>) {
    if let Some(worktree) = worktree {
        let _ = harness_workspace::remove_worktree(worktree, true);
    }
}

fn same_path(left: &str, right: &std::path::Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| PathBuf::from(left));
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    #[cfg(target_os = "windows")]
    return left
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy());
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn path_inside(root: &std::path::Path, candidate: &str) -> bool {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let candidate = std::fs::canonicalize(candidate).unwrap_or_else(|_| PathBuf::from(candidate));
    #[cfg(target_os = "windows")]
    {
        let root = root.to_string_lossy().to_lowercase();
        let candidate = candidate.to_string_lossy().to_lowercase();
        return candidate == root
            || candidate
                .strip_prefix(&root)
                .and_then(|suffix| suffix.as_bytes().first())
                .is_some_and(|separator| matches!(separator, b'\\' | b'/'));
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidate == root || candidate.strip_prefix(root).is_ok()
    }
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

fn timestamp_i64(timestamp: f64) -> i64 {
    if timestamp.is_finite() {
        timestamp.clamp(i64::MIN as f64, i64::MAX as f64) as i64
    } else {
        0
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
