use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProviderId {
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "grok")]
    Grok,
    #[serde(rename = "cursor")]
    Cursor,
    #[serde(rename = "opencode")]
    OpenCode,
    #[serde(rename = "antigravity")]
    Antigravity,
    #[serde(rename = "acp")]
    Acp,
    #[serde(rename = "api")]
    Api,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    Message,
    Reasoning,
    Command,
    FileChange,
    ToolCall,
    Plan,
    Error,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Started,
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub turn_id: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub status: ItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<MessageRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<i64>,
    pub created_at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Running,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub thread_id: String,
    pub status: TurnStatus,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub provider: ProviderId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub text: String,
    pub status: PlanStepStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    Running,
    Done,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: f64,
    pub cached_input_tokens: f64,
    pub output_tokens: f64,
    pub reasoning_tokens: f64,
    pub total_tokens: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffLine {
    Context {
        #[serde(rename = "oldLine")]
        old_line: u32,
        #[serde(rename = "newLine")]
        new_line: u32,
        text: String,
        #[serde(
            rename = "noNewlineAtEnd",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        no_newline_at_end: Option<bool>,
    },
    Addition {
        #[serde(rename = "newLine")]
        new_line: u32,
        text: String,
        #[serde(
            rename = "noNewlineAtEnd",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        no_newline_at_end: Option<bool>,
    },
    Deletion {
        #[serde(rename = "oldLine")]
        old_line: u32,
        text: String,
        #[serde(
            rename = "noNewlineAtEnd",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        no_newline_at_end: Option<bool>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffDecision {
    Accept,
    Reject,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub id: String,
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<DiffDecision>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    pub status: DiffFileStatus,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<DiffDecision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiff {
    pub thread_id: String,
    pub version: String,
    pub files: Vec<DiffFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewDiffResult {
    pub diff: SessionDiff,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub kind: ApprovalKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub created_at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalDecision {
    Approve,
    ApproveSession,
    Deny,
    Abort,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    Command,
    FileChange,
    Permissions,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalReview {
    pub id: String,
    pub turn_id: String,
    pub status: ApprovalReviewStatus,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<RiskLevel>,
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalReviewStatus {
    InProgress,
    Approved,
    Denied,
    TimedOut,
    Aborted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputRequest {
    pub id: String,
    pub turn_id: String,
    pub questions: Vec<UserInputQuestion>,
    pub auto_resolution_ms: Option<u64>,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub allow_other: bool,
    pub secret: bool,
    pub options: Option<Vec<UserInputOption>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputOption {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DomainEvent {
    #[serde(rename = "thread.started")]
    ThreadStarted { thread: Thread },
    #[serde(rename = "turn.started")]
    TurnStarted { turn: Turn },
    #[serde(rename = "item.started")]
    ItemStarted { item: Item },
    #[serde(rename = "item.delta", rename_all = "camelCase")]
    ItemDelta {
        turn_id: String,
        item_id: String,
        text_delta: String,
    },
    #[serde(rename = "item.completed")]
    ItemCompleted { item: Item },
    #[serde(rename = "turn.completed", rename_all = "camelCase")]
    TurnCompleted { turn_id: String, status: TurnStatus },
    #[serde(rename = "thread.error", rename_all = "camelCase")]
    ThreadError { thread_id: String, message: String },
    #[serde(rename = "plan.updated", rename_all = "camelCase")]
    PlanUpdated {
        turn_id: String,
        steps: Vec<PlanStep>,
    },
    #[serde(rename = "usage.updated")]
    UsageUpdated { usage: Usage },
    #[serde(rename = "diff.updated", rename_all = "camelCase")]
    DiffUpdated { turn_id: String, diff: String },
    #[serde(rename = "approval.requested")]
    ApprovalRequested { request: ApprovalRequest },
    #[serde(rename = "approval.resolved")]
    ApprovalResolved { id: String },
    #[serde(rename = "user_input.requested")]
    UserInputRequested { request: UserInputRequest },
    #[serde(rename = "user_input.resolved")]
    UserInputResolved { id: String },
    #[serde(rename = "approval.review.started")]
    ApprovalReviewStarted { review: ApprovalReview },
    #[serde(rename = "approval.review.completed")]
    ApprovalReviewCompleted { review: ApprovalReview },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalMode {
    #[serde(rename = "ask")]
    Ask,
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "auto-review")]
    AutoReview,
    #[serde(rename = "full")]
    Full,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub is_default: bool,
    pub reasoning_efforts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
    #[serde(default)]
    pub service_tiers: Vec<ServiceTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_service_tier: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub steer: bool,
    pub fork: bool,
    pub interrupt: bool,
    pub reasoning_items: bool,
    pub approvals: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_input: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_review: Option<bool>,
    pub images: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuth {
    Authenticated,
    Unauthenticated,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLogin {
    App,
    Provider,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetup {
    pub install_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    pub login: ProviderLogin,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: ProviderId,
    pub display_name: String,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub auth: ProviderAuth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Capabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<ProviderSetup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersListResult {
    pub providers: Vec<ProviderStatus>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelTransport {
    OpenaiResponses,
    AnthropicMessages,
    OpenaiCompatible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelConnectionPreset {
    Openai,
    Anthropic,
    Openrouter,
    Kimi,
    Zai,
    Custom,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTransportCapabilities {
    pub streaming: bool,
    pub tools: bool,
    pub images: bool,
    pub reasoning: bool,
    pub model_discovery: bool,
    pub usage: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnection {
    pub id: String,
    pub display_name: String,
    pub preset: ModelConnectionPreset,
    pub transport: ModelTransport,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub enabled: bool,
    pub credential_configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelTransportCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnectionsResult {
    pub connections: Vec<ModelConnection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnectionInput {
    pub id: String,
    pub display_name: String,
    pub preset: ModelConnectionPreset,
    pub transport: ModelTransport,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnectionResult {
    pub connection: ModelConnection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialConfiguredResult {
    pub credential_configured: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionAddressKind {
    Tailscale,
    Lan,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAddress {
    pub kind: ConnectionAddressKind,
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub last_seen_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsStatus {
    pub enabled: bool,
    pub server_name: String,
    pub port: u16,
    pub addresses: Vec<ConnectionAddress>,
    pub devices: Vec<PairedDevice>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    pub enabled: bool,
    pub server_name: String,
    pub port: u16,
    pub addresses: Vec<ConnectionAddress>,
    pub devices: Vec<PairedDevice>,
    pub pairing_uri: String,
    pub expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConnectionStatus {
    pub server_name: String,
    pub addresses: Vec<ConnectionAddress>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionClaimResult {
    pub device_id: String,
    pub device_token: String,
    pub server_name: String,
    pub addresses: Vec<ConnectionAddress>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectDirectoryEntryKind {
    Directory,
    File,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryEntry {
    pub path: String,
    pub name: String,
    pub kind: ProjectDirectoryEntryKind,
    pub modified_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryListing {
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub entries: Vec<ProjectDirectoryEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSavedResult {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgent {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<String>,
    pub setup: ProviderSetup,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentsResult {
    pub agents: Vec<AcpAgent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub signed_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStartLoginResult {
    pub login_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthEventPush {
    pub provider: ProviderId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub login_id: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum McpConfigValue {
    Literal {
        value: String,
    },
    Credential {
        #[serde(rename = "credentialRef")]
        credential_ref: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        environment: Option<BTreeMap<String, McpConfigValue>>,
    },
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        headers: Option<BTreeMap<String, McpConfigValue>>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpServerScope {
    Project,
    Global,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpAuthMethod {
    Oauth,
    Bearer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum McpAuth {
    Unsupported,
    NotRequired,
    SignInRequired { method: McpAuthMethod },
    Authenticated { method: McpAuthMethod },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum McpStartupStatus {
    Stopped,
    Starting,
    Ready,
    Failed { message: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    pub uri: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplate {
    pub uri_template: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub scope: McpServerScope,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransport>,
    pub auth: McpAuth,
    pub startup: McpStartupStatus,
    pub tools: Vec<McpTool>,
    pub resources: Vec<McpResource>,
    pub resource_templates: Vec<McpResourceTemplate>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCapabilities {
    pub inventory: bool,
    pub add: bool,
    pub update: bool,
    pub remove: bool,
    pub reload: bool,
    pub start_o_auth: bool,
    pub cancel_o_auth: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListResult {
    pub capabilities: McpCapabilities,
    pub servers: Vec<McpServer>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransport>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthStartResult {
    pub login_id: String,
    pub auth_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthPush {
    pub provider: ProviderId,
    pub project_path: String,
    pub server_id: String,
    pub login_id: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Project,
    User,
    System,
    Admin,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SkillSource {
    Folder { path: String },
    Provider,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDependencyError {
    pub dependency: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub description: String,
    pub source: SkillSource,
    pub scope: SkillScope,
    pub enabled: bool,
    pub dependency_errors: Vec<SkillDependencyError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiscoveryError {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCapabilities {
    pub inventory: bool,
    pub configure: bool,
    pub install: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListResult {
    pub capabilities: SkillCapabilities,
    pub skills: Vec<Skill>,
    pub errors: Vec<SkillDiscoveryError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEnabledResult {
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstalledResult {
    pub skill: Skill,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsListResult {
    pub models: Vec<Model>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadInboxStatus {
    Starting,
    Working,
    Queued,
    Approval,
    Input,
    Failed,
    Ready,
    Idle,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ThreadLifecycle {
    #[serde(rename_all = "camelCase")]
    Active {
        keep_active: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        woke_at: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Settled {
        settled_at: u64,
        reason: SettleReason,
    },
    #[serde(rename_all = "camelCase")]
    Snoozed { snoozed_at: u64, wake_at: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettleReason {
    Manual,
    Inactivity,
    ChangeRequest,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub path: String,
    pub name: String,
    pub pinned: bool,
    pub created_at: f64,
    pub sessions: Vec<SessionSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub provider: ProviderId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub created_at: f64,
    pub running: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ThreadInboxStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<ThreadLifecycle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsListResult {
    pub projects: Vec<ProjectSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAddedResult {
    pub path: String,
    pub name: String,
    pub pinned: bool,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchSnippetPart {
    pub text: String,
    pub highlighted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResult {
    pub project_path: String,
    pub project_name: String,
    pub thread_id: String,
    pub thread_title: String,
    pub turn_id: String,
    pub provider: ProviderId,
    pub created_at: f64,
    pub snippet: Vec<SearchSnippetPart>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchPage {
    pub results: Vec<SessionSearchResult>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartResult {
    pub thread_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SidebarMode {
    Classic,
    Inbox,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarSettings {
    pub mode: SidebarMode,
    pub auto_settle_days: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerWelcome {
    pub server_version: String,
    pub protocol_version: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SystemPlatform {
    #[serde(rename = "win32")]
    Windows,
    #[serde(rename = "darwin")]
    MacOs,
    #[serde(rename = "linux")]
    Linux,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub server_version: String,
    pub protocol_version: u32,
    pub platform: SystemPlatform,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub added: u64,
    pub removed: u64,
    pub dirty_files: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBranchesResult {
    pub branches: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRemote {
    pub sha: String,
    pub message: String,
    pub date: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<UpdateRemote>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub up_to_date: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceStatusReason {
    ProviderUnsupported,
    SignInRequired,
    UnsupportedAuth,
    CodexTooOld,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatusResult {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<VoiceStatusReason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum VoiceMimeType {
    #[serde(rename = "audio/wav")]
    Wav,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscribeParams {
    pub request_id: String,
    pub provider: ProviderId,
    pub audio_base64: String,
    pub mime_type: VoiceMimeType,
    pub sample_rate_hz: u32,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceTranscriptionResult {
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewViewport {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInteractiveTargetViolation {
    pub selector: String,
    pub label: String,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDomAudit {
    pub h1_count: u32,
    pub interactive_target_violations: Vec<PreviewInteractiveTargetViolation>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewScreenshot {
    pub path: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dom_audit: Option<PreviewDomAudit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCaptureRequest {
    pub request_id: String,
    pub url: String,
    pub viewports: Vec<PreviewViewport>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum PreviewCaptureResult {
    Completed {
        request_id: String,
        screenshots: Vec<PreviewScreenshot>,
    },
    Failed {
        request_id: String,
        error: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventPush {
    pub thread_id: String,
    pub event: DomainEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLifecyclePush {
    pub thread_id: String,
    pub lifecycle: ThreadLifecycle,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenedResult {
    pub terminal_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputPush {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitPush {
    pub terminal_id: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequencedDomainEvent {
    pub seq: u64,
    pub event: DomainEvent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHistoryResult {
    pub events: Vec<SequencedDomainEvent>,
    pub running: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    pub label: String,
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryResult {
    pub session: Usage,
    pub today: Usage,
    pub limits: Vec<UsageLimit>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLifecycleResult {
    pub lifecycle: ThreadLifecycle,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSummary {
    pub id: u64,
    pub seq: u64,
    pub label: String,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCheckpointsResult {
    pub checkpoints: Vec<CheckpointSummary>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadChangedSinceResult {
    pub files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRestoreResult {
    pub undo: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUnsavedWorkResult {
    pub isolated: bool,
    pub uncommitted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanicStopResult {
    pub sessions: Vec<PanicStopSessionResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum PanicStopSessionResult {
    Interrupted {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    Failed {
        #[serde(rename = "threadId")]
        thread_id: String,
        error: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueDirection {
    Up,
    Down,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurn {
    pub id: String,
    pub text: String,
    pub attachments: Vec<String>,
    pub created_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadQueueResult {
    pub items: Vec<QueuedTurn>,
    pub can_steer: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadQueuePush {
    pub thread_id: String,
    pub items: Vec<QueuedTurn>,
    pub can_steer: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SendTurnResult {
    Started {
        queued: bool,
        #[serde(rename = "turnId")]
        turn_id: String,
    },
    Queued {
        queued: bool,
        #[serde(rename = "queuedTurn")]
        queued_turn: QueuedTurn,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn domain_delta_matches_the_typescript_discriminant() {
        let event = DomainEvent::ItemDelta {
            turn_id: "turn-1".into(),
            item_id: "item-1".into(),
            text_delta: "hello".into(),
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "type": "item.delta",
                "turnId": "turn-1",
                "itemId": "item-1",
                "textDelta": "hello"
            })
        );
    }

    #[test]
    fn provider_and_approval_hyphenation_is_stable() {
        assert_eq!(
            serde_json::to_value(ProviderId::ClaudeCode).unwrap(),
            "claude-code"
        );
        assert_eq!(serde_json::to_value(ProviderId::Grok).unwrap(), "grok");
        assert_eq!(
            serde_json::to_value(ProviderId::Antigravity).unwrap(),
            "antigravity"
        );
        assert_eq!(
            serde_json::to_value(ApprovalMode::AutoReview).unwrap(),
            "auto-review"
        );
        assert_eq!(
            serde_json::to_value(ApprovalDecision::ApproveSession).unwrap(),
            "approve-session"
        );
    }

    #[test]
    fn system_update_results_match_the_typescript_wire_shape() {
        let info: SystemInfo = serde_json::from_value(json!({
            "serverVersion": "0.0.0",
            "protocolVersion": 2,
            "platform": "darwin"
        }))
        .unwrap();
        let update: UpdateCheckResult = serde_json::from_value(json!({
            "localCommit": "1111111",
            "remote": {
                "sha": "2222222",
                "message": "Latest change",
                "date": "2026-08-06T12:00:00Z"
            },
            "upToDate": false
        }))
        .unwrap();

        assert_eq!(info.platform, SystemPlatform::MacOs);
        assert_eq!(update.local_commit.as_deref(), Some("1111111"));
        assert_eq!(update.remote.unwrap().message, "Latest change");
        assert_eq!(update.up_to_date, Some(false));
    }

    #[test]
    fn panic_stop_results_match_the_discriminated_wire_contract() {
        let result = PanicStopResult {
            sessions: vec![
                PanicStopSessionResult::Interrupted {
                    thread_id: "thread-1".into(),
                },
                PanicStopSessionResult::Failed {
                    thread_id: "thread-2".into(),
                    error: "Adapter did not respond".into(),
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "sessions": [
                    {"threadId": "thread-1", "status": "interrupted"},
                    {
                        "threadId": "thread-2",
                        "status": "failed",
                        "error": "Adapter did not respond"
                    }
                ]
            })
        );
    }

    #[test]
    fn queue_directions_match_the_lowercase_wire_contract() {
        assert_eq!(
            serde_json::to_value(QueueDirection::Up).unwrap(),
            json!("up")
        );
        assert_eq!(
            serde_json::from_value::<QueueDirection>(json!("down")).unwrap(),
            QueueDirection::Down
        );
    }

    #[test]
    fn session_search_results_keep_structured_plain_text_highlights() {
        let page = SessionSearchPage {
            results: vec![SessionSearchResult {
                project_path: "/repo".into(),
                project_name: "Harness".into(),
                thread_id: "thread-1".into(),
                thread_title: "Find regression".into(),
                turn_id: "turn-1".into(),
                provider: ProviderId::Codex,
                created_at: 42.0,
                snippet: vec![
                    SearchSnippetPart {
                        text: "Find ".into(),
                        highlighted: false,
                    },
                    SearchSnippetPart {
                        text: "regression".into(),
                        highlighted: true,
                    },
                ],
            }],
            next_cursor: None,
        };

        assert_eq!(
            serde_json::to_value(page).unwrap(),
            json!({
                "results": [{
                    "projectPath": "/repo",
                    "projectName": "Harness",
                    "threadId": "thread-1",
                    "threadTitle": "Find regression",
                    "turnId": "turn-1",
                    "provider": "codex",
                    "createdAt": 42.0,
                    "snippet": [
                        { "text": "Find ", "highlighted": false },
                        { "text": "regression", "highlighted": true }
                    ]
                }],
                "nextCursor": null
            })
        );
    }

    #[test]
    fn voice_types_match_the_normalized_wav_contract() {
        let status: VoiceStatusResult = serde_json::from_value(json!({
            "available": false,
            "reason": "sign_in_required"
        }))
        .unwrap();
        let params = VoiceTranscribeParams {
            request_id: "3a7c0fb4-222e-471a-97de-f062ad676df4".into(),
            provider: ProviderId::Codex,
            audio_base64: "UklGRg==".into(),
            mime_type: VoiceMimeType::Wav,
            sample_rate_hz: 24_000,
            duration_ms: 1_000,
        };

        assert_eq!(status.reason, Some(VoiceStatusReason::SignInRequired));
        assert_eq!(
            serde_json::to_value(params).unwrap(),
            json!({
                "requestId": "3a7c0fb4-222e-471a-97de-f062ad676df4",
                "provider": "codex",
                "audioBase64": "UklGRg==",
                "mimeType": "audio/wav",
                "sampleRateHz": 24_000,
                "durationMs": 1_000
            })
        );
    }

    #[test]
    fn preview_capture_results_match_the_desktop_bridge() {
        let request: PreviewCaptureRequest = serde_json::from_value(json!({
            "requestId": "3a7c0fb4-222e-471a-97de-f062ad676df4",
            "url": "http://127.0.0.1:4173",
            "viewports": [{ "width": 390, "height": 844 }]
        }))
        .unwrap();
        let result = PreviewCaptureResult::Completed {
            request_id: request.request_id,
            screenshots: vec![PreviewScreenshot {
                path: "/tmp/mobile.png".into(),
                width: request.viewports[0].width,
                height: request.viewports[0].height,
                dom_audit: None,
            }],
        };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "status": "completed",
                "requestId": "3a7c0fb4-222e-471a-97de-f062ad676df4",
                "screenshots": [{
                    "path": "/tmp/mobile.png",
                    "width": 390,
                    "height": 844
                }]
            })
        );

        let audited_value = json!({
            "path": "/tmp/mobile.png",
            "width": 390,
            "height": 844,
            "domAudit": {
                "h1Count": 0,
                "interactiveTargetViolations": [{
                    "selector": "#theme",
                    "label": "Theme",
                    "width": 32.5,
                    "height": 32.25
                }]
            }
        });
        let audited: PreviewScreenshot = serde_json::from_value(audited_value.clone()).unwrap();
        assert_eq!(audited.dom_audit.as_ref().unwrap().h1_count, 0);
        assert_eq!(serde_json::to_value(audited).unwrap(), audited_value);
    }

    #[test]
    fn provider_catalog_matches_the_typescript_wire_shape() {
        let providers: ProvidersListResult = serde_json::from_value(json!({
            "providers": [{
                "id": "codex",
                "displayName": "Codex",
                "installed": true,
                "version": "1.2.3",
                "auth": "authenticated"
            }]
        }))
        .unwrap();
        let connections: ModelConnectionsResult = serde_json::from_value(json!({
            "connections": [{
                "id": "local",
                "displayName": "Local",
                "preset": "custom",
                "transport": "openai-compatible",
                "baseUrl": "http://127.0.0.1:8080/v1",
                "defaultModel": "local-model",
                "enabled": true,
                "credentialConfigured": true
            }]
        }))
        .unwrap();

        assert_eq!(providers.providers[0].id, ProviderId::Codex);
        assert_eq!(
            connections.connections[0].transport,
            ModelTransport::OpenaiCompatible
        );
        assert_eq!(
            connections.connections[0].default_model.as_deref(),
            Some("local-model")
        );

        let input = ModelConnectionInput {
            id: "openai-1".into(),
            display_name: "OpenAI API".into(),
            preset: ModelConnectionPreset::Openai,
            transport: ModelTransport::OpenaiResponses,
            base_url: "https://api.openai.com/v1".into(),
            default_model: None,
            enabled: true,
        };
        assert_eq!(
            serde_json::to_value(input).unwrap(),
            json!({
                "id": "openai-1",
                "displayName": "OpenAI API",
                "preset": "openai",
                "transport": "openai-responses",
                "baseUrl": "https://api.openai.com/v1",
                "enabled": true
            })
        );
    }

    #[test]
    fn mobile_access_types_match_the_typescript_wire_shape() {
        let offer: PairingOffer = serde_json::from_value(json!({
            "enabled": true,
            "serverName": "Studio Mac",
            "port": 4312,
            "addresses": [{
                "kind": "tailscale",
                "label": "Tailscale 100.101.22.33",
                "url": "ws://100.101.22.33:4312"
            }],
            "devices": [{
                "id": "phone-1",
                "name": "iPhone",
                "createdAt": 42,
                "lastSeenAt": 84
            }],
            "pairingUri": "harness://pair?payload=abc",
            "expiresAt": 300000
        }))
        .unwrap();

        assert_eq!(offer.port, 4312);
        assert_eq!(offer.addresses[0].kind, ConnectionAddressKind::Tailscale);
        assert_eq!(offer.devices[0].last_seen_at, 84);
        assert_eq!(
            serde_json::to_value(DeviceConnectionStatus {
                server_name: offer.server_name,
                addresses: offer.addresses,
            })
            .unwrap(),
            json!({
                "serverName": "Studio Mac",
                "addresses": [{
                    "kind": "tailscale",
                    "label": "Tailscale 100.101.22.33",
                    "url": "ws://100.101.22.33:4312"
                }]
            })
        );
    }

    #[test]
    fn remote_project_and_attachment_types_match_the_mobile_contract() {
        let listing: ProjectDirectoryListing = serde_json::from_value(json!({
            "path": "/Users/person/Developer",
            "name": "Developer",
            "parent": "/Users/person",
            "entries": [{
                "path": "/Users/person/Developer/harness",
                "name": "harness",
                "kind": "directory",
                "modifiedAt": 42.5
            }]
        }))
        .unwrap();

        assert_eq!(
            listing.entries[0].kind,
            ProjectDirectoryEntryKind::Directory
        );
        assert_eq!(listing.entries[0].modified_at, 42.5);
        assert_eq!(
            serde_json::to_value(AttachmentSavedResult {
                path: "/tmp/attachment.png".into(),
            })
            .unwrap(),
            json!({ "path": "/tmp/attachment.png" })
        );
    }

    #[test]
    fn structured_diff_matches_the_review_contract() {
        let diff: SessionDiff = serde_json::from_value(json!({
            "threadId": "thread-1",
            "version": "snapshot-1",
            "files": [{
                "path": "src/app.rs",
                "status": "modified",
                "binary": false,
                "hunks": [{
                    "id": "hunk-1",
                    "header": "@@ -1 +1 @@",
                    "oldStart": 1,
                    "oldLines": 1,
                    "newStart": 1,
                    "newLines": 1,
                    "lines": [
                        { "kind": "deletion", "oldLine": 1, "text": "old" },
                        { "kind": "addition", "newLine": 1, "text": "new" }
                    ],
                    "decision": "accept"
                }]
            }]
        }))
        .unwrap();

        assert_eq!(diff.files[0].status, DiffFileStatus::Modified);
        assert_eq!(diff.files[0].hunks[0].decision, Some(DiffDecision::Accept));
        assert!(matches!(
            diff.files[0].hunks[0].lines[1],
            DiffLine::Addition { new_line: 1, .. }
        ));
    }

    #[test]
    fn terminal_pushes_match_the_typescript_wire_shape() {
        let output: TerminalOutputPush = serde_json::from_value(json!({
            "terminalId": "terminal-1",
            "data": "\u{1b}[31mred\u{1b}[0m"
        }))
        .unwrap();
        let exit: TerminalExitPush = serde_json::from_value(json!({
            "terminalId": "terminal-1",
            "exitCode": null
        }))
        .unwrap();

        assert_eq!(output.terminal_id, "terminal-1");
        assert_eq!(exit.exit_code, None);
    }

    #[test]
    fn mcp_and_skills_match_the_typescript_wire_shape() {
        let mcp: McpListResult = serde_json::from_value(json!({
            "capabilities": {
                "inventory": true,
                "add": true,
                "update": true,
                "remove": true,
                "reload": true,
                "startOAuth": true,
                "cancelOAuth": true
            },
            "servers": [{
                "id": "docs",
                "displayName": "Docs",
                "scope": "project",
                "enabled": true,
                "transport": { "type": "http", "url": "https://example.com/mcp" },
                "auth": { "status": "authenticated", "method": "oauth" },
                "startup": { "state": "ready" },
                "tools": [],
                "resources": [],
                "resourceTemplates": []
            }]
        }))
        .unwrap();
        let skills: SkillsListResult = serde_json::from_value(json!({
            "capabilities": { "inventory": true, "configure": true, "install": true },
            "skills": [{
                "id": "skill-1",
                "name": "review",
                "description": "Review the current change",
                "source": { "type": "folder", "path": "review-skill" },
                "scope": "project",
                "enabled": true,
                "dependencyErrors": []
            }],
            "errors": []
        }))
        .unwrap();

        assert!(mcp.capabilities.start_o_auth);
        assert!(matches!(mcp.servers[0].startup, McpStartupStatus::Ready));
        assert_eq!(skills.skills[0].scope, SkillScope::Project);
        assert_eq!(
            serde_json::to_value(mcp.capabilities).unwrap()["cancelOAuth"],
            true
        );

        let oauth: McpOAuthPush = serde_json::from_value(json!({
            "provider": "codex",
            "projectPath": "/tmp/project",
            "serverId": "docs",
            "loginId": "login-1",
            "success": true,
            "error": null
        }))
        .unwrap();
        assert_eq!(oauth.server_id, "docs");
    }

    #[test]
    fn durable_server_results_match_the_typescript_wire_shape() {
        let lifecycle = ThreadLifecycleResult {
            lifecycle: ThreadLifecycle::Active {
                keep_active: true,
                woke_at: Some(42),
            },
        };
        assert_eq!(
            serde_json::to_value(lifecycle).unwrap(),
            json!({
                "lifecycle": { "state": "active", "keepActive": true, "wokeAt": 42 }
            })
        );

        let checkpoints = ThreadCheckpointsResult {
            checkpoints: vec![CheckpointSummary {
                id: 1,
                seq: 7,
                label: "After setup".into(),
                created_at: 100.0,
            }],
        };
        assert_eq!(
            serde_json::to_value(checkpoints).unwrap(),
            json!({
                "checkpoints": [{
                    "id": 1,
                    "seq": 7,
                    "label": "After setup",
                    "createdAt": 100.0
                }]
            })
        );

        let summary = UsageSummaryResult {
            session: Usage {
                input_tokens: 1.0,
                cached_input_tokens: 2.0,
                output_tokens: 3.0,
                reasoning_tokens: 4.0,
                total_tokens: 10.0,
                cost_usd: None,
                context_window: None,
            },
            today: Usage {
                input_tokens: 0.0,
                cached_input_tokens: 0.0,
                output_tokens: 0.0,
                reasoning_tokens: 0.0,
                total_tokens: 0.0,
                cost_usd: None,
                context_window: None,
            },
            limits: Vec::new(),
        };
        assert_eq!(serde_json::to_value(summary).unwrap()["limits"], json!([]));

        assert_eq!(
            serde_json::to_value(WorkspaceInfo {
                branch: Some("feature/native".into()),
                added: 3,
                removed: 1,
                dirty_files: 2,
            })
            .unwrap(),
            json!({
                "branch": "feature/native",
                "added": 3,
                "removed": 1,
                "dirtyFiles": 2
            })
        );
        assert_eq!(
            serde_json::to_value(ThreadUnsavedWorkResult {
                isolated: true,
                uncommitted: false,
            })
            .unwrap(),
            json!({ "isolated": true, "uncommitted": false })
        );
        assert_eq!(
            serde_json::to_value(WorkspaceBranchesResult {
                branches: vec!["main".into(), "feature/native".into()],
            })
            .unwrap(),
            json!({ "branches": ["main", "feature/native"] })
        );
        assert_eq!(
            serde_json::to_value(ThreadChangedSinceResult {
                files: vec!["src/app.rs".into()],
            })
            .unwrap(),
            json!({ "files": ["src/app.rs"] })
        );
        assert_eq!(
            serde_json::to_value(ThreadRestoreResult {
                undo: "restore-token".into(),
            })
            .unwrap(),
            json!({ "undo": "restore-token" })
        );
    }

    #[test]
    fn mcp_credential_references_use_the_camel_case_wire_field() {
        let value = McpConfigValue::Credential {
            credential_ref: "mcp/docs/token".into(),
        };
        assert_eq!(
            serde_json::to_value(&value).unwrap(),
            json!({ "source": "credential", "credentialRef": "mcp/docs/token" })
        );
        assert_eq!(
            serde_json::from_value::<McpConfigValue>(json!({
                "source": "credential",
                "credentialRef": "mcp/docs/token"
            }))
            .unwrap(),
            value
        );
    }
}
