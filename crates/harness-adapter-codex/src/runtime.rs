use crate::{
    map_domain_notification,
    mcp::{
        CODEX_MCP_CAPABILITIES, PreparedMcpConfig, map_server_status, map_startup_status,
        prepare_mcp_config,
    },
    skills::map_skill_list,
    voice::{self, AuthStatus},
};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentRuntime, AgentSession, CancellationToken,
    ControlHandlers, CredentialValues, LoginEvent, McpOAuthEvent, ProviderControl, StartOptions,
    TurnOptions,
};
use harness_proc::{
    JsonRpcError, ProcessError, RpcResponder, SpawnOptions, StdioJsonRpc, spawn_cli,
};
use harness_protocol::{
    Account, ApprovalDecision, ApprovalKind, ApprovalMode, ApprovalRequest, AuthStartLoginResult,
    Capabilities, DomainEvent, McpListResult, McpOAuthStartResult, McpServer, McpServerConfig,
    McpStartupStatus, Model, ProviderId, ServiceTier, SkillsListResult, Thread, UserInputOption,
    UserInputQuestion, UserInputRequest, VoiceStatusResult, VoiceTranscribeParams,
};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::ffi::{OsStr, OsString};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

const CLIENT_NAME: &str = "personal-harness";
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub const CODEX_CAPABILITIES: Capabilities = Capabilities {
    steer: true,
    fork: true,
    interrupt: true,
    reasoning_items: true,
    approvals: true,
    user_input: Some(true),
    auto_review: Some(true),
    images: true,
};

pub type CodexHandlers = AgentHandlers;

pub struct CodexLaunchOptions {
    /// Extra process environment, primarily isolated MCP credentials.
    pub environment: Vec<(OsString, OsString)>,
    pub request_timeout: Duration,
}

impl Default for CodexLaunchOptions {
    fn default() -> Self {
        Self {
            environment: Vec::new(),
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
        }
    }
}

pub struct CodexRuntime {
    environment: Vec<(OsString, OsString)>,
    request_timeout: Duration,
}

impl CodexRuntime {
    pub fn new(options: CodexLaunchOptions) -> Self {
        Self {
            environment: options.environment,
            request_timeout: options.request_timeout,
        }
    }

    fn launch_options(&self) -> CodexLaunchOptions {
        CodexLaunchOptions {
            environment: self.environment.clone(),
            request_timeout: self.request_timeout,
        }
    }
}

impl Default for CodexRuntime {
    fn default() -> Self {
        Self::new(CodexLaunchOptions::default())
    }
}

#[derive(Debug, Error)]
pub enum CodexAdapterError {
    #[error(transparent)]
    Process(#[from] ProcessError),
    #[error(transparent)]
    JsonRpc(#[from] JsonRpcError),
    #[error("{method} returned an invalid response: {message}")]
    InvalidResponse {
        method: &'static str,
        message: String,
    },
    #[error("{0}")]
    Configuration(String),
    #[error("{0}")]
    Voice(String),
}

struct PendingApproval {
    kind: ApprovalKind,
    responder: RpcResponder,
}

#[derive(Default)]
struct PendingRequests {
    approvals: HashMap<String, PendingApproval>,
    user_inputs: HashMap<String, RpcResponder>,
}

struct McpLogin {
    key: String,
    server_id: String,
    login_id: String,
}

pub struct CodexAdapter {
    rpc: StdioJsonRpc,
    pending: Arc<Mutex<PendingRequests>>,
    mcp_startup: Arc<Mutex<HashMap<String, McpStartupStatus>>>,
    mcp_logins: Arc<Mutex<Vec<McpLogin>>>,
    mcp_servers: Mutex<Map<String, Value>>,
    mcp_environment: BTreeMap<String, String>,
    handlers: CodexHandlers,
    request_timeout: Duration,
}

impl CodexAdapter {
    /// Spawn `codex app-server` and complete its initialize handshake.
    pub fn launch(
        options: CodexLaunchOptions,
        handlers: CodexHandlers,
    ) -> Result<Self, CodexAdapterError> {
        let args = [
            OsStr::new("app-server"),
            OsStr::new("--enable"),
            OsStr::new("default_mode_request_user_input"),
        ];
        let spawn_options = SpawnOptions {
            environment: options.environment,
            ..SpawnOptions::default()
        };
        Self::launch_process(
            OsStr::new("codex"),
            &args,
            &spawn_options,
            handlers,
            options.request_timeout,
        )
    }

    fn launch_process(
        program: &OsStr,
        args: &[&OsStr],
        spawn_options: &SpawnOptions,
        handlers: CodexHandlers,
        request_timeout: Duration,
    ) -> Result<Self, CodexAdapterError> {
        let child = spawn_cli(program, args, spawn_options)?;
        let rpc = StdioJsonRpc::new(child, "codex app-server")?;
        let pending = Arc::new(Mutex::new(PendingRequests::default()));
        let mcp_startup = Arc::new(Mutex::new(HashMap::new()));
        let mcp_logins = Arc::new(Mutex::new(Vec::new()));
        configure_handlers(
            &rpc,
            Arc::clone(&pending),
            Arc::clone(&mcp_startup),
            Arc::clone(&mcp_logins),
            handlers.clone(),
        );
        rpc.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": CLIENT_NAME,
                    "title": "Personal Harness",
                    "version": "0.0.0"
                }
            }),
            request_timeout,
        )?;
        rpc.notify("initialized", json!({}))?;
        Ok(Self {
            rpc,
            pending,
            mcp_startup,
            mcp_logins,
            mcp_servers: Mutex::new(Map::new()),
            mcp_environment: BTreeMap::new(),
            handlers,
            request_timeout,
        })
    }

    /// Ask the provider binary about its account without reading credentials.
    pub fn account(&self) -> Account {
        let Ok(response) = self.call("account/read", json!({})) else {
            return Account {
                signed_in: false,
                email: None,
                plan: None,
            };
        };
        let Some(account) = response.get("account").filter(|value| !value.is_null()) else {
            return Account {
                signed_in: false,
                email: None,
                plan: None,
            };
        };
        match account.get("type").and_then(Value::as_str) {
            Some("apiKey") => Account {
                signed_in: true,
                email: None,
                plan: Some("API key".into()),
            },
            Some("chatgpt") => Account {
                signed_in: true,
                email: account
                    .get("email")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                plan: account
                    .get("planType")
                    .and_then(Value::as_str)
                    .map(plan_label)
                    .or_else(|| Some("Signed in".into())),
            },
            Some(_) => Account {
                signed_in: true,
                email: None,
                plan: None,
            },
            None => Account {
                signed_in: false,
                email: None,
                plan: None,
            },
        }
    }

    pub fn start_login(&self) -> Result<AuthStartLoginResult, CodexAdapterError> {
        let method = "account/login/start";
        let response = self.call(method, json!({ "type": "chatgpt" }))?;
        if response.get("type").and_then(Value::as_str) != Some("chatgpt") {
            return Err(invalid(method, "unexpected login response type"));
        }
        Ok(AuthStartLoginResult {
            login_id: response_str(method, &response, &["loginId"])?.into(),
            auth_url: Some(response_str(method, &response, &["authUrl"])?.into()),
        })
    }

    pub fn cancel_login(&self, login_id: &str) -> Result<(), CodexAdapterError> {
        self.call("account/login/cancel", json!({ "loginId": login_id }))?;
        Ok(())
    }

    pub fn use_api_key(&self, api_key: &str) -> Result<Account, CodexAdapterError> {
        self.call(
            "account/login/start",
            json!({ "type": "apiKey", "apiKey": api_key }),
        )?;
        Ok(self.account())
    }

    pub fn sign_out(&self) -> Result<(), CodexAdapterError> {
        self.call("account/logout", json!({}))?;
        Ok(())
    }

    pub fn voice_status(&self) -> VoiceStatusResult {
        voice::capability(|include_token, refresh_token| {
            self.voice_auth_status(include_token, refresh_token)
        })
    }

    pub fn transcribe_voice(
        &self,
        input: &VoiceTranscribeParams,
        cancellation: &CancellationToken,
    ) -> Result<String, CodexAdapterError> {
        voice::transcribe(input, cancellation, |include_token, refresh_token| {
            self.voice_auth_status(include_token, refresh_token)
        })
        .map_err(|error| CodexAdapterError::Voice(error.to_string()))
    }

    pub fn list_models(&self) -> Result<Vec<Model>, CodexAdapterError> {
        let method = "model/list";
        let response = self.call(method, json!({}))?;
        let data = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid(method, "missing data array"))?;
        data.iter()
            .filter(|raw| !raw.get("hidden").and_then(Value::as_bool).unwrap_or(false))
            .map(|raw| map_model(method, raw))
            .collect()
    }

    pub fn list_mcp_servers(
        &self,
        thread_id: Option<&str>,
    ) -> Result<Vec<McpServer>, CodexAdapterError> {
        let method = "mcpServerStatus/list";
        let mut servers = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        loop {
            let mut params = Map::new();
            params.insert("detail".into(), Value::String("full".into()));
            insert_option(&mut params, "threadId", thread_id);
            insert_option(&mut params, "cursor", cursor.as_deref());
            let response = self.call(method, Value::Object(params))?;
            let data = response
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid(method, "missing data array"))?;
            for status in data {
                let server_id = status.get("name").and_then(Value::as_str).unwrap_or("");
                let startup = lock(&self.mcp_startup)
                    .get(&mcp_startup_key(thread_id, server_id))
                    .cloned();
                servers.push(
                    map_server_status(status, startup.as_ref())
                        .map_err(|message| invalid(method, &message))?,
                );
            }
            cursor = match response.get("nextCursor") {
                None | Some(Value::Null) => None,
                Some(Value::String(cursor)) if !cursor.is_empty() => Some(cursor.clone()),
                Some(_) => return Err(invalid(method, "invalid nextCursor")),
            };
            let Some(next) = cursor.as_ref() else {
                break;
            };
            if !seen.insert(next.clone()) {
                return Err(invalid(method, "repeated nextCursor"));
            }
        }
        Ok(servers)
    }

    pub fn start_mcp_o_auth(
        &self,
        server_id: &str,
        thread_id: &str,
    ) -> Result<McpOAuthStartResult, CodexAdapterError> {
        let method = "mcpServer/oauth/login";
        let key = mcp_startup_key(Some(thread_id), server_id);
        let login_id = Uuid::new_v4().to_string();
        {
            let mut logins = lock(&self.mcp_logins);
            logins.retain(|login| login.key != key);
            logins.push(McpLogin {
                key: key.clone(),
                server_id: server_id.into(),
                login_id: login_id.clone(),
            });
        }
        let response = match self.call(method, json!({ "name": server_id, "threadId": thread_id }))
        {
            Ok(response) => response,
            Err(error) => {
                lock(&self.mcp_logins)
                    .retain(|login| login.key != key || login.login_id != login_id);
                return Err(error);
            }
        };
        Ok(McpOAuthStartResult {
            login_id,
            auth_url: response_str(method, &response, &["authorizationUrl"])?.into(),
        })
    }

    pub fn reload_mcp_servers(
        &self,
        thread_id: &str,
        servers: &[McpServerConfig],
        credentials: &CredentialValues,
    ) -> Result<(), CodexAdapterError> {
        let prepared =
            prepare_mcp_config(servers, credentials).map_err(CodexAdapterError::Configuration)?;
        if prepared.environment.iter().any(|(name, value)| {
            self.mcp_environment.get(name).map(String::as_str) != Some(value.as_str())
        }) {
            return Err(CodexAdapterError::Configuration(
                "start a new session to apply new MCP credentials".into(),
            ));
        }
        let config = json!({ "mcp_servers": prepared.servers.clone() });
        let reload = self
            .call(
                "thread/resume",
                json!({ "threadId": thread_id, "config": config }),
            )
            .and_then(|_| self.call("config/mcpServer/reload", json!({})));
        if let Err(error) = reload {
            return Err(CodexAdapterError::Configuration(format!(
                "Codex could not hot-reload MCP config; start a new session to apply it: {error}"
            )));
        }
        *lock(&self.mcp_servers) = prepared.servers;
        self.handlers.emit_mcp_changed(Some(thread_id.into()));
        Ok(())
    }

    pub fn list_skills(&self, project_path: &str) -> Result<SkillsListResult, CodexAdapterError> {
        let method = "skills/list";
        let response = self.call(
            method,
            json!({ "cwds": [project_path], "forceReload": true }),
        )?;
        map_skill_list(&response, project_path, None).map_err(|message| invalid(method, &message))
    }

    pub fn set_skill_enabled(
        &self,
        skill_id: &str,
        enabled: bool,
    ) -> Result<bool, CodexAdapterError> {
        let method = "skills/config/write";
        let response = self.call(
            method,
            json!({ "path": skill_id, "name": null, "enabled": enabled }),
        )?;
        response
            .get("effectiveEnabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| invalid(method, "missing effectiveEnabled"))
    }

    pub fn start_thread(
        &self,
        workspace_path: &str,
        options: &StartOptions,
    ) -> Result<Thread, CodexAdapterError> {
        let method = "thread/start";
        let mut params = Map::new();
        params.insert("cwd".into(), Value::String(workspace_path.into()));
        insert_option(&mut params, "model", options.model.as_deref());
        insert_option(&mut params, "serviceTier", options.service_tier.as_deref());
        insert_option(
            &mut params,
            "developerInstructions",
            options.instructions.as_deref(),
        );
        params.insert(
            "config".into(),
            self.session_config(options.effort.as_deref()),
        );
        if let Some(mode) = options.approval {
            apply_approval_mode(&mut params, mode);
        }
        let response = self.call(method, Value::Object(params))?;
        Ok(Thread {
            id: response_str(method, &response, &["thread", "id"])?.into(),
            provider: ProviderId::Codex,
            connection_id: None,
            workspace_path: workspace_path.into(),
            title: None,
            created_at: now_ms(),
        })
    }

    pub fn resume_thread(
        &self,
        thread_id: &str,
        workspace_path: &str,
        options: &StartOptions,
    ) -> Result<Thread, CodexAdapterError> {
        let method = "thread/resume";
        let mut params = Map::new();
        params.insert("threadId".into(), Value::String(thread_id.into()));
        params.insert("cwd".into(), Value::String(workspace_path.into()));
        insert_option(
            &mut params,
            "developerInstructions",
            options.instructions.as_deref(),
        );
        params.insert(
            "config".into(),
            self.session_config(options.effort.as_deref()),
        );
        let response = self.call(method, Value::Object(params))?;
        let created_at = response
            .pointer("/thread/createdAt")
            .and_then(Value::as_f64)
            .map(normalize_timestamp_ms)
            .unwrap_or_else(now_ms);
        Ok(Thread {
            id: response_str(method, &response, &["thread", "id"])?.into(),
            provider: ProviderId::Codex,
            connection_id: None,
            workspace_path: workspace_path.into(),
            title: None,
            created_at,
        })
    }

    pub fn send_turn(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        options: &TurnOptions,
    ) -> Result<String, CodexAdapterError> {
        let method = "turn/start";
        let mut params = Map::new();
        params.insert("threadId".into(), Value::String(thread_id.into()));
        insert_option(&mut params, "model", options.model.as_deref());
        insert_option(&mut params, "serviceTier", options.service_tier.as_deref());
        insert_option(&mut params, "effort", options.effort.as_deref());
        let mut input = vec![json!({ "type": "text", "text": text, "text_elements": [] })];
        input.extend(attachments.iter().map(|path| {
            if is_image(path) {
                json!({ "type": "localImage", "path": path })
            } else {
                json!({ "type": "mention", "name": basename(path), "path": path })
            }
        }));
        params.insert("input".into(), Value::Array(input));
        let response = self.call(method, Value::Object(params))?;
        Ok(response_str(method, &response, &["turn", "id"])?.into())
    }

    pub fn steer(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
    ) -> Result<(), CodexAdapterError> {
        let input = turn_input(text, attachments);
        self.call(
            "turn/steer",
            json!({ "threadId": thread_id, "input": input }),
        )?;
        Ok(())
    }

    pub fn interrupt(&self, thread_id: &str) -> Result<(), CodexAdapterError> {
        self.call("turn/interrupt", json!({ "threadId": thread_id }))?;
        Ok(())
    }

    pub fn respond_to_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<bool, CodexAdapterError> {
        let pending = lock(&self.pending).approvals.remove(approval_id);
        let Some(pending) = pending else {
            return Ok(false);
        };
        pending.responder.respond(json!({
            "decision": decision_value(pending.kind, decision)
        }))?;
        self.handlers.emit_event(DomainEvent::ApprovalResolved {
            id: approval_id.into(),
        });
        Ok(true)
    }

    pub fn respond_to_user_input(
        &self,
        request_id: &str,
        answers: &HashMap<String, Vec<String>>,
    ) -> Result<bool, CodexAdapterError> {
        let responder = lock(&self.pending).user_inputs.remove(request_id);
        let Some(responder) = responder else {
            return Ok(false);
        };
        let answers = answers
            .iter()
            .map(|(question, values)| (question.clone(), json!({ "answers": values })))
            .collect::<Map<_, _>>();
        responder.respond(json!({ "answers": answers }))?;
        self.handlers.emit_event(DomainEvent::UserInputResolved {
            id: request_id.into(),
        });
        Ok(true)
    }

    pub fn dispose(&self) {
        lock(&self.pending).approvals.clear();
        lock(&self.pending).user_inputs.clear();
        self.rpc.dispose();
    }

    fn call(&self, method: &'static str, params: Value) -> Result<Value, CodexAdapterError> {
        Ok(self.rpc.request(method, params, self.request_timeout)?)
    }

    fn voice_auth_status(
        &self,
        include_token: bool,
        refresh_token: bool,
    ) -> Result<AuthStatus, CodexAdapterError> {
        let method = "getAuthStatus";
        let response = self.call(
            method,
            json!({
                "includeToken": include_token,
                "refreshToken": refresh_token
            }),
        )?;
        let auth_method = optional_nullable_string(method, &response, "authMethod")?;
        let auth_token = optional_nullable_string(method, &response, "authToken")?;
        Ok(AuthStatus {
            method: auth_method,
            token: auth_token,
        })
    }

    fn session_config(&self, effort: Option<&str>) -> Value {
        let mut config = Map::new();
        if let Some(effort) = effort {
            config.insert(
                "model_reasoning_effort".into(),
                Value::String(effort.into()),
            );
        }
        config.insert(
            "mcp_servers".into(),
            Value::Object(lock(&self.mcp_servers).clone()),
        );
        Value::Object(config)
    }
}

impl Drop for CodexAdapter {
    fn drop(&mut self) {
        self.dispose();
    }
}

impl AgentSession for CodexAdapter {
    fn capabilities(&self) -> Capabilities {
        CODEX_CAPABILITIES
    }

    fn send_turn(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[String],
        options: &TurnOptions,
    ) -> AgentResult<String> {
        CodexAdapter::send_turn(self, thread_id, text, attachments, options).map_err(agent_error)
    }

    fn steer(&self, thread_id: &str, text: &str, attachments: &[String]) -> AgentResult<()> {
        CodexAdapter::steer(self, thread_id, text, attachments).map_err(agent_error)
    }

    fn interrupt(&self, thread_id: &str) -> AgentResult<()> {
        CodexAdapter::interrupt(self, thread_id).map_err(agent_error)
    }

    fn respond_to_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> AgentResult<bool> {
        CodexAdapter::respond_to_approval(self, approval_id, decision).map_err(agent_error)
    }

    fn respond_to_user_input(
        &self,
        request_id: &str,
        answers: &HashMap<String, Vec<String>>,
    ) -> AgentResult<bool> {
        CodexAdapter::respond_to_user_input(self, request_id, answers).map_err(agent_error)
    }

    fn list_mcp_servers(&self, thread_id: &str) -> AgentResult<McpListResult> {
        Ok(McpListResult {
            capabilities: CODEX_MCP_CAPABILITIES,
            servers: CodexAdapter::list_mcp_servers(self, Some(thread_id)).map_err(agent_error)?,
        })
    }

    fn reload_mcp_servers(
        &self,
        thread_id: &str,
        servers: &[McpServerConfig],
        credentials: &CredentialValues,
    ) -> AgentResult<()> {
        CodexAdapter::reload_mcp_servers(self, thread_id, servers, credentials).map_err(agent_error)
    }

    fn start_mcp_o_auth(
        &self,
        server_id: &str,
        thread_id: &str,
    ) -> AgentResult<McpOAuthStartResult> {
        CodexAdapter::start_mcp_o_auth(self, server_id, thread_id).map_err(agent_error)
    }

    fn dispose(&self) {
        CodexAdapter::dispose(self);
    }
}

impl ProviderControl for CodexAdapter {
    fn account(&self) -> AgentResult<Account> {
        Ok(CodexAdapter::account(self))
    }

    fn start_login(&self) -> AgentResult<AuthStartLoginResult> {
        CodexAdapter::start_login(self).map_err(agent_error)
    }

    fn cancel_login(&self, login_id: &str) -> AgentResult<()> {
        CodexAdapter::cancel_login(self, login_id).map_err(agent_error)
    }

    fn use_api_key(&self, api_key: &str) -> AgentResult<Account> {
        CodexAdapter::use_api_key(self, api_key).map_err(agent_error)
    }

    fn sign_out(&self) -> AgentResult<()> {
        CodexAdapter::sign_out(self).map_err(agent_error)
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        CodexAdapter::list_models(self).map_err(agent_error)
    }

    fn list_mcp_servers(&self) -> AgentResult<McpListResult> {
        Ok(McpListResult {
            capabilities: CODEX_MCP_CAPABILITIES,
            servers: CodexAdapter::list_mcp_servers(self, None).map_err(agent_error)?,
        })
    }

    fn list_skills(&self, project_path: &str) -> AgentResult<SkillsListResult> {
        CodexAdapter::list_skills(self, project_path).map_err(agent_error)
    }

    fn set_skill_enabled(&self, skill_id: &str, enabled: bool) -> AgentResult<bool> {
        CodexAdapter::set_skill_enabled(self, skill_id, enabled).map_err(agent_error)
    }

    fn voice_status(&self) -> AgentResult<VoiceStatusResult> {
        Ok(CodexAdapter::voice_status(self))
    }

    fn transcribe_voice(
        &self,
        input: &VoiceTranscribeParams,
        cancellation: &CancellationToken,
    ) -> AgentResult<String> {
        CodexAdapter::transcribe_voice(self, input, cancellation).map_err(agent_error)
    }

    fn dispose(&self) {
        CodexAdapter::dispose(self);
    }
}

impl AgentRuntime for CodexRuntime {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let adapter = self.launch_session(options, handlers)?;
        match adapter.start_thread(workspace_path, options) {
            Ok(thread) => Ok((thread, Arc::new(adapter))),
            Err(error) => {
                adapter.dispose();
                Err(agent_error(error))
            }
        }
    }

    fn resume(
        &self,
        thread_id: &str,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let adapter = self.launch_session(options, handlers)?;
        match adapter.resume_thread(thread_id, workspace_path, options) {
            Ok(thread) => Ok((thread, Arc::new(adapter))),
            Err(error) => {
                adapter.dispose();
                Err(agent_error(error))
            }
        }
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        let adapter = CodexAdapter::launch(self.launch_options(), AgentHandlers::default())
            .map_err(agent_error)?;
        let result = adapter.list_models().map_err(agent_error);
        adapter.dispose();
        result
    }

    fn open_control(&self, handlers: ControlHandlers) -> AgentResult<Arc<dyn ProviderControl>> {
        let log_handlers = handlers.clone();
        let adapter = Arc::new(
            CodexAdapter::launch(
                self.launch_options(),
                AgentHandlers::new(|_| {}, move |line| log_handlers.emit_log(line))
                    .with_control_handlers(handlers),
            )
            .map_err(agent_error)?,
        );
        Ok(adapter)
    }
}

impl CodexRuntime {
    fn launch_session(
        &self,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<CodexAdapter> {
        let PreparedMcpConfig {
            servers,
            environment,
        } = prepare_mcp_config(&options.mcp_servers, &options.mcp_credentials)
            .map_err(AgentError::Failed)?;
        let mut launch_options = self.launch_options();
        launch_options.environment.extend(
            environment
                .iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value))),
        );
        let mut adapter = CodexAdapter::launch(launch_options, handlers).map_err(agent_error)?;
        adapter.mcp_servers = Mutex::new(servers);
        adapter.mcp_environment = environment;
        Ok(adapter)
    }
}

fn configure_handlers(
    rpc: &StdioJsonRpc,
    pending: Arc<Mutex<PendingRequests>>,
    mcp_startup: Arc<Mutex<HashMap<String, McpStartupStatus>>>,
    mcp_logins: Arc<Mutex<Vec<McpLogin>>>,
    handlers: CodexHandlers,
) {
    let stderr_handlers = handlers.clone();
    rpc.on_stderr(move |text| {
        let text = text.trim_end();
        if !text.is_empty() {
            stderr_handlers.emit_log(text);
        }
    });

    let notification_pending = Arc::clone(&pending);
    let notification_handlers = handlers.clone();
    rpc.on_notification(move |method, params| {
        if method == "skills/changed" {
            notification_handlers.emit_skills_changed();
            return;
        }
        if method == "mcpServer/startupStatus/updated" {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                notification_handlers.emit_log(
                    "invalid notification: mcpServer/startupStatus/updated is missing name",
                );
                return;
            };
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            match map_startup_status(&params) {
                Ok(status) => {
                    lock(&mcp_startup).insert(mcp_startup_key(thread_id.as_deref(), name), status);
                    notification_handlers.emit_mcp_changed(thread_id);
                }
                Err(error) => notification_handlers.emit_log(format!(
                    "invalid notification: mcpServer/startupStatus/updated {error}"
                )),
            }
            return;
        }
        if method == "mcpServer/oauthLogin/completed" {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                notification_handlers.emit_log(
                    "invalid notification: mcpServer/oauthLogin/completed is missing name",
                );
                return;
            };
            let Some(success) = params.get("success").and_then(Value::as_bool) else {
                notification_handlers.emit_log(
                    "invalid notification: mcpServer/oauthLogin/completed is missing success",
                );
                return;
            };
            let thread_id = params.get("threadId").and_then(Value::as_str);
            let mut logins = lock(&mcp_logins);
            let position = if let Some(thread_id) = thread_id {
                let key = mcp_startup_key(Some(thread_id), name);
                logins.iter().position(|login| login.key == key)
            } else {
                logins.iter().position(|login| login.server_id == name)
            };
            if let Some(position) = position {
                let login = logins.remove(position);
                drop(logins);
                notification_handlers.emit_mcp_o_auth(McpOAuthEvent {
                    server_id: login.server_id,
                    login_id: login.login_id,
                    success,
                    error: params
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
            return;
        }
        if method == "account/login/completed" {
            let Some(success) = params.get("success").and_then(Value::as_bool) else {
                notification_handlers
                    .emit_log("invalid notification: account/login/completed is missing success");
                return;
            };
            notification_handlers.emit_login(LoginEvent {
                login_id: params
                    .get("loginId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                success,
                error: params
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
            return;
        }
        if method == "turn/completed" {
            resolve_unanswered(&notification_pending, &notification_handlers);
        }
        match map_domain_notification(&method, &params, now_ms()) {
            Ok(Some(event)) => notification_handlers.emit_event(event),
            Ok(None) => notification_handlers.emit_log(format!("unmapped notification: {method}")),
            Err(error) => notification_handlers.emit_log(format!("invalid notification: {error}")),
        }
    });

    rpc.on_server_request(move |method, params, responder| {
        handle_server_request(&pending, &handlers, &method, &params, responder);
    });
}

fn handle_server_request(
    pending: &Mutex<PendingRequests>,
    handlers: &CodexHandlers,
    method: &str,
    params: &Value,
    responder: RpcResponder,
) {
    if method == "item/tool/requestUserInput" {
        match map_user_input(params) {
            Ok(request) => {
                let previous = lock(pending)
                    .user_inputs
                    .insert(request.id.clone(), responder);
                if let Some(previous) = previous {
                    let _ = previous.respond(json!({ "answers": {} }));
                    handlers.emit_event(DomainEvent::UserInputResolved {
                        id: request.id.clone(),
                    });
                }
                handlers.emit_event(DomainEvent::UserInputRequested { request });
            }
            Err(error) => {
                handlers.emit_log(format!("declined invalid user input request: {error}"));
                let _ = responder.respond(json!({ "answers": {} }));
            }
        }
        return;
    }

    let Some(kind) = approval_kind(method) else {
        handlers.emit_log(format!("declined unhandled server request: {method}"));
        let _ = responder.respond(json!({ "decision": "decline" }));
        return;
    };
    let id = params
        .get("approvalId")
        .and_then(Value::as_str)
        .or_else(|| params.get("itemId").and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let previous = lock(pending)
        .approvals
        .insert(id.clone(), PendingApproval { kind, responder });
    if let Some(previous) = previous {
        let _ = previous
            .responder
            .respond(json!({ "decision": decision_value(previous.kind, ApprovalDecision::Deny) }));
        handlers.emit_event(DomainEvent::ApprovalResolved { id: id.clone() });
    }
    handlers.emit_event(DomainEvent::ApprovalRequested {
        request: ApprovalRequest {
            id,
            kind,
            reason: optional_str(params, "reason"),
            command: optional_str(params, "command"),
            cwd: optional_str(params, "cwd"),
            path: optional_str(params, "grantRoot"),
            created_at: now_ms(),
        },
    });
}

fn resolve_unanswered(pending: &Mutex<PendingRequests>, handlers: &CodexHandlers) {
    let (approvals, user_inputs) = {
        let mut pending = lock(pending);
        (
            pending.approvals.drain().collect::<Vec<_>>(),
            pending.user_inputs.drain().collect::<Vec<_>>(),
        )
    };
    for (id, pending) in approvals {
        let _ = pending
            .responder
            .respond(json!({ "decision": decision_value(pending.kind, ApprovalDecision::Deny) }));
        handlers.emit_event(DomainEvent::ApprovalResolved { id });
    }
    for (id, responder) in user_inputs {
        let _ = responder.respond(json!({ "answers": {} }));
        handlers.emit_event(DomainEvent::UserInputResolved { id });
    }
}

fn map_user_input(params: &Value) -> Result<UserInputRequest, CodexAdapterError> {
    let method = "item/tool/requestUserInput";
    let questions = params
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(method, "missing questions array"))?
        .iter()
        .map(|question| {
            let options = match question.get("options") {
                None | Some(Value::Null) => None,
                Some(Value::Array(options)) => Some(
                    options
                        .iter()
                        .map(|option| {
                            Ok(UserInputOption {
                                label: response_str(method, option, &["label"])?.into(),
                                description: response_str(method, option, &["description"])?.into(),
                            })
                        })
                        .collect::<Result<Vec<_>, CodexAdapterError>>()?,
                ),
                Some(_) => return Err(invalid(method, "questions[].options is not an array")),
            };
            Ok(UserInputQuestion {
                id: response_str(method, question, &["id"])?.into(),
                header: response_str(method, question, &["header"])?.into(),
                question: response_str(method, question, &["question"])?.into(),
                allow_other: question
                    .get("isOther")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                secret: question
                    .get("isSecret")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                options,
            })
        })
        .collect::<Result<Vec<_>, CodexAdapterError>>()?;
    Ok(UserInputRequest {
        id: response_str(method, params, &["itemId"])?.into(),
        turn_id: response_str(method, params, &["turnId"])?.into(),
        questions,
        auto_resolution_ms: params.get("autoResolutionMs").and_then(Value::as_u64),
        created_at: now_ms(),
    })
}

fn map_model(method: &'static str, raw: &Value) -> Result<Model, CodexAdapterError> {
    let efforts = raw
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| option.get("reasoningEffort").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let service_tiers = raw
        .get("serviceTiers")
        .and_then(Value::as_array)
        .map(|tiers| {
            tiers
                .iter()
                .map(|tier| {
                    Ok(ServiceTier {
                        id: response_str(method, tier, &["id"])?.into(),
                        name: response_str(method, tier, &["name"])?.into(),
                        description: response_str(method, tier, &["description"])?.into(),
                    })
                })
                .collect::<Result<Vec<_>, CodexAdapterError>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(Model {
        id: response_str(method, raw, &["id"])?.into(),
        display_name: response_str(method, raw, &["displayName"])?.into(),
        description: raw
            .get("description")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned),
        is_default: raw
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        reasoning_efforts: efforts,
        default_reasoning_effort: raw
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_owned),
        service_tiers,
        default_service_tier: raw
            .get("defaultServiceTier")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn turn_input(text: &str, attachments: &[String]) -> Vec<Value> {
    let mut input = vec![json!({ "type": "text", "text": text, "text_elements": [] })];
    input.extend(attachments.iter().map(|path| {
        if is_image(path) {
            json!({ "type": "localImage", "path": path })
        } else {
            json!({ "type": "mention", "name": basename(path), "path": path })
        }
    }));
    input
}

fn apply_approval_mode(params: &mut Map<String, Value>, mode: ApprovalMode) {
    let (approval_policy, sandbox, reviewer) = match mode {
        ApprovalMode::Ask => ("untrusted", "read-only", None),
        ApprovalMode::Auto => ("on-request", "workspace-write", None),
        ApprovalMode::AutoReview => ("on-request", "workspace-write", Some("auto_review")),
        ApprovalMode::Full => ("never", "danger-full-access", None),
    };
    params.insert(
        "approvalPolicy".into(),
        Value::String(approval_policy.into()),
    );
    params.insert("sandbox".into(), Value::String(sandbox.into()));
    if let Some(reviewer) = reviewer {
        params.insert("approvalsReviewer".into(), Value::String(reviewer.into()));
    }
}

fn approval_kind(method: &str) -> Option<ApprovalKind> {
    match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => {
            Some(ApprovalKind::Command)
        }
        "item/fileChange/requestApproval" | "applyPatchApproval" => Some(ApprovalKind::FileChange),
        "item/permissions/requestApproval" => Some(ApprovalKind::Permissions),
        _ => None,
    }
}

fn decision_value(_kind: ApprovalKind, decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::Approve => "accept",
        ApprovalDecision::ApproveSession => "acceptForSession",
        ApprovalDecision::Deny => "decline",
        ApprovalDecision::Abort => "cancel",
    }
}

fn plan_label(plan: &str) -> String {
    match plan {
        "free" => "Free",
        "go" => "Go",
        "plus" => "Plus",
        "pro" => "Pro",
        "prolite" => "Pro Lite",
        "team" => "Team",
        "business" => "Business",
        "enterprise" => "Enterprise",
        "edu" => "Edu",
        _ => "Signed in",
    }
    .into()
}

fn is_image(path: &str) -> bool {
    let extension = path.rsplit_once('.').map(|(_, extension)| extension);
    matches!(
        extension.map(str::to_ascii_lowercase).as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg")
    )
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

fn mcp_startup_key(thread_id: Option<&str>, server_id: &str) -> String {
    format!("{}\0{server_id}", thread_id.unwrap_or(""))
}

fn insert_option(params: &mut Map<String, Value>, field: &str, value: Option<&str>) {
    if let Some(value) = value {
        params.insert(field.into(), Value::String(value.into()));
    }
}

fn optional_str(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn optional_nullable_string(
    method: &'static str,
    value: &Value,
    field: &str,
) -> Result<Option<String>, CodexAdapterError> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid(method, &format!("{field} is not a string or null"))),
    }
}

fn response_str<'a>(
    method: &'static str,
    value: &'a Value,
    path: &[&str],
) -> Result<&'a str, CodexAdapterError> {
    let mut current = value;
    for field in path {
        current = current
            .get(field)
            .ok_or_else(|| invalid(method, &format!("missing {}", path.join("."))))?;
    }
    current
        .as_str()
        .ok_or_else(|| invalid(method, &format!("{} is not a string", path.join("."))))
}

fn invalid(method: &'static str, message: &str) -> CodexAdapterError {
    CodexAdapterError::InvalidResponse {
        method,
        message: message.into(),
    }
}

fn agent_error(error: CodexAdapterError) -> AgentError {
    AgentError::Failed(error.to_string())
}

fn normalize_timestamp_ms(timestamp: f64) -> f64 {
    if timestamp < 100_000_000_000.0 {
        timestamp * 1_000.0
    } else {
        timestamp
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::sync::mpsc;
    use std::thread;

    const HELPER_MODE: &str = "HARNESS_CODEX_ADAPTER_HELPER";

    #[test]
    fn drives_handshake_models_thread_turn_and_approval_over_real_stdio() {
        let (event_tx, event_rx) = mpsc::channel();
        let (log_tx, _log_rx) = mpsc::channel();
        let (login_tx, login_rx) = mpsc::channel();
        let (mcp_changed_tx, mcp_changed_rx) = mpsc::channel();
        let (mcp_o_auth_tx, mcp_o_auth_rx) = mpsc::channel();
        let (skills_changed_tx, skills_changed_rx) = mpsc::channel();
        let control_handlers = ControlHandlers::new(
            move |event| {
                let _ = login_tx.send(event);
            },
            |_| {},
        )
        .with_mcp_changed(move |thread_id| {
            let _ = mcp_changed_tx.send(thread_id);
        })
        .with_mcp_o_auth(move |event| {
            let _ = mcp_o_auth_tx.send(event);
        })
        .with_skills_changed(move || {
            let _ = skills_changed_tx.send(());
        });
        let handlers = CodexHandlers::new(
            move |event| {
                let _ = event_tx.send(event);
            },
            move |line| {
                let _ = log_tx.send(line);
            },
        )
        .with_control_handlers(control_handlers);
        let adapter = Arc::new(test_adapter(handlers));
        assert_eq!(
            adapter.account(),
            Account {
                signed_in: true,
                email: Some("developer@example.com".into()),
                plan: Some("Pro".into()),
            }
        );
        assert_eq!(
            adapter.voice_status(),
            VoiceStatusResult {
                available: true,
                reason: None,
            }
        );
        assert_eq!(
            adapter.start_login().unwrap(),
            AuthStartLoginResult {
                login_id: "login-1".into(),
                auth_url: Some("https://auth.example/login".into()),
            }
        );
        assert_eq!(
            login_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            LoginEvent {
                login_id: Some("login-1".into()),
                success: true,
                error: None,
            }
        );
        adapter.cancel_login("login-1").unwrap();
        assert!(adapter.use_api_key("test-only-api-key").unwrap().signed_in);
        adapter.sign_out().unwrap();
        let models = adapter.list_models().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-test");
        assert_eq!(models[0].reasoning_efforts, ["medium", "high"]);
        assert_eq!(models[0].service_tiers[0].id, "priority");
        let mcp = adapter.list_mcp_servers(Some("thread-1")).unwrap();
        assert_eq!(
            mcp.iter()
                .map(|server| server.id.as_str())
                .collect::<Vec<_>>(),
            ["docs", "files"]
        );
        assert_eq!(mcp[0].tools[0].name, "search");
        assert_eq!(mcp[0].startup, McpStartupStatus::Ready);
        assert_eq!(
            mcp_changed_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Some("thread-1".into())
        );
        let skills = adapter.list_skills("/repo").unwrap();
        assert_eq!(skills.skills[0].name, "docs");
        assert_eq!(skills.errors[0].message, "invalid frontmatter");
        skills_changed_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert!(
            adapter
                .set_skill_enabled("/repo/docs/SKILL.md", true)
                .unwrap()
        );
        let oauth = adapter.start_mcp_o_auth("docs", "thread-1").unwrap();
        assert_eq!(oauth.auth_url, "https://auth.example/mcp");
        assert_eq!(
            mcp_o_auth_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            McpOAuthEvent {
                server_id: "docs".into(),
                login_id: oauth.login_id,
                success: true,
                error: None,
            }
        );

        let thread = adapter
            .start_thread(
                "/repo",
                &StartOptions {
                    model: Some("gpt-test".into()),
                    effort: Some("high".into()),
                    approval: Some(ApprovalMode::AutoReview),
                    ..StartOptions::default()
                },
            )
            .unwrap();
        assert_eq!(thread.id, "thread-1");

        adapter
            .reload_mcp_servers(
                "thread-1",
                &[McpServerConfig {
                    id: "docs".into(),
                    enabled: true,
                    display_name: None,
                    transport: Some(harness_protocol::McpTransport::Http {
                        url: "https://docs.example/mcp".into(),
                        headers: None,
                    }),
                }],
                &CredentialValues::default(),
            )
            .unwrap();
        assert_eq!(
            mcp_changed_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Some("thread-1".into())
        );

        let turn_adapter = Arc::clone(&adapter);
        let turn = thread::spawn(move || {
            turn_adapter.send_turn(
                "thread-1",
                "Build this",
                &["C:\\repo\\reference.png".into(), "/repo/spec.md".into()],
                &TurnOptions::default(),
            )
        });

        let approval_id = loop {
            let event = event_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            if let DomainEvent::ApprovalRequested { request } = event {
                assert_eq!(request.kind, ApprovalKind::Command);
                assert_eq!(request.command.as_deref(), Some("cargo test"));
                break request.id;
            }
        };
        assert!(
            adapter
                .respond_to_approval(&approval_id, ApprovalDecision::ApproveSession)
                .unwrap()
        );
        assert_eq!(turn.join().unwrap().unwrap(), "turn-1");

        let mut saw_started = false;
        let mut saw_delta = false;
        let mut saw_completed = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline && !saw_completed {
            let Ok(event) = event_rx.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            match event {
                DomainEvent::TurnStarted { turn } => saw_started = turn.id == "turn-1",
                DomainEvent::ItemDelta { text_delta, .. } => saw_delta = text_delta == "hello",
                DomainEvent::TurnCompleted { turn_id, .. } => saw_completed = turn_id == "turn-1",
                _ => {}
            }
        }
        assert!(saw_started && saw_delta && saw_completed);
        adapter.dispose();
    }

    #[test]
    fn maps_attachments_approval_modes_and_timestamp_units() {
        assert!(is_image("C:\\repo\\IMAGE.PNG"));
        assert!(!is_image("/repo/readme.md"));
        assert_eq!(basename("C:\\repo\\IMAGE.PNG"), "IMAGE.PNG");
        assert_eq!(basename("/repo/readme.md"), "readme.md");
        assert_eq!(normalize_timestamp_ms(1_785_627_335.0), 1_785_627_335_000.0);
        assert_eq!(
            normalize_timestamp_ms(1_785_627_335_000.0),
            1_785_627_335_000.0
        );

        let mut params = Map::new();
        apply_approval_mode(&mut params, ApprovalMode::AutoReview);
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["sandbox"], "workspace-write");
        assert_eq!(params["approvalsReviewer"], "auto_review");
    }

    #[test]
    fn codex_helper() {
        if std::env::var_os(HELPER_MODE).is_none() {
            return;
        }
        let stdin = std::io::stdin();
        let mut lines = BufReader::new(stdin.lock()).lines();
        let stdout = std::io::stdout();
        let mut stdout = stdout.lock();
        while let Some(Ok(line)) = lines.next() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap_or_default();
            let id = request.get("id").cloned();
            match method {
                "initialize" => {
                    assert_eq!(request["params"]["clientInfo"]["name"], CLIENT_NAME);
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({ "userAgent": "fake-codex" }),
                    );
                }
                "initialized" => {}
                "account/read" => respond(
                    &mut stdout,
                    id.unwrap(),
                    json!({
                        "account": {
                            "type": "chatgpt",
                            "email": "developer@example.com",
                            "planType": "pro"
                        }
                    }),
                ),
                "getAuthStatus" => {
                    assert_eq!(request["params"]["includeToken"], false);
                    assert_eq!(request["params"]["refreshToken"], false);
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({ "authMethod": "chatgpt", "authToken": null }),
                    );
                }
                "account/login/start" if request["params"]["type"] == "chatgpt" => {
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({
                            "type": "chatgpt",
                            "loginId": "login-1",
                            "authUrl": "https://auth.example/login"
                        }),
                    );
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "method": "account/login/completed",
                            "params": {
                                "loginId": "login-1",
                                "success": true,
                                "error": null
                            }
                        }),
                    );
                }
                "account/login/start" if request["params"]["type"] == "apiKey" => {
                    assert_eq!(request["params"]["apiKey"], "test-only-api-key");
                    respond(&mut stdout, id.unwrap(), json!({ "type": "apiKey" }));
                }
                "account/login/cancel" => {
                    assert_eq!(request["params"]["loginId"], "login-1");
                    respond(&mut stdout, id.unwrap(), json!({}));
                }
                "account/logout" => respond(&mut stdout, id.unwrap(), json!({})),
                "model/list" => respond(
                    &mut stdout,
                    id.unwrap(),
                    json!({
                        "data": [
                            {
                                "id": "gpt-test",
                                "displayName": "GPT Test",
                                "description": "Captured model",
                                "hidden": false,
                                "isDefault": true,
                                "supportedReasoningEfforts": [
                                    { "reasoningEffort": "medium", "description": "" },
                                    { "reasoningEffort": "high", "description": "" }
                                ],
                                "defaultReasoningEffort": "medium",
                                "serviceTiers": [
                                    { "id": "priority", "name": "Fast", "description": "Priority" }
                                ],
                                "defaultServiceTier": "priority"
                            },
                            {
                                "id": "hidden",
                                "displayName": "Hidden",
                                "hidden": true
                            }
                        ],
                        "nextCursor": null
                    }),
                ),
                "mcpServerStatus/list" if request["params"].get("cursor").is_none() => {
                    assert_eq!(request["params"]["detail"], "full");
                    assert_eq!(request["params"]["threadId"], "thread-1");
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "method": "mcpServer/startupStatus/updated",
                            "params": {
                                "threadId": "thread-1",
                                "name": "docs",
                                "status": "ready",
                                "error": null,
                                "failureReason": null
                            }
                        }),
                    );
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({
                            "data": [{
                                "name": "docs",
                                "serverInfo": {
                                    "name": "docs",
                                    "title": "Documentation",
                                    "version": "1.0.0",
                                    "description": "Captured documentation server"
                                },
                                "authStatus": "unsupported",
                                "tools": {
                                    "search": {
                                        "name": "search",
                                        "description": "Search docs",
                                        "inputSchema": { "type": "object" }
                                    }
                                },
                                "resources": [],
                                "resourceTemplates": []
                            }],
                            "nextCursor": "page-2"
                        }),
                    );
                }
                "mcpServerStatus/list" => {
                    assert_eq!(request["params"]["cursor"], "page-2");
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({
                            "data": [{
                                "name": "files",
                                "serverInfo": null,
                                "authStatus": "notLoggedIn",
                                "tools": {},
                                "resources": [],
                                "resourceTemplates": []
                            }],
                            "nextCursor": null
                        }),
                    );
                }
                "skills/list" => {
                    assert_eq!(request["params"]["cwds"], json!(["/repo"]));
                    assert_eq!(request["params"]["forceReload"], true);
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "method": "skills/changed",
                            "params": {}
                        }),
                    );
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({
                            "data": [{
                                "cwd": "/repo",
                                "skills": [{
                                    "name": "docs",
                                    "description": "Read docs",
                                    "interface": { "displayName": "Docs" },
                                    "path": "/repo/docs/SKILL.md",
                                    "scope": "repo",
                                    "enabled": true
                                }],
                                "errors": [{
                                    "path": "/repo/broken/SKILL.md",
                                    "message": "invalid frontmatter"
                                }]
                            }]
                        }),
                    );
                }
                "skills/config/write" => {
                    assert_eq!(request["params"]["path"], "/repo/docs/SKILL.md");
                    assert_eq!(request["params"]["name"], Value::Null);
                    assert_eq!(request["params"]["enabled"], true);
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({ "effectiveEnabled": true }),
                    );
                }
                "mcpServer/oauth/login" => {
                    assert_eq!(request["params"]["name"], "docs");
                    assert_eq!(request["params"]["threadId"], "thread-1");
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({ "authorizationUrl": "https://auth.example/mcp" }),
                    );
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "method": "mcpServer/oauthLogin/completed",
                            "params": {
                                "threadId": null,
                                "name": "docs",
                                "success": true,
                                "error": null
                            }
                        }),
                    );
                }
                "thread/start" => {
                    assert_eq!(request["params"]["cwd"], "/repo");
                    assert_eq!(
                        request["params"]["config"]["model_reasoning_effort"],
                        "high"
                    );
                    assert_eq!(request["params"]["approvalsReviewer"], "auto_review");
                    assert_eq!(request["params"]["config"]["mcp_servers"], json!({}));
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({ "thread": { "id": "thread-1" } }),
                    );
                }
                "thread/resume" => {
                    assert_eq!(request["params"]["threadId"], "thread-1");
                    assert_eq!(
                        request["params"]["config"]["mcp_servers"]["docs"]["url"],
                        "https://docs.example/mcp"
                    );
                    respond(
                        &mut stdout,
                        id.unwrap(),
                        json!({ "thread": { "id": "thread-1" } }),
                    );
                }
                "config/mcpServer/reload" => {
                    assert_eq!(request["params"], json!({}));
                    respond(&mut stdout, id.unwrap(), json!({}));
                }
                "turn/start" => {
                    assert_eq!(request["params"]["input"][1]["type"], "localImage");
                    assert_eq!(request["params"]["input"][2]["type"], "mention");
                    let turn_request_id = id.unwrap();
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "id": 99,
                            "method": "item/commandExecution/requestApproval",
                            "params": {
                                "itemId": "approval-1",
                                "command": "cargo test",
                                "cwd": "/repo"
                            }
                        }),
                    );
                    let approval: Value =
                        serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
                    assert_eq!(approval["id"], 99);
                    assert_eq!(approval["result"]["decision"], "acceptForSession");
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "method": "turn/started",
                            "params": { "threadId": "thread-1", "turn": { "id": "turn-1" } }
                        }),
                    );
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "method": "item/started",
                            "params": {
                                "threadId": "thread-1",
                                "turnId": "turn-1",
                                "startedAtMs": 1000,
                                "item": { "type": "agentMessage", "id": "item-1", "text": "" }
                            }
                        }),
                    );
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "method": "item/agentMessage/delta",
                            "params": { "turnId": "turn-1", "itemId": "item-1", "delta": "hello" }
                        }),
                    );
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "method": "item/completed",
                            "params": {
                                "threadId": "thread-1",
                                "turnId": "turn-1",
                                "completedAtMs": 1001,
                                "item": { "type": "agentMessage", "id": "item-1", "text": "hello" }
                            }
                        }),
                    );
                    write_frame(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "method": "turn/completed",
                            "params": {
                                "threadId": "thread-1",
                                "turn": { "id": "turn-1", "status": "completed" }
                            }
                        }),
                    );
                    respond(
                        &mut stdout,
                        turn_request_id,
                        json!({ "turn": { "id": "turn-1" } }),
                    );
                }
                method => panic!("unexpected helper method: {method}"),
            }
        }
    }

    fn test_adapter(handlers: CodexHandlers) -> CodexAdapter {
        let executable = std::env::current_exe().unwrap();
        let args = [
            OsStr::new("--exact"),
            OsStr::new("runtime::tests::codex_helper"),
            OsStr::new("--nocapture"),
        ];
        CodexAdapter::launch_process(
            executable.as_os_str(),
            &args,
            &SpawnOptions::default().env(HELPER_MODE, "1"),
            handlers,
            Duration::from_secs(2),
        )
        .unwrap()
    }

    fn respond(stdout: &mut impl Write, id: Value, result: Value) {
        write_frame(
            stdout,
            json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        );
    }

    fn write_frame(stdout: &mut impl Write, frame: Value) {
        writeln!(stdout, "{frame}").unwrap();
        stdout.flush().unwrap();
    }
}
