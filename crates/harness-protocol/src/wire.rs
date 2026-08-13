use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request<P = Value> {
    pub id: String,
    pub method: String,
    pub params: P,
}

impl<P> Request<P> {
    pub fn new(id: impl Into<String>, method: impl Into<String>, params: P) -> Self {
        Self {
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Response<R = Value> {
    Success { id: String, result: R },
    Failure { id: String, error: WireError },
}

impl<R> Response<R> {
    pub fn id(&self) -> &str {
        match self {
            Self::Success { id, .. } | Self::Failure { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    Forbidden,
    NotFound,
    ProviderUnavailable,
    StaleSnapshot,
    Internal,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Push<D = Value> {
    pub channel: String,
    pub sequence: u64,
    pub data: D,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InboundFrame {
    Response(Response),
    Push(Push),
}

pub mod method {
    pub const CLIENT_CAPABILITIES: &str = "client.capabilities";
    pub const PREVIEW_CAPTURE_RESULT: &str = "preview.captureResult";
    pub const SYSTEM_INFO: &str = "system.info";
    pub const SYSTEM_PANIC_STOP: &str = "system.panicStop";
    pub const SEARCH_SESSIONS: &str = "search.sessions";
    pub const SYSTEM_UPDATE_CHECK: &str = "system.updateCheck";
    pub const VOICE_STATUS: &str = "voice.status";
    pub const VOICE_TRANSCRIBE: &str = "voice.transcribe";
    pub const VOICE_CANCEL: &str = "voice.cancel";
    pub const PROVIDERS_LIST: &str = "providers.list";
    pub const PROVIDERS_INSTALL: &str = "providers.install";
    pub const PROVIDERS_LAUNCH: &str = "providers.launch";
    pub const CONNECTIONS_LIST: &str = "connections.list";
    pub const CONNECTIONS_UPSERT: &str = "connections.upsert";
    pub const CONNECTIONS_SET_CREDENTIAL: &str = "connections.setCredential";
    pub const CONNECTIONS_REMOVE: &str = "connections.remove";
    pub const CONNECTIONS_MODELS: &str = "connections.models";
    pub const MCP_LIST: &str = "mcp.list";
    pub const MCP_ADD: &str = "mcp.add";
    pub const MCP_UPDATE: &str = "mcp.update";
    pub const MCP_REMOVE: &str = "mcp.remove";
    pub const MCP_RELOAD: &str = "mcp.reload";
    pub const MCP_START_OAUTH: &str = "mcp.startOAuth";
    pub const MCP_CANCEL_OAUTH: &str = "mcp.cancelOAuth";
    pub const SKILLS_LIST: &str = "skills.list";
    pub const SKILLS_SET_ENABLED: &str = "skills.setEnabled";
    pub const SKILLS_INSTALL_FROM_FOLDER: &str = "skills.installFromFolder";
    pub const ACP_AGENTS: &str = "acp.agents";
    pub const WORKSPACE_INFO: &str = "workspace.info";
    pub const WORKSPACE_BRANCHES: &str = "workspace.branches";
    pub const WORKSPACE_SWITCH_BRANCH: &str = "workspace.switchBranch";
    pub const AUTH_STATUS: &str = "auth.status";
    pub const AUTH_START_LOGIN: &str = "auth.startLogin";
    pub const AUTH_CANCEL_LOGIN: &str = "auth.cancelLogin";
    pub const AUTH_USE_API_KEY: &str = "auth.useApiKey";
    pub const AUTH_SIGN_OUT: &str = "auth.signOut";
    pub const PROJECTS_LIST: &str = "projects.list";
    pub const PROJECTS_ADD: &str = "projects.add";
    pub const PROJECTS_PIN: &str = "projects.pin";
    pub const PROJECTS_RENAME: &str = "projects.rename";
    pub const PROJECTS_REMOVE: &str = "projects.remove";
    pub const TERMINAL_OPEN: &str = "terminal.open";
    pub const TERMINAL_INPUT: &str = "terminal.input";
    pub const TERMINAL_RESIZE: &str = "terminal.resize";
    pub const TERMINAL_CLOSE: &str = "terminal.close";
    pub const ATTACHMENTS_SAVE_IMAGE: &str = "attachments.saveImage";
    pub const MODELS_LIST: &str = "models.list";
    pub const THREAD_START: &str = "thread.start";
    pub const THREAD_RENAME: &str = "thread.rename";
    pub const THREAD_PIN: &str = "thread.pin";
    pub const THREAD_SETTLE: &str = "thread.settle";
    pub const THREAD_UNSETTLE: &str = "thread.unsettle";
    pub const THREAD_SNOOZE: &str = "thread.snooze";
    pub const THREAD_UNSNOOZE: &str = "thread.unsnooze";
    pub const THREAD_SET_KEEP_ACTIVE: &str = "thread.setKeepActive";
    pub const THREAD_DELETE: &str = "thread.delete";
    pub const THREAD_HISTORY: &str = "thread.history";
    pub const THREAD_DIFF: &str = "thread.diff";
    pub const THREAD_REVIEW_HUNK: &str = "thread.reviewHunk";
    pub const THREAD_REVIEW_FILE: &str = "thread.reviewFile";
    pub const THREAD_SEND_TURN: &str = "thread.sendTurn";
    pub const THREAD_RESPOND_TO_APPROVAL: &str = "thread.respondToApproval";
    pub const THREAD_RESPOND_TO_USER_INPUT: &str = "thread.respondToUserInput";
    pub const THREAD_INTERRUPT: &str = "thread.interrupt";
    pub const THREAD_CLOSE: &str = "thread.close";
    pub const THREAD_CHECKPOINTS: &str = "thread.checkpoints";
    pub const THREAD_CHANGED_SINCE: &str = "thread.changedSince";
    pub const THREAD_RESTORE: &str = "thread.restore";
    pub const THREAD_UNDO_RESTORE: &str = "thread.undoRestore";
    pub const THREAD_UNSAVED_WORK: &str = "thread.unsavedWork";
    pub const THREAD_DISCARD_WORKTREE: &str = "thread.discardWorktree";
    pub const THREAD_QUEUE: &str = "thread.queue";
    pub const THREAD_DELETE_QUEUED_TURN: &str = "thread.deleteQueuedTurn";
    pub const THREAD_MOVE_QUEUED_TURN: &str = "thread.moveQueuedTurn";
    pub const THREAD_STEER_QUEUED_TURN: &str = "thread.steerQueuedTurn";
    pub const SIDEBAR_SETTINGS: &str = "sidebar.settings";
    pub const SIDEBAR_UPDATE_SETTINGS: &str = "sidebar.updateSettings";
    pub const USAGE_SUMMARY: &str = "usage.summary";
}

pub mod channel {
    pub const SERVER_WELCOME: &str = "server.welcome";
    pub const PREVIEW_CAPTURE_REQUESTED: &str = "preview.captureRequested";
    pub const AUTH_EVENT: &str = "auth.event";
    pub const THREAD_EVENT: &str = "thread.event";
    pub const THREAD_QUEUE: &str = "thread.queue";
    pub const THREAD_LIFECYCLE: &str = "thread.lifecycle";
    pub const SIDEBAR_SETTINGS: &str = "sidebar.settings";
    pub const TERMINAL_OUTPUT: &str = "terminal.output";
    pub const TERMINAL_EXIT: &str = "terminal.exit";
    pub const MCP_OAUTH: &str = "mcp.oauth";
    pub const MCP_CHANGED: &str = "mcp.changed";
    pub const SKILLS_CHANGED: &str = "skills.changed";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_uses_the_existing_wire_shape() {
        let request = Request::new(
            "request-1",
            method::THREAD_HISTORY,
            json!({ "threadId": "thread-1" }),
        );

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "id": "request-1",
                "method": "thread.history",
                "params": { "threadId": "thread-1" }
            })
        );
    }

    #[test]
    fn inbound_frames_distinguish_responses_from_pushes() {
        let response: InboundFrame = serde_json::from_value(json!({
            "id": "request-1",
            "result": { "protocolVersion": 2 }
        }))
        .unwrap();
        let push: InboundFrame = serde_json::from_value(json!({
            "channel": "server.welcome",
            "sequence": 7,
            "data": { "serverVersion": "0.0.0", "protocolVersion": 2 }
        }))
        .unwrap();

        assert!(matches!(response, InboundFrame::Response(_)));
        assert!(matches!(push, InboundFrame::Push(_)));
    }

    #[test]
    fn terminal_contract_keeps_the_existing_method_and_push_names() {
        assert_eq!(method::TERMINAL_OPEN, "terminal.open");
        assert_eq!(method::TERMINAL_INPUT, "terminal.input");
        assert_eq!(method::TERMINAL_RESIZE, "terminal.resize");
        assert_eq!(method::TERMINAL_CLOSE, "terminal.close");
        assert_eq!(channel::TERMINAL_OUTPUT, "terminal.output");
        assert_eq!(channel::TERMINAL_EXIT, "terminal.exit");
    }

    #[test]
    fn sidebar_settings_contract_keeps_the_existing_update_method() {
        assert_eq!(method::SIDEBAR_SETTINGS, "sidebar.settings");
        assert_eq!(method::SIDEBAR_UPDATE_SETTINGS, "sidebar.updateSettings");
        assert_eq!(channel::SIDEBAR_SETTINGS, "sidebar.settings");
    }

    #[test]
    fn durable_store_methods_keep_the_existing_names() {
        assert_eq!(method::SEARCH_SESSIONS, "search.sessions");
        assert_eq!(method::PROJECTS_PIN, "projects.pin");
        assert_eq!(method::PROJECTS_RENAME, "projects.rename");
        assert_eq!(method::PROJECTS_REMOVE, "projects.remove");
        assert_eq!(method::THREAD_PIN, "thread.pin");
        assert_eq!(method::THREAD_SETTLE, "thread.settle");
        assert_eq!(method::THREAD_UNSETTLE, "thread.unsettle");
        assert_eq!(method::THREAD_SNOOZE, "thread.snooze");
        assert_eq!(method::THREAD_UNSNOOZE, "thread.unsnooze");
        assert_eq!(method::THREAD_SET_KEEP_ACTIVE, "thread.setKeepActive");
        assert_eq!(method::THREAD_DELETE, "thread.delete");
        assert_eq!(method::THREAD_CLOSE, "thread.close");
        assert_eq!(method::THREAD_CHECKPOINTS, "thread.checkpoints");
        assert_eq!(method::THREAD_CHANGED_SINCE, "thread.changedSince");
        assert_eq!(method::THREAD_RESTORE, "thread.restore");
        assert_eq!(method::THREAD_UNDO_RESTORE, "thread.undoRestore");
        assert_eq!(method::THREAD_UNSAVED_WORK, "thread.unsavedWork");
        assert_eq!(method::THREAD_DISCARD_WORKTREE, "thread.discardWorktree");
        assert_eq!(method::USAGE_SUMMARY, "usage.summary");
        assert_eq!(method::WORKSPACE_INFO, "workspace.info");
        assert_eq!(method::WORKSPACE_BRANCHES, "workspace.branches");
        assert_eq!(method::WORKSPACE_SWITCH_BRANCH, "workspace.switchBranch");
    }

    #[test]
    fn system_contract_keeps_the_existing_update_method() {
        assert_eq!(method::SYSTEM_INFO, "system.info");
        assert_eq!(method::SYSTEM_PANIC_STOP, "system.panicStop");
        assert_eq!(method::SYSTEM_UPDATE_CHECK, "system.updateCheck");
    }

    #[test]
    fn queue_mutation_contract_keeps_the_existing_method_names() {
        assert_eq!(method::THREAD_DELETE_QUEUED_TURN, "thread.deleteQueuedTurn");
        assert_eq!(method::THREAD_MOVE_QUEUED_TURN, "thread.moveQueuedTurn");
        assert_eq!(method::THREAD_STEER_QUEUED_TURN, "thread.steerQueuedTurn");
    }

    #[test]
    fn voice_contract_keeps_the_existing_method_names() {
        assert_eq!(method::VOICE_STATUS, "voice.status");
        assert_eq!(method::VOICE_TRANSCRIBE, "voice.transcribe");
        assert_eq!(method::VOICE_CANCEL, "voice.cancel");
    }

    #[test]
    fn preview_capture_keeps_the_existing_method_and_push_names() {
        assert_eq!(method::PREVIEW_CAPTURE_RESULT, "preview.captureResult");
        assert_eq!(
            channel::PREVIEW_CAPTURE_REQUESTED,
            "preview.captureRequested"
        );
    }

    #[test]
    fn mcp_and_skills_contract_keep_the_existing_method_names() {
        assert_eq!(method::MCP_LIST, "mcp.list");
        assert_eq!(method::MCP_ADD, "mcp.add");
        assert_eq!(method::MCP_UPDATE, "mcp.update");
        assert_eq!(method::MCP_REMOVE, "mcp.remove");
        assert_eq!(method::MCP_RELOAD, "mcp.reload");
        assert_eq!(method::MCP_START_OAUTH, "mcp.startOAuth");
        assert_eq!(method::MCP_CANCEL_OAUTH, "mcp.cancelOAuth");
        assert_eq!(method::SKILLS_LIST, "skills.list");
        assert_eq!(method::SKILLS_SET_ENABLED, "skills.setEnabled");
        assert_eq!(
            method::SKILLS_INSTALL_FROM_FOLDER,
            "skills.installFromFolder"
        );
        assert_eq!(channel::MCP_OAUTH, "mcp.oauth");
        assert_eq!(channel::MCP_CHANGED, "mcp.changed");
        assert_eq!(channel::SKILLS_CHANGED, "skills.changed");
    }

    #[test]
    fn connection_mutations_keep_the_existing_method_names() {
        assert_eq!(method::CONNECTIONS_UPSERT, "connections.upsert");
        assert_eq!(
            method::CONNECTIONS_SET_CREDENTIAL,
            "connections.setCredential"
        );
        assert_eq!(method::CONNECTIONS_REMOVE, "connections.remove");
    }

    #[test]
    fn attachment_method_keeps_the_existing_name() {
        assert_eq!(method::ATTACHMENTS_SAVE_IMAGE, "attachments.saveImage");
    }

    #[test]
    fn authentication_keeps_the_existing_method_and_push_names() {
        assert_eq!(method::AUTH_STATUS, "auth.status");
        assert_eq!(method::AUTH_START_LOGIN, "auth.startLogin");
        assert_eq!(method::AUTH_CANCEL_LOGIN, "auth.cancelLogin");
        assert_eq!(method::AUTH_USE_API_KEY, "auth.useApiKey");
        assert_eq!(method::AUTH_SIGN_OUT, "auth.signOut");
        assert_eq!(channel::AUTH_EVENT, "auth.event");
    }

    #[test]
    fn provider_terminal_actions_keep_the_existing_method_names() {
        assert_eq!(method::PROVIDERS_INSTALL, "providers.install");
        assert_eq!(method::PROVIDERS_LAUNCH, "providers.launch");
    }
}
