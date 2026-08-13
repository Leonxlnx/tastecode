use crate::{ServerState, diff_review::DiffReviewError};
use chrono::{Datelike as _, Local, TimeZone as _};
use harness_protocol::method;
use harness_protocol::{
    AcpAgentsResult, ApprovalDecision, ApprovalMode, CheckpointSummary, CredentialConfiguredResult,
    DiffDecision, ErrorCode, ModelConnectionInput, ModelConnectionResult, ModelConnectionsResult,
    ModelsListResult, ProjectAddedResult, ProjectSummary, ProjectsListResult, ProviderId,
    ProvidersListResult, ReviewDiffResult, ServerWelcome, SessionSummary, SettleReason,
    SidebarMode, SystemInfo, SystemPlatform, TerminalOpenedResult, ThreadCheckpointsResult,
    ThreadHistoryResult, ThreadInboxStatus, ThreadLifecycle, ThreadLifecyclePush,
    ThreadLifecycleResult, ThreadStartResult, ThreadUnsavedWorkResult, Usage, UsageSummaryResult,
    VoiceTranscribeParams, VoiceTranscriptionResult, WireError, channel,
};
use harness_store::{SearchOptions, SidebarSettingsUpdate, Store, StoreError};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SERVER_VERSION: &str = "0.0.0";

pub(crate) struct RouteError(pub(crate) WireError);

impl RouteError {
    fn bad_params(method: &str, detail: impl Into<String>) -> Self {
        Self(WireError {
            code: ErrorCode::BadRequest,
            message: format!("invalid params for {method}"),
            detail: Some(detail.into()),
        })
    }

    pub(crate) fn unknown_method(method: &str) -> Self {
        Self(WireError {
            code: ErrorCode::BadRequest,
            message: format!("unknown method: {method}"),
            detail: None,
        })
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self(WireError {
            code: ErrorCode::Internal,
            message: error.to_string(),
            detail: None,
        })
    }
}

impl From<StoreError> for RouteError {
    fn from(error: StoreError) -> Self {
        Self::internal(error)
    }
}

impl From<DiffReviewError> for RouteError {
    fn from(error: DiffReviewError) -> Self {
        if matches!(error, DiffReviewError::StaleSnapshot) {
            return Self(WireError {
                code: ErrorCode::StaleSnapshot,
                message: error.to_string(),
                detail: None,
            });
        }
        Self::internal(error)
    }
}

pub(crate) fn route(
    state: &Arc<ServerState>,
    connection_id: u64,
    method_name: &str,
    params: Value,
) -> Result<Value, RouteError> {
    match method_name {
        method::CLIENT_CAPABILITIES => {
            let params: ClientCapabilitiesParams = decode(method_name, params)?;
            state
                .preview_capture
                .set_capability(connection_id, params.preview_capture)
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::PREVIEW_CAPTURE_RESULT => {
            let result: harness_protocol::PreviewCaptureResult = decode(method_name, params)?;
            state
                .preview_capture
                .complete(connection_id, result)
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::SYSTEM_INFO => {
            let _: EmptyParams = decode(method_name, params)?;
            encoded(SystemInfo {
                server_version: SERVER_VERSION.into(),
                protocol_version: harness_protocol::PROTOCOL_VERSION,
                platform: current_platform(),
            })
        }
        method::SYSTEM_PANIC_STOP => {
            let _: EmptyParams = decode(method_name, params)?;
            encoded(state.agents.panic_stop(state))
        }
        method::SYSTEM_UPDATE_CHECK => {
            let _: EmptyParams = decode(method_name, params)?;
            encoded(crate::update_check::check())
        }
        method::VOICE_STATUS => {
            let params: VoiceStatusParams = decode(method_name, params)?;
            encoded(
                state
                    .agents
                    .voice_status(state, params.provider)
                    .map_err(RouteError::internal)?,
            )
        }
        method::VOICE_TRANSCRIBE => {
            let params: VoiceTranscribeParams = decode(method_name, params)?;
            validate_voice_transcription(method_name, &params)?;
            let request = state
                .start_voice_request(connection_id, &params.request_id)
                .map_err(RouteError::internal)?;
            let text = state
                .agents
                .transcribe_voice(state, &params, request.cancellation())
                .map_err(RouteError::internal)?;
            encoded(VoiceTranscriptionResult { text })
        }
        method::VOICE_CANCEL => {
            let params: VoiceCancelParams = decode(method_name, params)?;
            validate_uuid(method_name, "requestId", &params.request_id)?;
            state.cancel_voice_request(&params.request_id);
            empty_result()
        }
        method::SEARCH_SESSIONS => {
            let params: SearchParams = decode(method_name, params)?;
            let query = params.query.trim().to_owned();
            if query.is_empty()
                || params.project_path.as_deref().is_some_and(str::is_empty)
                || params.cursor.as_deref().is_some_and(str::is_empty)
                || params
                    .limit
                    .is_some_and(|limit| !(1..=100).contains(&limit))
            {
                return Err(RouteError::bad_params(
                    method_name,
                    "query, filters, cursor, or limit is outside the protocol bounds",
                ));
            }
            encoded(lock_store(state)?.search_sessions(&SearchOptions {
                query,
                project_path: params.project_path,
                provider: params.provider,
                cursor: params.cursor,
                limit: params.limit,
            })?)
        }
        method::PROVIDERS_LIST => {
            let _: EmptyParams = decode(method_name, params)?;
            encoded(ProvidersListResult {
                providers: harness_providers::detect_providers(),
            })
        }
        method::PROVIDERS_INSTALL => {
            let params: ProviderActionParams = decode(method_name, params)?;
            validate_provider_action(method_name, &params)?;
            let target =
                harness_providers::install_command_for(params.provider, params.agent.as_deref())
                    .map_err(RouteError::internal)?;
            run_provider_terminal(state, "install", target, params.columns, params.rows)
        }
        method::PROVIDERS_LAUNCH => {
            let params: ProviderActionParams = decode(method_name, params)?;
            validate_provider_action(method_name, &params)?;
            let target =
                harness_providers::launch_command_for(params.provider, params.agent.as_deref())
                    .map_err(RouteError::internal)?;
            run_provider_terminal(state, "login", target, params.columns, params.rows)
        }
        method::ACP_AGENTS => {
            let _: EmptyParams = decode(method_name, params)?;
            encoded(AcpAgentsResult {
                agents: harness_providers::detect_agents(),
            })
        }
        method::CONNECTIONS_LIST => {
            let _: EmptyParams = decode(method_name, params)?;
            encoded(ModelConnectionsResult {
                connections: state
                    .model_connections
                    .lock()
                    .map_err(|_| RouteError::internal("model connection mutex poisoned"))?
                    .list()
                    .map_err(|error| model_connection_error(method_name, error))?,
            })
        }
        method::CONNECTIONS_UPSERT => {
            let params: ModelConnectionInput = decode(method_name, params)?;
            let connection = state
                .model_connections
                .lock()
                .map_err(|_| RouteError::internal("model connection mutex poisoned"))?
                .upsert(params)
                .map_err(|error| model_connection_error(method_name, error))?;
            encoded(ModelConnectionResult { connection })
        }
        method::CONNECTIONS_SET_CREDENTIAL => {
            let params: ConnectionCredentialParams = decode(method_name, params)?;
            require_non_empty(method_name, "connectionId", &params.connection_id)?;
            require_non_empty(method_name, "apiKey", &params.api_key)?;
            state
                .model_connections
                .lock()
                .map_err(|_| RouteError::internal("model connection mutex poisoned"))?
                .set_credential(&params.connection_id, &params.api_key)
                .map_err(|error| model_connection_error(method_name, error))?;
            encoded(CredentialConfiguredResult {
                credential_configured: true,
            })
        }
        method::CONNECTIONS_REMOVE => {
            let params: ConnectionIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "connectionId", &params.connection_id)?;
            state
                .model_connections
                .lock()
                .map_err(|_| RouteError::internal("model connection mutex poisoned"))?
                .remove(&params.connection_id)
                .map_err(|error| model_connection_error(method_name, error))?;
            empty_result()
        }
        method::CONNECTIONS_MODELS => {
            let params: ConnectionIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "connectionId", &params.connection_id)?;
            encoded(ModelsListResult {
                models: state
                    .agents
                    .list_connection_models(state, &params.connection_id)
                    .map_err(RouteError::internal)?,
            })
        }
        method::AUTH_STATUS => {
            let params: AuthParams = decode(method_name, params)?;
            validate_auth_target(method_name, &params)?;
            encoded(
                state
                    .agents
                    .account(state, params.provider, params.agent.as_deref())
                    .map_err(RouteError::internal)?,
            )
        }
        method::AUTH_START_LOGIN => {
            let params: AuthParams = decode(method_name, params)?;
            validate_auth_target(method_name, &params)?;
            encoded(
                state
                    .agents
                    .start_login(state, params.provider, params.agent.as_deref())
                    .map_err(RouteError::internal)?,
            )
        }
        method::AUTH_CANCEL_LOGIN => {
            let params: AuthCancelLoginParams = decode(method_name, params)?;
            validate_auth_target(method_name, &params.target)?;
            require_non_empty(method_name, "loginId", &params.login_id)?;
            state
                .agents
                .cancel_login(
                    state,
                    params.target.provider,
                    params.target.agent.as_deref(),
                    &params.login_id,
                )
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::AUTH_USE_API_KEY => {
            let params: AuthUseApiKeyParams = decode(method_name, params)?;
            validate_auth_target(method_name, &params.target)?;
            require_non_empty(method_name, "apiKey", &params.api_key)?;
            encoded(
                state
                    .agents
                    .use_api_key(
                        state,
                        params.target.provider,
                        params.target.agent.as_deref(),
                        &params.api_key,
                    )
                    .map_err(RouteError::internal)?,
            )
        }
        method::AUTH_SIGN_OUT => {
            let params: AuthParams = decode(method_name, params)?;
            validate_auth_target(method_name, &params)?;
            state
                .agents
                .sign_out(state, params.provider, params.agent.as_deref())
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::MCP_LIST => {
            let params: ProviderProjectParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            encoded(
                state
                    .agents
                    .list_mcp_servers(state, params.provider, &params.project_path)
                    .map_err(RouteError::internal)?,
            )
        }
        method::MCP_ADD => {
            let params: McpMutationParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            if !state.agents.mcp_capabilities(params.provider).add {
                return Err(RouteError::internal("this provider cannot add MCP servers"));
            }
            state
                .mcp_config
                .lock()
                .map_err(|_| RouteError::internal("MCP config mutex poisoned"))?
                .add(params.provider, &params.project_path, params.server)
                .map_err(|error| mcp_config_error(method_name, error))?;
            broadcast_provider_project(
                state,
                channel::MCP_CHANGED,
                params.provider,
                &params.project_path,
            )?;
            empty_result()
        }
        method::MCP_UPDATE => {
            let params: McpMutationParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            if !state.agents.mcp_capabilities(params.provider).update {
                return Err(RouteError::internal(
                    "this provider cannot update MCP servers",
                ));
            }
            state
                .mcp_config
                .lock()
                .map_err(|_| RouteError::internal("MCP config mutex poisoned"))?
                .update(params.provider, &params.project_path, params.server)
                .map_err(|error| mcp_config_error(method_name, error))?;
            broadcast_provider_project(
                state,
                channel::MCP_CHANGED,
                params.provider,
                &params.project_path,
            )?;
            empty_result()
        }
        method::MCP_REMOVE => {
            let params: McpRemoveParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            require_non_empty(method_name, "serverId", &params.server_id)?;
            if !state.agents.mcp_capabilities(params.provider).remove {
                return Err(RouteError::internal(
                    "this provider cannot remove MCP servers",
                ));
            }
            state
                .mcp_config
                .lock()
                .map_err(|_| RouteError::internal("MCP config mutex poisoned"))?
                .remove(params.provider, &params.project_path, &params.server_id)
                .map_err(|error| mcp_config_error(method_name, error))?;
            broadcast_provider_project(
                state,
                channel::MCP_CHANGED,
                params.provider,
                &params.project_path,
            )?;
            empty_result()
        }
        method::MCP_RELOAD => {
            let params: ProviderProjectParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            state
                .agents
                .reload_mcp_servers(state, params.provider, &params.project_path)
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::MCP_START_OAUTH => {
            let params: McpOAuthParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            require_non_empty(method_name, "serverId", &params.server_id)?;
            encoded(
                state
                    .agents
                    .start_mcp_o_auth(
                        state,
                        params.provider,
                        &params.project_path,
                        &params.server_id,
                    )
                    .map_err(RouteError::internal)?,
            )
        }
        method::MCP_CANCEL_OAUTH => {
            let params: McpCancelOAuthParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            require_non_empty(method_name, "serverId", &params.server_id)?;
            require_non_empty(method_name, "loginId", &params.login_id)?;
            state
                .agents
                .cancel_mcp_o_auth(params.provider)
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::SKILLS_LIST => {
            let params: ProviderProjectParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            encoded(
                state
                    .agents
                    .list_skills(state, params.provider, &params.project_path)
                    .map_err(RouteError::internal)?,
            )
        }
        method::SKILLS_SET_ENABLED => {
            let params: SkillToggleParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            require_non_empty(method_name, "skillId", &params.skill_id)?;
            let enabled = state
                .agents
                .set_skill_enabled(
                    state,
                    params.provider,
                    &params.project_path,
                    &params.skill_id,
                    params.enabled,
                )
                .map_err(RouteError::internal)?;
            broadcast_provider_project(
                state,
                channel::SKILLS_CHANGED,
                params.provider,
                &params.project_path,
            )?;
            encoded(harness_protocol::SkillEnabledResult { enabled })
        }
        method::SKILLS_INSTALL_FROM_FOLDER => {
            let params: SkillInstallParams = decode(method_name, params)?;
            require_non_empty(method_name, "projectPath", &params.project_path)?;
            require_non_empty(method_name, "folderPath", &params.folder_path)?;
            let skill = state
                .agents
                .install_skill(
                    state,
                    params.provider,
                    &params.project_path,
                    &params.folder_path,
                )
                .map_err(RouteError::internal)?;
            broadcast_provider_project(
                state,
                channel::SKILLS_CHANGED,
                params.provider,
                &params.project_path,
            )?;
            encoded(harness_protocol::SkillInstalledResult { skill })
        }
        method::MODELS_LIST => {
            let params: ModelsListParams = decode(method_name, params)?;
            if params.agent.as_deref().is_some_and(str::is_empty) {
                return Err(RouteError::bad_params(
                    method_name,
                    "agent must be non-empty when present",
                ));
            }
            encoded(ModelsListResult {
                models: state
                    .agents
                    .list_models(params.provider, params.agent.as_deref())
                    .map_err(RouteError::internal)?,
            })
        }
        method::WORKSPACE_INFO => {
            let params: WorkspacePathParams = decode(method_name, params)?;
            encoded(harness_workspace::read_workspace(params.path))
        }
        method::WORKSPACE_BRANCHES => {
            let params: WorkspacePathParams = decode(method_name, params)?;
            Ok(json!({
                "branches": harness_workspace::list_workspace_branches(params.path)
            }))
        }
        method::WORKSPACE_SWITCH_BRANCH => {
            let params: WorkspaceSwitchParams = decode(method_name, params)?;
            require_non_empty(method_name, "branch", &params.branch)?;
            encoded(
                harness_workspace::switch_workspace_branch(params.path, &params.branch)
                    .map_err(RouteError::internal)?,
            )
        }
        method::PROJECTS_LIST => {
            let _: EmptyParams = decode(method_name, params)?;
            let store = lock_store(state)?;
            let projects = store
                .projects()?
                .into_iter()
                .map(|project| {
                    let sessions = store
                        .threads(Some(&project.path))?
                        .into_iter()
                        .map(|thread| {
                            let status = inbox_status(state, &store, &thread.id, thread.unread)?;
                            let running = state.agents.is_running(&thread.id);
                            Ok(SessionSummary {
                                id: thread.id,
                                title: thread.title,
                                provider: thread.provider,
                                agent: thread.agent,
                                created_at: thread.created_at as f64,
                                running,
                                pinned: thread.pinned,
                                status: Some(status),
                                unread: Some(thread.unread),
                                lifecycle: Some(thread.lifecycle),
                                closed_at: thread.closed_at.map(|value| value as f64),
                                worktree_branch: thread.worktree_branch,
                            })
                        })
                        .collect::<Result<Vec<_>, RouteError>>()?;
                    Ok(ProjectSummary {
                        path: project.path,
                        name: project.name,
                        pinned: project.pinned,
                        created_at: project.created_at as f64,
                        sessions,
                    })
                })
                .collect::<Result<Vec<_>, RouteError>>()?;
            encoded(ProjectsListResult { projects })
        }
        method::PROJECTS_ADD => {
            let params: ProjectAddParams = decode(method_name, params)?;
            let project = lock_store(state)?.add_project(&params.path, params.name.as_deref())?;
            encoded(ProjectAddedResult {
                path: project.path,
                name: project.name,
                pinned: project.pinned,
                created_at: project.created_at as f64,
            })
        }
        method::PROJECTS_PIN => {
            let params: ProjectPinParams = decode(method_name, params)?;
            lock_store(state)?.set_project_pinned(&params.path, params.pinned)?;
            empty_result()
        }
        method::PROJECTS_RENAME => {
            let params: ProjectRenameParams = decode(method_name, params)?;
            lock_store(state)?.rename_project(&params.path, &params.name)?;
            empty_result()
        }
        method::PROJECTS_REMOVE => {
            let params: ProjectPathParams = decode(method_name, params)?;
            let store = lock_store(state)?;
            let threads = store.threads(Some(&params.path))?;
            let isolated = threads
                .iter()
                .filter(|thread| thread.worktree_path.is_some())
                .count();
            if isolated > 0 {
                return Err(RouteError::internal(format!(
                    "{isolated} isolated session{} in this project still own a private checkout. Discard or keep those first.",
                    if isolated == 1 { "" } else { "s" }
                )));
            }
            for thread in &threads {
                state.agents.close(&thread.id);
                state.terminals.close_thread(&thread.id);
                store.close_thread(&thread.id)?;
            }
            store.remove_project(&params.path)?;
            empty_result()
        }
        method::TERMINAL_OPEN => {
            let params: TerminalOpenParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            validate_terminal_size(method_name, params.columns, params.rows)?;
            let thread = lock_store(state)?
                .thread(&params.thread_id)?
                .ok_or_else(|| {
                    RouteError::internal(format!("no such thread: {}", params.thread_id))
                })?;
            let cwd = thread.worktree_path.unwrap_or(thread.project_path);
            encoded(TerminalOpenedResult {
                terminal_id: state
                    .terminals
                    .open(&params.thread_id, cwd, params.columns, params.rows)
                    .map_err(RouteError::internal)?,
            })
        }
        method::TERMINAL_INPUT => {
            let params: TerminalInputParams = decode(method_name, params)?;
            require_non_empty(method_name, "terminalId", &params.terminal_id)?;
            if params.data.encode_utf16().count() > 65_536 {
                return Err(RouteError::bad_params(
                    method_name,
                    "data exceeds 65,536 UTF-16 code units",
                ));
            }
            state
                .terminals
                .write(&params.terminal_id, &params.data)
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::TERMINAL_RESIZE => {
            let params: TerminalResizeParams = decode(method_name, params)?;
            require_non_empty(method_name, "terminalId", &params.terminal_id)?;
            validate_terminal_size(method_name, params.columns, params.rows)?;
            state
                .terminals
                .resize(&params.terminal_id, params.columns, params.rows)
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::TERMINAL_CLOSE => {
            let params: TerminalIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "terminalId", &params.terminal_id)?;
            state.terminals.close(&params.terminal_id);
            empty_result()
        }
        method::ATTACHMENTS_SAVE_IMAGE => {
            let params: AttachmentImageParams = decode(method_name, params)?;
            let name = crate::uploaded_attachment::image_file_name(&params.mime_type);
            let path = crate::uploaded_attachment::materialize_attachment(name, &params.data, None)
                .map_err(RouteError::internal)?;
            encoded(harness_protocol::AttachmentSavedResult {
                path: path.to_string_lossy().into_owned(),
            })
        }
        method::THREAD_START => {
            let params: ThreadStartParams = decode(method_name, params)?;
            require_non_empty(method_name, "workspacePath", &params.workspace_path)?;
            if params.connection_id.as_deref().is_some_and(str::is_empty)
                || (params.provider == ProviderId::Api) != params.connection_id.is_some()
            {
                return Err(RouteError::bad_params(
                    method_name,
                    "connectionId is required only for api sessions",
                ));
            }
            let thread = state
                .agents
                .start_thread(
                    state,
                    crate::agents::StartThreadRequest {
                        provider: params.provider,
                        agent: params.agent,
                        connection_id: params.connection_id,
                        workspace_path: params.workspace_path,
                        model: params.model,
                        service_tier: params.service_tier,
                        effort: params.effort,
                        approval: params.approval,
                        isolate: params.isolate.unwrap_or(false),
                    },
                )
                .map_err(RouteError::internal)?;
            encoded(ThreadStartResult {
                thread_id: thread.id,
            })
        }
        method::THREAD_RENAME => {
            let params: ThreadRenameParams = decode(method_name, params)?;
            lock_store(state)?.rename_thread(&params.thread_id, &params.title)?;
            empty_result()
        }
        method::THREAD_PIN => {
            let params: ThreadPinParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            lock_store(state)?.set_thread_pinned(&params.thread_id, params.pinned)?;
            empty_result()
        }
        method::THREAD_SETTLE => {
            let params: ThreadIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            let store = lock_store(state)?;
            assert_lifecycle(&store, &params.thread_id, LifecycleState::Active)?;
            assert_can_hide(state, &store, &params.thread_id)?;
            let lifecycle = store.settle_thread(&params.thread_id, SettleReason::Manual, None)?;
            broadcast_lifecycle(state, &params.thread_id, &lifecycle)?;
            encoded(ThreadLifecycleResult { lifecycle })
        }
        method::THREAD_UNSETTLE => {
            let params: ThreadIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            let store = lock_store(state)?;
            assert_lifecycle(&store, &params.thread_id, LifecycleState::Settled)?;
            let lifecycle = store.activate_thread(&params.thread_id, None)?;
            broadcast_lifecycle(state, &params.thread_id, &lifecycle)?;
            encoded(ThreadLifecycleResult { lifecycle })
        }
        method::THREAD_SNOOZE => {
            let params: ThreadSnoozeParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            let wake_at = i64::try_from(params.wake_at)
                .map_err(|_| RouteError::bad_params(method_name, "wakeAt is too large"))?;
            if wake_at <= now_ms().map_err(RouteError::internal)? {
                return Err(RouteError::internal("wake time must be in the future"));
            }
            let store = lock_store(state)?;
            assert_lifecycle(&store, &params.thread_id, LifecycleState::Active)?;
            assert_can_hide(state, &store, &params.thread_id)?;
            let lifecycle = store.snooze_thread(&params.thread_id, wake_at, None)?;
            broadcast_lifecycle(state, &params.thread_id, &lifecycle)?;
            encoded(ThreadLifecycleResult { lifecycle })
        }
        method::THREAD_UNSNOOZE => {
            let params: ThreadIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            let store = lock_store(state)?;
            assert_lifecycle(&store, &params.thread_id, LifecycleState::Snoozed)?;
            let lifecycle = store.activate_thread(&params.thread_id, None)?;
            broadcast_lifecycle(state, &params.thread_id, &lifecycle)?;
            encoded(ThreadLifecycleResult { lifecycle })
        }
        method::THREAD_SET_KEEP_ACTIVE => {
            let params: ThreadKeepActiveParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            let store = lock_store(state)?;
            assert_lifecycle(&store, &params.thread_id, LifecycleState::Active)?;
            let lifecycle =
                store.set_thread_keep_active(&params.thread_id, params.keep_active, None)?;
            broadcast_lifecycle(state, &params.thread_id, &lifecycle)?;
            encoded(ThreadLifecycleResult { lifecycle })
        }
        method::THREAD_DELETE => {
            let params: ThreadIdParams = decode(method_name, params)?;
            if lock_store(state)?
                .thread(&params.thread_id)?
                .is_some_and(|thread| thread.worktree_path.is_some())
            {
                return Err(RouteError::internal(
                    "discard the isolated session checkout before deleting it",
                ));
            }
            state.agents.close(&params.thread_id);
            state.terminals.close_thread(&params.thread_id);
            lock_store(state)?.delete_thread(&params.thread_id)?;
            state
                .inbox
                .lock()
                .map_err(|_| RouteError::internal("inbox projection mutex poisoned"))?
                .remove(&params.thread_id);
            empty_result()
        }
        method::THREAD_HISTORY => {
            let params: ThreadHistoryParams = decode(method_name, params)?;
            let after_seq = params.after_seq.unwrap_or(0.0).max(0.0).floor() as u64;
            let store = lock_store(state)?;
            let result = ThreadHistoryResult {
                events: store.history(&params.thread_id, after_seq)?,
                running: state.agents.is_running(&params.thread_id),
            };
            store.mark_thread_read(&params.thread_id)?;
            encoded(result)
        }
        method::THREAD_DIFF => {
            let params: ThreadIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            encoded(crate::diff_review::read(state, &params.thread_id)?)
        }
        method::THREAD_REVIEW_HUNK => {
            let params: ReviewHunkParams = decode(method_name, params)?;
            validate_review_params(
                method_name,
                &params.thread_id,
                &params.version,
                &params.path,
            )?;
            require_non_empty(method_name, "hunkId", &params.hunk_id)?;
            encoded(ReviewDiffResult {
                diff: crate::diff_review::review_hunk(
                    state,
                    &params.thread_id,
                    &params.version,
                    &params.path,
                    &params.hunk_id,
                    params.decision,
                )?,
            })
        }
        method::THREAD_REVIEW_FILE => {
            let params: ReviewFileParams = decode(method_name, params)?;
            validate_review_params(
                method_name,
                &params.thread_id,
                &params.version,
                &params.path,
            )?;
            encoded(ReviewDiffResult {
                diff: crate::diff_review::review_file(
                    state,
                    &params.thread_id,
                    &params.version,
                    &params.path,
                    params.decision,
                )?,
            })
        }
        method::THREAD_CLOSE => {
            let params: ThreadIdParams = decode(method_name, params)?;
            state.agents.close(&params.thread_id);
            state.terminals.close_thread(&params.thread_id);
            lock_store(state)?.close_thread(&params.thread_id)?;
            empty_result()
        }
        method::THREAD_SEND_TURN => {
            let params: ThreadSendTurnParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            encoded(
                state
                    .agents
                    .submit_turn(
                        state,
                        crate::agents::SubmitTurnRequest {
                            thread_id: params.thread_id,
                            text: params.text,
                            attachments: params.attachments.unwrap_or_default(),
                            options: harness_agent::TurnOptions {
                                model: params.model,
                                service_tier: params.service_tier,
                                effort: params.effort,
                            },
                        },
                    )
                    .map_err(RouteError::internal)?,
            )
        }
        method::THREAD_QUEUE => {
            let params: ThreadIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            encoded(state.agents.queue(&params.thread_id))
        }
        method::THREAD_DELETE_QUEUED_TURN => {
            let params: ThreadSteerQueuedParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            require_non_empty(method_name, "queuedTurnId", &params.queued_turn_id)?;
            state
                .agents
                .delete_queued(state, &params.thread_id, &params.queued_turn_id);
            empty_result()
        }
        method::THREAD_MOVE_QUEUED_TURN => {
            let params: ThreadMoveQueuedParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            require_non_empty(method_name, "queuedTurnId", &params.queued_turn_id)?;
            state.agents.move_queued(
                state,
                &params.thread_id,
                &params.queued_turn_id,
                params.direction,
            );
            empty_result()
        }
        method::THREAD_STEER_QUEUED_TURN => {
            let params: ThreadSteerQueuedParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            require_non_empty(method_name, "queuedTurnId", &params.queued_turn_id)?;
            state
                .agents
                .steer_queued(state, &params.thread_id, &params.queued_turn_id)
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::THREAD_RESPOND_TO_APPROVAL => {
            let params: ThreadApprovalParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            require_non_empty(method_name, "approvalId", &params.approval_id)?;
            state
                .agents
                .respond_to_approval(&params.thread_id, &params.approval_id, params.decision)
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::THREAD_RESPOND_TO_USER_INPUT => {
            let params: ThreadUserInputParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            require_non_empty(method_name, "requestId", &params.request_id)?;
            if params.answers.iter().any(|(question, answers)| {
                question.is_empty() || answers.is_empty() || answers.iter().any(String::is_empty)
            }) {
                return Err(RouteError::bad_params(
                    method_name,
                    "answers must contain non-empty question ids and values",
                ));
            }
            state
                .agents
                .respond_to_user_input(
                    state,
                    &params.thread_id,
                    &params.request_id,
                    &params.answers,
                )
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::THREAD_INTERRUPT => {
            let params: ThreadIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            state
                .agents
                .interrupt(&params.thread_id)
                .map_err(RouteError::internal)?;
            empty_result()
        }
        method::THREAD_CHECKPOINTS => {
            let params: ThreadIdParams = decode(method_name, params)?;
            require_non_empty(method_name, "threadId", &params.thread_id)?;
            encoded(ThreadCheckpointsResult {
                checkpoints: lock_store(state)?
                    .checkpoints(&params.thread_id)?
                    .into_iter()
                    .map(|checkpoint| CheckpointSummary {
                        id: checkpoint.id,
                        seq: checkpoint.seq,
                        label: checkpoint.label,
                        created_at: checkpoint.created_at as f64,
                    })
                    .collect(),
            })
        }
        method::THREAD_CHANGED_SINCE => {
            let params: ThreadCheckpointParams = decode(method_name, params)?;
            let Some(checkpoint_id) = exact_u64(params.checkpoint_id) else {
                return Ok(json!({ "files": [] }));
            };
            let (stored, checkpoint) = {
                let store = lock_store(state)?;
                (
                    store.thread(&params.thread_id)?,
                    store.checkpoint(checkpoint_id)?,
                )
            };
            let files = match (stored, checkpoint) {
                (Some(stored), Some(checkpoint)) if checkpoint.thread_id == params.thread_id => {
                    let repo_path = stored.worktree_path.unwrap_or(stored.project_path);
                    harness_workspace::changed_since(repo_path, &checkpoint.commit)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|path| path.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                }
                _ => Vec::new(),
            };
            Ok(json!({ "files": files }))
        }
        method::THREAD_RESTORE => {
            let params: ThreadCheckpointParams = decode(method_name, params)?;
            let checkpoint_id = exact_u64(params.checkpoint_id)
                .ok_or_else(|| RouteError::internal("no such checkpoint"))?;
            let (stored, checkpoint) = {
                let store = lock_store(state)?;
                (
                    store.thread(&params.thread_id)?,
                    store.checkpoint(checkpoint_id)?,
                )
            };
            let (Some(stored), Some(checkpoint)) = (stored, checkpoint) else {
                return Err(RouteError::internal("no such checkpoint"));
            };
            if checkpoint.thread_id != params.thread_id {
                return Err(RouteError::internal("no such checkpoint"));
            }
            let repo_path = stored.worktree_path.unwrap_or(stored.project_path);
            let replaced = harness_workspace::restore_snapshot(&repo_path, &checkpoint.commit)
                .map_err(RouteError::internal)?;
            let save_result = {
                let mut store = lock_store(state)?;
                store.save_restore_undo(&params.thread_id, checkpoint.seq, &replaced.commit)
            };
            let undo = match save_result {
                Ok(undo) => undo,
                Err(error) => {
                    harness_workspace::restore_snapshot(&repo_path, &replaced.commit)
                        .map_err(RouteError::internal)?;
                    return Err(error.into());
                }
            };
            state
                .inbox
                .lock()
                .map_err(|_| RouteError::internal("inbox projection mutex poisoned"))?
                .remove(&params.thread_id);
            Ok(json!({ "undo": undo }))
        }
        method::THREAD_UNDO_RESTORE => {
            let params: ThreadUndoRestoreParams = decode(method_name, params)?;
            require_non_empty(method_name, "undo", &params.undo)?;
            let (stored, undo) = {
                let store = lock_store(state)?;
                (
                    store.thread(&params.thread_id)?,
                    store.restore_undo(&params.thread_id, &params.undo)?,
                )
            };
            let (Some(stored), Some(undo)) = (stored, undo) else {
                return Err(RouteError::internal("restore can no longer be undone"));
            };
            let repo_path = stored.worktree_path.unwrap_or(stored.project_path);
            let replaced = harness_workspace::restore_snapshot(&repo_path, &undo.commit)
                .map_err(RouteError::internal)?;
            let apply_result = {
                let mut store = lock_store(state)?;
                store.apply_restore_undo(&params.thread_id, &params.undo)
            };
            if let Err(error) = apply_result {
                harness_workspace::restore_snapshot(&repo_path, &replaced.commit)
                    .map_err(RouteError::internal)?;
                return Err(error.into());
            }
            state
                .inbox
                .lock()
                .map_err(|_| RouteError::internal("inbox projection mutex poisoned"))?
                .remove(&params.thread_id);
            empty_result()
        }
        method::THREAD_UNSAVED_WORK => {
            let params: ThreadIdParams = decode(method_name, params)?;
            let stored = lock_store(state)?.thread(&params.thread_id)?;
            let worktree_path = stored.and_then(|thread| thread.worktree_path);
            encoded(ThreadUnsavedWorkResult {
                isolated: worktree_path.is_some(),
                uncommitted: worktree_path
                    .as_deref()
                    .is_some_and(harness_workspace::has_uncommitted_changes),
            })
        }
        method::THREAD_DISCARD_WORKTREE => {
            let params: ThreadDiscardWorktreeParams = decode(method_name, params)?;
            let stored = lock_store(state)?.thread(&params.thread_id)?;
            let Some(stored) = stored else {
                return empty_result();
            };
            let (Some(path), Some(branch)) = (stored.worktree_path, stored.worktree_branch) else {
                return empty_result();
            };
            state.terminals.close_thread(&params.thread_id);
            harness_workspace::remove_worktree(
                &harness_workspace::Worktree {
                    path: path.into(),
                    branch,
                    repo_path: stored.project_path.into(),
                },
                params.force.unwrap_or(false),
            )
            .map_err(RouteError::internal)?;
            lock_store(state)?.forget_worktree(&params.thread_id)?;
            empty_result()
        }
        method::SIDEBAR_SETTINGS => {
            let _: EmptyParams = decode(method_name, params)?;
            encoded(lock_store(state)?.sidebar_settings()?)
        }
        method::SIDEBAR_UPDATE_SETTINGS => {
            let params: SidebarUpdateParams = decode(method_name, params)?;
            if params
                .auto_settle_days
                .flatten()
                .is_some_and(|days| !(1..=90).contains(&days))
            {
                return Err(RouteError::bad_params(
                    method_name,
                    "autoSettleDays must be null or between 1 and 90",
                ));
            }
            let settings = lock_store(state)?.update_sidebar_settings(SidebarSettingsUpdate {
                mode: params.mode,
                auto_settle_days: params.auto_settle_days,
            })?;
            state
                .push
                .broadcast(channel::SIDEBAR_SETTINGS, &settings)
                .map_err(RouteError::internal)?;
            encoded(settings)
        }
        method::USAGE_SUMMARY => {
            let params: UsageParams = decode(method_name, params)?;
            let store = lock_store(state)?;
            let summary = match params {
                UsageParams::Thread(UsageThreadParams { thread_id }) => {
                    if store.thread(&thread_id)?.is_none() {
                        return Err(RouteError::internal("thread not found"));
                    }
                    store.usage_summary(&thread_id, start_of_today_ms())?
                }
                UsageParams::Provider(UsageProviderParams { provider }) => {
                    let _provider = provider;
                    harness_store::UsageSummary {
                        session: empty_usage(),
                        today: empty_usage(),
                    }
                }
            };
            encoded(UsageSummaryResult {
                session: summary.session,
                today: summary.today,
                limits: Vec::new(),
            })
        }
        _ => Err(RouteError::unknown_method(method_name)),
    }
}

pub(crate) fn welcome() -> ServerWelcome {
    ServerWelcome {
        server_version: SERVER_VERSION.into(),
        protocol_version: harness_protocol::PROTOCOL_VERSION,
    }
}

fn decode<T: DeserializeOwned>(method: &str, params: Value) -> Result<T, RouteError> {
    serde_json::from_value(params)
        .map_err(|error| RouteError::bad_params(method, error.to_string()))
}

fn encoded<T: serde::Serialize>(value: T) -> Result<Value, RouteError> {
    serde_json::to_value(value).map_err(RouteError::internal)
}

fn empty_result() -> Result<Value, RouteError> {
    Ok(json!({}))
}

fn lock_store(state: &ServerState) -> Result<MutexGuard<'_, Store>, RouteError> {
    state
        .store
        .lock()
        .map_err(|_| RouteError::internal("store mutex poisoned"))
}

fn inbox_status(
    state: &ServerState,
    store: &Store,
    thread_id: &str,
    unread: bool,
) -> Result<ThreadInboxStatus, RouteError> {
    if let Some(status) = state.agents.activity_status(thread_id) {
        return Ok(status);
    }
    state
        .inbox
        .lock()
        .map_err(|_| RouteError::internal("inbox projection mutex poisoned"))?
        .status(store, thread_id, unread)
        .map_err(Into::into)
}

fn require_non_empty(method: &str, field: &str, value: &str) -> Result<(), RouteError> {
    if value.is_empty() {
        return Err(RouteError::bad_params(
            method,
            format!("{field}: expected a non-empty string"),
        ));
    }
    Ok(())
}

fn validate_review_params(
    method: &str,
    thread_id: &str,
    version: &str,
    path: &str,
) -> Result<(), RouteError> {
    require_non_empty(method, "threadId", thread_id)?;
    require_non_empty(method, "version", version)?;
    require_non_empty(method, "path", path)
}

fn validate_voice_transcription(
    method: &str,
    params: &VoiceTranscribeParams,
) -> Result<(), RouteError> {
    validate_uuid(method, "requestId", &params.request_id)?;
    if params.provider != ProviderId::Codex
        || params.audio_base64.is_empty()
        || params.audio_base64.len() > 13_981_016
        || !valid_base64_shape(&params.audio_base64)
        || params.sample_rate_hz != 24_000
        || !(1..=120_000).contains(&params.duration_ms)
    {
        return Err(RouteError::bad_params(
            method,
            "provider, audioBase64, sampleRateHz, or durationMs is outside the voice contract",
        ));
    }
    Ok(())
}

fn validate_uuid(method: &str, field: &str, value: &str) -> Result<(), RouteError> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| RouteError::bad_params(method, format!("{field}: expected a UUID")))
}

fn valid_base64_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    padding <= 2
        && bytes[..bytes.len().saturating_sub(padding)]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'+' | b'/'))
        && bytes[bytes.len().saturating_sub(padding)..]
            .iter()
            .all(|byte| *byte == b'=')
}

fn validate_terminal_size(method: &str, columns: u16, rows: u16) -> Result<(), RouteError> {
    if !(1..=1_000).contains(&columns) || !(1..=1_000).contains(&rows) {
        return Err(RouteError::bad_params(
            method,
            "columns and rows must be integers between 1 and 1000",
        ));
    }
    Ok(())
}

fn validate_provider_action(method: &str, params: &ProviderActionParams) -> Result<(), RouteError> {
    if params.agent.as_deref().is_some_and(str::is_empty) {
        return Err(RouteError::bad_params(
            method,
            "agent must be a non-empty string when present",
        ));
    }
    validate_terminal_size(method, params.columns, params.rows)
}

fn validate_auth_target(method: &str, params: &AuthParams) -> Result<(), RouteError> {
    if let Some(agent) = params.agent.as_deref() {
        require_non_empty(method, "agent", agent)?;
    }
    Ok(())
}

fn run_provider_terminal(
    state: &ServerState,
    action: &str,
    target: harness_providers::ProviderCommand,
    columns: u16,
    rows: u16,
) -> Result<Value, RouteError> {
    let cwd = dirs::home_dir().ok_or_else(|| RouteError::internal("home directory unavailable"))?;
    encoded(TerminalOpenedResult {
        terminal_id: state
            .terminals
            .run(
                &format!("{action}:{}", target.key),
                target.command,
                cwd,
                columns,
                rows,
            )
            .map_err(RouteError::internal)?,
    })
}

fn exact_u64(value: f64) -> Option<u64> {
    (value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= u64::MAX as f64)
        .then_some(value as u64)
}

fn mcp_config_error(method: &str, error: crate::mcp_config::McpConfigError) -> RouteError {
    match error {
        crate::mcp_config::McpConfigError::InvalidServer(message) => {
            RouteError::bad_params(method, message)
        }
        error => RouteError::internal(error),
    }
}

fn model_connection_error(
    method: &str,
    error: crate::model_connections::ModelConnectionError,
) -> RouteError {
    match error {
        crate::model_connections::ModelConnectionError::InvalidConnection(message) => {
            RouteError::bad_params(method, message)
        }
        error => RouteError::internal(error),
    }
}

fn broadcast_provider_project(
    state: &ServerState,
    channel_name: &str,
    provider: ProviderId,
    project_path: &str,
) -> Result<(), RouteError> {
    state
        .push
        .broadcast(
            channel_name,
            json!({ "provider": provider, "projectPath": project_path }),
        )
        .map_err(RouteError::internal)
}

fn broadcast_lifecycle(
    state: &ServerState,
    thread_id: &str,
    lifecycle: &ThreadLifecycle,
) -> Result<(), RouteError> {
    state
        .push
        .broadcast(
            channel::THREAD_LIFECYCLE,
            ThreadLifecyclePush {
                thread_id: thread_id.into(),
                lifecycle: lifecycle.clone(),
            },
        )
        .map_err(RouteError::internal)
}

#[derive(Clone, Copy)]
enum LifecycleState {
    Active,
    Settled,
    Snoozed,
}

impl LifecycleState {
    fn name(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Settled => "settled",
            Self::Snoozed => "snoozed",
        }
    }
}

fn assert_lifecycle(
    store: &Store,
    thread_id: &str,
    expected: LifecycleState,
) -> Result<(), RouteError> {
    let thread = store
        .thread(thread_id)?
        .ok_or_else(|| RouteError::internal("thread not found"))?;
    if thread.closed_at.is_some() {
        return Err(RouteError::internal(
            "archived threads cannot change inbox shelf",
        ));
    }
    let actual = match thread.lifecycle {
        ThreadLifecycle::Active { .. } => LifecycleState::Active,
        ThreadLifecycle::Settled { .. } => LifecycleState::Settled,
        ThreadLifecycle::Snoozed { .. } => LifecycleState::Snoozed,
    };
    if actual.name() != expected.name() {
        return Err(RouteError::internal(format!(
            "thread is {}, expected {}",
            actual.name(),
            expected.name()
        )));
    }
    Ok(())
}

fn assert_can_hide(state: &ServerState, store: &Store, thread_id: &str) -> Result<(), RouteError> {
    let thread = store
        .thread(thread_id)?
        .ok_or_else(|| RouteError::internal("thread not found"))?;
    let status = inbox_status(state, store, thread_id, thread.unread)?;
    if matches!(
        status,
        ThreadInboxStatus::Starting
            | ThreadInboxStatus::Working
            | ThreadInboxStatus::Queued
            | ThreadInboxStatus::Approval
            | ThreadInboxStatus::Input
    ) {
        let status = serde_json::to_value(status)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "active".into());
        return Err(RouteError::internal(format!(
            "cannot hide a thread while its status is {status}"
        )));
    }
    Ok(())
}

fn now_ms() -> Result<i64, &'static str> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch")?;
    i64::try_from(duration.as_millis()).map_err(|_| "system clock is outside the supported range")
}

fn start_of_today_ms() -> i64 {
    let now = Local::now();
    Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .earliest()
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|| now.timestamp_millis())
}

fn empty_usage() -> Usage {
    Usage {
        input_tokens: 0.0,
        cached_input_tokens: 0.0,
        output_tokens: 0.0,
        reasoning_tokens: 0.0,
        total_tokens: 0.0,
        cost_usd: None,
        context_window: None,
    }
}

fn current_platform() -> SystemPlatform {
    #[cfg(target_os = "windows")]
    return SystemPlatform::Windows;
    #[cfg(target_os = "macos")]
    return SystemPlatform::MacOs;
    #[cfg(target_os = "linux")]
    return SystemPlatform::Linux;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientCapabilitiesParams {
    #[allow(dead_code)]
    preview_capture: bool,
}

#[derive(Deserialize)]
struct EmptyParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    query: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    project_path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    provider: Option<ProviderId>,
    #[serde(default, deserialize_with = "deserialize_present")]
    cursor: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct ProjectAddParams {
    path: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentImageParams {
    mime_type: String,
    data: String,
}

#[derive(Deserialize)]
struct WorkspacePathParams {
    path: String,
}

#[derive(Deserialize)]
struct WorkspaceSwitchParams {
    path: String,
    branch: String,
}

#[derive(Deserialize)]
struct ProjectPinParams {
    path: String,
    pinned: bool,
}

#[derive(Deserialize)]
struct ProjectRenameParams {
    path: String,
    name: String,
}

#[derive(Deserialize)]
struct ProjectPathParams {
    path: String,
}

#[derive(Deserialize)]
struct ProviderActionParams {
    provider: ProviderId,
    #[serde(default, deserialize_with = "deserialize_present")]
    agent: Option<String>,
    columns: u16,
    rows: u16,
}

#[derive(Deserialize)]
struct ModelsListParams {
    provider: ProviderId,
    #[serde(default, deserialize_with = "deserialize_present")]
    agent: Option<String>,
}

#[derive(Deserialize)]
struct VoiceStatusParams {
    provider: ProviderId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceCancelParams {
    request_id: String,
}

#[derive(Deserialize)]
struct AuthParams {
    provider: ProviderId,
    #[serde(default, deserialize_with = "deserialize_present")]
    agent: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthCancelLoginParams {
    #[serde(flatten)]
    target: AuthParams,
    login_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthUseApiKeyParams {
    #[serde(flatten)]
    target: AuthParams,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionCredentialParams {
    connection_id: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionIdParams {
    connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProjectParams {
    provider: ProviderId,
    project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpMutationParams {
    provider: ProviderId,
    project_path: String,
    server: harness_protocol::McpServerConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpRemoveParams {
    provider: ProviderId,
    project_path: String,
    server_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpOAuthParams {
    provider: ProviderId,
    project_path: String,
    server_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpCancelOAuthParams {
    provider: ProviderId,
    project_path: String,
    server_id: String,
    login_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillToggleParams {
    provider: ProviderId,
    project_path: String,
    skill_id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillInstallParams {
    provider: ProviderId,
    project_path: String,
    folder_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadStartParams {
    provider: ProviderId,
    #[serde(default, deserialize_with = "deserialize_present")]
    agent: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    connection_id: Option<String>,
    workspace_path: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    model: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    service_tier: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    effort: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    approval: Option<ApprovalMode>,
    #[serde(default, deserialize_with = "deserialize_present")]
    isolate: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSendTurnParams {
    thread_id: String,
    text: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    attachments: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    model: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    effort: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    service_tier: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSteerQueuedParams {
    thread_id: String,
    queued_turn_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMoveQueuedParams {
    thread_id: String,
    queued_turn_id: String,
    direction: harness_protocol::QueueDirection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadApprovalParams {
    thread_id: String,
    approval_id: String,
    decision: ApprovalDecision,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadUserInputParams {
    thread_id: String,
    request_id: String,
    answers: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOpenParams {
    thread_id: String,
    columns: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalInputParams {
    terminal_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeParams {
    terminal_id: String,
    columns: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalIdParams {
    terminal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadRenameParams {
    thread_id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadPinParams {
    thread_id: String,
    pinned: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadIdParams {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSnoozeParams {
    thread_id: String,
    wake_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadKeepActiveParams {
    thread_id: String,
    keep_active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadDiscardWorktreeParams {
    thread_id: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    force: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCheckpointParams {
    thread_id: String,
    checkpoint_id: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadUndoRestoreParams {
    thread_id: String,
    undo: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadHistoryParams {
    thread_id: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    after_seq: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewHunkParams {
    thread_id: String,
    version: String,
    path: String,
    hunk_id: String,
    decision: DiffDecision,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewFileParams {
    thread_id: String,
    version: String,
    path: String,
    decision: DiffDecision,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidebarUpdateParams {
    #[serde(default, deserialize_with = "deserialize_present")]
    mode: Option<SidebarMode>,
    #[serde(default, deserialize_with = "deserialize_present_optional")]
    auto_settle_days: Option<Option<u8>>,
}

fn deserialize_present_optional<'de, D>(deserializer: D) -> Result<Option<Option<u8>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<u8>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(untagged)]
enum UsageParams {
    Thread(UsageThreadParams),
    Provider(UsageProviderParams),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageThreadParams {
    thread_id: String,
}

#[derive(Deserialize)]
struct UsageProviderParams {
    provider: ProviderId,
}

fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_sidebar_updates_distinguish_missing_from_null() {
        let missing: SidebarUpdateParams = serde_json::from_value(json!({})).unwrap();
        let null: SidebarUpdateParams =
            serde_json::from_value(json!({ "autoSettleDays": null })).unwrap();
        let days: SidebarUpdateParams =
            serde_json::from_value(json!({ "autoSettleDays": 14 })).unwrap();
        assert_eq!(missing.auto_settle_days, None);
        assert_eq!(null.auto_settle_days, Some(None));
        assert_eq!(days.auto_settle_days, Some(Some(14)));
        assert!(serde_json::from_value::<SidebarUpdateParams>(json!({ "mode": null })).is_err());
    }

    #[test]
    fn optional_protocol_fields_reject_null_like_the_zod_contract() {
        assert!(
            serde_json::from_value::<SearchParams>(json!({ "query": "result", "limit": null }))
                .is_err()
        );
        assert!(
            serde_json::from_value::<ProjectAddParams>(json!({ "path": "/repo", "name": null }))
                .is_err()
        );
        assert!(
            serde_json::from_value::<ThreadHistoryParams>(
                json!({ "threadId": "thread", "afterSeq": null })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ThreadDiscardWorktreeParams>(
                json!({ "threadId": "thread", "force": null })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ProviderActionParams>(json!({
                "provider": "acp",
                "agent": null,
                "columns": 80,
                "rows": 24
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ThreadStartParams>(json!({
                "provider": "codex",
                "workspacePath": "/repo",
                "model": null
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ThreadSendTurnParams>(json!({
                "threadId": "thread",
                "text": "hello",
                "attachments": null
            }))
            .is_err()
        );
    }

    #[test]
    fn usage_union_keeps_the_thread_branch_first() {
        let params: UsageParams = serde_json::from_value(json!({
            "threadId": "thread",
            "provider": "codex"
        }))
        .unwrap();
        assert!(matches!(params, UsageParams::Thread(_)));

        let params: UsageParams =
            serde_json::from_value(json!({ "threadId": null, "provider": "codex" })).unwrap();
        assert!(matches!(params, UsageParams::Provider(_)));
    }
}
