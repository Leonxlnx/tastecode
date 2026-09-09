import { EventEmitter } from 'node:events'
import type {
  Account,
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  ApprovalReview,
  Capabilities,
  DomainEvent,
  McpServer,
  McpServerConfig,
  McpStartupStatus,
  Model,
  Skill,
  SkillDiscoveryError,
  Thread,
  Usage,
  UserInputRequest,
} from '@harness/contracts'
import { mapThreadItem } from './map-item.js'
import {
  spawnCli,
  StdioJsonRpc,
  type JsonRpcRequestOptions,
  type JsonRpcResultParser,
  type JsonRpcValue,
  type ParsedJsonRpcRequestOptions,
  type ServerRequestHandler,
} from '@harness/proc'
import { ZodError } from 'zod'
import type { JsonValue } from './generated/serde_json/JsonValue.js'
import { CODEX_CAPABILITIES } from './capabilities.js'
import {
  mapMcpServerStatus,
  mapMcpStartupStatus,
  mcpStartupInventory,
  prepareMcpConfig,
} from './mcp.js'
import { mapSkillList } from './skills.js'
import {
  AccountLoginCompletedNotificationSchema,
  AccountResponseSchema,
  ApprovalParamsSchema,
  CodexRateLimitResponseSchema,
  ConsumeRateLimitResetResponseSchema,
  CommandOutputDeltaNotificationSchema,
  ErrorNotificationSchema,
  GuardianReviewCompletedSchema,
  GuardianReviewStartedSchema,
  ItemCompletedNotificationSchema,
  ItemDeltaNotificationSchema,
  ItemStartedNotificationSchema,
  ListMcpServerStatusResponseSchema,
  LoginAccountResponseSchema,
  McpServerOauthLoginCompletedNotificationSchema,
  McpServerOauthLoginResponseSchema,
  McpServerStatusUpdatedNotificationSchema,
  ModelListResponseSchema,
  PermissionsRequestApprovalParamsSchema,
  SkillsConfigWriteResponseSchema,
  SkillsListResponseSchema,
  ThreadResumeResponseSchema,
  ThreadStartResponseSchema,
  ThreadStartedNotificationSchema,
  ThreadTokenUsageUpdatedNotificationSchema,
  ToolRequestUserInputParamsSchema,
  TurnCompletedNotificationSchema,
  TurnDiffUpdatedNotificationSchema,
  TurnPlanUpdatedNotificationSchema,
  TurnStartedNotificationSchema,
  TurnStartResponseSchema,
  WarningNotificationSchema,
  type CodexRateLimitResponse,
  type CodexRateLimitSnapshot,
  type CodexResetOutcome,
  type ApprovalParams,
  type ErrorNotification,
  type GuardianReviewAction,
  type GuardianReviewNotification,
  type RequestPermissionProfile,
  type PermissionsRequestApprovalParams,
  type ThreadTokenUsageUpdatedNotification,
  type ToolRequestUserInputParams,
  type WarningNotification,
} from './schemas.js'

export { CODEX_CAPABILITIES } from './capabilities.js'

/**
 * Tier 1 adapter: drives `codex app-server` over JSON-RPC.
 *
 * This is the richest integration any vendor offers, which is why it is the
 * first one built — designing the internal domain model against the best
 * available protocol keeps it from collapsing to a lowest common denominator.
 *
 * Note what this adapter does NOT do: it never reads `~/.codex/auth.json` or
 * any other credential. The binary authenticates itself. See rules/security.md.
 */

const CLIENT_NAME = 'tastecode'
const CONTROL_READ_TIMEOUT_MS = 10_000
const THREAD_START_TIMEOUT_MS = 30_000

/** Provider state TasteCode either does not expose or already derives from shared events. */
export function isIgnorableCodexNotification(method: string): boolean {
  return method === 'remoteControl/status/changed' || method === 'thread/status/changed'
}

export function formatCodexWarning(notification: WarningNotification): string {
  return `Codex warning: ${notification.message}`
}

export function mapCodexError(notification: ErrorNotification): DomainEvent | undefined {
  if (notification.willRetry) return undefined
  return {
    type: 'thread.error',
    threadId: notification.threadId,
    message: notification.error.message,
  }
}

export function mapCodexUsage(
  notification: ThreadTokenUsageUpdatedNotification,
  model?: string,
): Usage {
  const total = notification.tokenUsage.total
  // Codex's total is cumulative spend; its last counter is context occupancy.
  // Usage cannot carry both numerators, so exposing the window beside total
  // would render an impossible context percentage after a few turns.
  return {
    ...(model ? { model } : {}),
    inputTokens: total.inputTokens,
    cachedInputTokens: total.cachedInputTokens,
    outputTokens: total.outputTokens,
    reasoningTokens: total.reasoningOutputTokens,
    totalTokens: total.totalTokens,
    cumulative: true,
    inputIncludesCached: true,
  }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

function isImage(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? false : IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Command output arrives base64-encoded because it is raw bytes, not text. */
function decodeBase64(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

export type StartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  serviceTier?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
  ephemeral?: boolean | undefined
}

export type TurnOptions = Pick<StartOptions, 'model' | 'serviceTier' | 'effort'>
type Spawn = typeof spawnCli

export interface CodexRpc {
  onStderr(handler: (text: string) => void): void
  onNotification(handler: (method: string, params: JsonRpcValue | undefined) => void): void
  onServerRequest(handler: ServerRequestHandler): void
  request(
    method: string,
    params?: unknown,
    options?: JsonRpcRequestOptions,
  ): Promise<JsonRpcValue | undefined>
  request<Result>(
    method: string,
    params: unknown,
    options: ParsedJsonRpcRequestOptions<Result>,
  ): Promise<Result>
  notify(method: string, params?: unknown): void
  dispose(): void | Promise<void>
}

export type ProviderLimit = {
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  valueLabel?: string | undefined
  action?: 'consume-reset' | undefined
}

export type CodexLimitSource =
  { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }

/**
 * Our four user-facing modes onto Codex's approval policy and sandbox.
 *
 * `full` is genuinely dangerous, which is why the UI never makes it the quiet
 * default and never remembers it silently across sessions.
 */
export const CODEX_APPROVAL = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' },
  'auto-review': {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    approvalsReviewer: 'auto_review',
  },
  full: { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' },
} satisfies Record<
  ApprovalMode,
  { approvalPolicy: string; sandbox: string; approvalsReviewer: 'user' | 'auto_review' }
>

const REVIEW_STATUS = {
  inProgress: 'in_progress',
  approved: 'approved',
  denied: 'denied',
  timedOut: 'timed_out',
  aborted: 'aborted',
} satisfies Record<GuardianReviewNotification['review']['status'], ApprovalReview['status']>

export function mapUserInputRequest(params: ToolRequestUserInputParams): UserInputRequest {
  return {
    id: params.itemId,
    turnId: params.turnId,
    questions: params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      allowOther: question.isOther,
      secret: question.isSecret,
      options: question.options,
    })),
    autoResolutionMs: params.autoResolutionMs,
    createdAt: Date.now(),
  }
}

function describeApprovalReviewAction(action: GuardianReviewAction): string {
  switch (action.type) {
    case 'command':
      return `Run ${action.command}`
    case 'execve':
      return `Run ${[action.program, ...action.argv].join(' ')}`
    case 'applyPatch':
      return action.files.length === 1
        ? `Edit ${action.files[0]}`
        : `Edit ${action.files.length} files`
    case 'networkAccess':
      return `Connect to ${action.target}`
    case 'mcpToolCall':
      return `Use ${action.toolTitle ?? `${action.server}.${action.toolName}`}`
    case 'requestPermissions':
      return action.reason
        ? `Request extra permissions: ${action.reason}`
        : 'Request extra permissions'
  }
}

export function mapAutoApprovalReview(params: GuardianReviewNotification): ApprovalReview {
  const completedAt = 'completedAtMs' in params ? params.completedAtMs : undefined
  return {
    id: params.reviewId,
    turnId: params.turnId,
    status: REVIEW_STATUS[params.review.status],
    description: describeApprovalReviewAction(params.action),
    ...(params.review.rationale ? { rationale: params.review.rationale } : {}),
    ...(params.review.riskLevel ? { riskLevel: params.review.riskLevel } : {}),
    startedAt: params.startedAtMs,
    ...(completedAt
      ? {
          completedAt: completedAt,
        }
      : {}),
  }
}

/** The vendor's plan ids are not display strings. */
function planLabel(plan: string): string {
  return PLAN_LABELS.find(([id]) => id === plan)?.[1] ?? 'Signed in'
}

const PLAN_LABELS = [
  ['free', 'Free'],
  ['go', 'Go'],
  ['plus', 'Plus'],
  ['pro', 'Pro'],
  ['prolite', 'Pro Lite'],
  ['team', 'Team'],
  ['business', 'Business'],
  ['enterprise', 'Enterprise'],
  ['edu', 'Edu'],
] as const

const CODEX_COMPATIBILITY_MODELS: Model[] = [
  codexCompatibilityModel(
    'gpt-5.5',
    'GPT-5.5',
    'Frontier model for complex coding, research, and real-world work.',
  ),
  codexCompatibilityModel('gpt-5.4', 'GPT-5.4', 'Strong model for everyday coding.'),
  codexCompatibilityModel(
    'gpt-5.4-mini',
    'GPT-5.4-Mini',
    'Small, fast, and cost-efficient model for simpler coding tasks.',
  ),
  codexCompatibilityModel(
    'gpt-5.3-codex-spark',
    'GPT-5.3-Codex-Spark',
    'Ultra-fast coding model.',
    'high',
  ),
]

function codexCompatibilityModel(
  id: string,
  displayName: string,
  description: string,
  defaultReasoningEffort = 'medium',
): Model {
  return {
    id,
    displayName,
    description,
    isDefault: false,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort,
    serviceTiers: [],
  }
}

/** Which server requests are approval prompts, and what they are about. */
const APPROVAL_KIND = new Map<string, ApprovalRequest['kind']>([
  ['item/commandExecution/requestApproval', 'command'],
  ['item/fileChange/requestApproval', 'file_change'],
  ['item/permissions/requestApproval', 'permissions'],
  ['execCommandApproval', 'command'],
  ['applyPatchApproval', 'file_change'],
])

/**
 * Our four answers onto Codex's per-kind decision vocabulary.
 *
 * `abort` maps to cancel, which stops the turn rather than just this step —
 * "no, and stop" is a different intent from "not this one".
 */
const DECISION = {
  command: {
    approve: 'accept',
    'approve-session': 'acceptForSession',
    deny: 'decline',
    abort: 'cancel',
  },
  file_change: {
    approve: 'accept',
    'approve-session': 'acceptForSession',
    deny: 'decline',
    abort: 'cancel',
  },
  permissions: {
    approve: 'accept',
    'approve-session': 'acceptForSession',
    deny: 'decline',
    abort: 'cancel',
  },
} satisfies Record<ApprovalRequest['kind'], Record<ApprovalDecision, string>>

export function mapApprovalResponse(
  kind: ApprovalRequest['kind'],
  decision: ApprovalDecision,
  requested?: RequestPermissionProfile,
): CodexApprovalResponse {
  if (kind !== 'permissions') {
    return { decision: DECISION[kind][decision] }
  }
  const permissions: Record<string, JsonRpcValue> = {}
  if (decision === 'approve' || decision === 'approve-session') {
    if (requested?.network) permissions['network'] = { enabled: requested.network.enabled }
    if (requested?.fileSystem) {
      const fileSystem = {
        read: requested.fileSystem.read,
        write: requested.fileSystem.write,
        ...(requested.fileSystem.globScanMaxDepth === undefined
          ? {}
          : { globScanMaxDepth: requested.fileSystem.globScanMaxDepth }),
        ...(requested.fileSystem.entries === undefined
          ? {}
          : { entries: requested.fileSystem.entries }),
      }
      permissions['fileSystem'] = fileSystem
    }
  }
  return {
    permissions,
    scope: decision === 'approve-session' ? 'session' : 'turn',
  }
}

type CodexApprovalResponse =
  | { decision: string }
  | {
      permissions: Record<string, JsonRpcValue>
      scope: 'session' | 'turn'
    }

type ParsedApprovalRequest =
  | { kind: 'permissions'; params: PermissionsRequestApprovalParams }
  | { kind: 'command' | 'file_change'; params: ApprovalParams }

export function mapApprovalRequest(input: ParsedApprovalRequest): ApprovalRequest {
  const { kind, params } = input
  if (kind === 'permissions') {
    return {
      id: params.itemId,
      kind,
      ...(params.reason ? { reason: params.reason } : {}),
      command: `Requested access:\n${JSON.stringify(params.permissions, null, 2)}`,
      cwd: params.cwd,
      createdAt: Date.now(),
    }
  }

  return {
    id:
      ('approvalId' in params ? params.approvalId : undefined) ??
      params.itemId ??
      crypto.randomUUID(),
    kind,
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.command ? { command: params.command } : {}),
    ...(params.cwd ? { cwd: String(params.cwd) } : {}),
    ...(params.grantRoot ? { path: params.grantRoot } : {}),
    createdAt: Date.now(),
  }
}

export function permissionInterruptParams(threadId: string, turnId: string) {
  return { threadId, turnId }
}

export type CodexAdapterEvents = {
  event: [DomainEvent]
  log: [string]
  /** Emitted when the browser half of an OAuth flow finishes. */
  login: [{ loginId: string | null; success: boolean; error: string | null }]
  mcpOAuth: [{ serverId: string; loginId: string; success: boolean; error: string | null }]
  mcpChanged: [{ threadId?: string }]
  skillsChanged: []
  /** Provider-owned subscription usage changed; consumers should refetch. */
  usageChanged: []
}

export class CodexAdapter extends EventEmitter<CodexAdapterEvents> {
  #processStop: Promise<void> = Promise.resolve()
  readonly #spawn: Spawn
  #rpc: CodexRpc | undefined
  #started = false
  #mcpStartup = new Map<string, McpStartupStatus>()
  #mcpInventory = new Map<string, McpServer[]>()
  #mcpInventoryLoads = new Map<string, Promise<void>>()
  #threadModels = new Map<string, string>()
  #activeTurns = new Map<string, string>()
  #sessionThread: { id: string; workspacePath: string } | undefined
  #mcpServers: Record<string, JsonValue>
  #mcpEnvironment: NodeJS.ProcessEnv
  #mcpLogins = new Map<string, string>()
  /**
   * Approvals waiting on an answer, keyed by our id. Holds the JSON-RPC
   * responder because Codex is blocked on that specific request id.
   */
  #approvals = new Map<
    string,
    {
      kind: ApprovalRequest['kind']
      respond: (result: JsonRpcValue) => void
      permissions?: RequestPermissionProfile
      threadId?: string
      turnId?: string
    }
  >()
  #userInputs = new Map<string, (result: JsonRpcValue) => void>()

  constructor(
    options: {
      mcpServers?: McpServerConfig[]
      mcpCredentials?: Record<string, string>
      spawn?: Spawn
    } = {},
  ) {
    super()
    this.#spawn = options.spawn ?? spawnCli
    const prepared = prepareMcpConfig(options.mcpServers ?? [], options.mcpCredentials ?? {})
    this.#mcpServers = prepared.servers
    this.#mcpEnvironment = prepared.environment
  }

  get capabilities(): Capabilities {
    return CODEX_CAPABILITIES
  }

  /** Spawn the app-server and complete the handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.#started) return

    // Structured questions are gated in Codex's default collaboration mode.
    // Enable the native tool at process startup so every advertised user-input
    // capability is real rather than a request the model can never make.
    const rpc = new StdioJsonRpc(
      this.#spawn('codex', ['app-server', '--enable', 'default_mode_request_user_input'], {
        env: this.#mcpEnvironment,
      }),
      'Codex',
      {
        onProtocolError: (error) => {
          const turns = [...this.#activeTurns]
          this.#activeTurns.clear()
          for (const [threadId, turnId] of turns) {
            this.emit('event', { type: 'thread.error', threadId, message: error.message })
            this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
          }
        },
      },
    )
    this.#rpc = rpc

    rpc.onStderr((text) => this.emit('log', text.trimEnd()))
    rpc.onNotification((method, params) => this.#onNotification(method, params))

    rpc.onServerRequest((method, params, respond) => this.#onServerRequest(method, params, respond))

    try {
      await rpc.request(
        'initialize',
        { clientInfo: { name: CLIENT_NAME, title: 'TasteCode', version: '0.0.0' } },
        { timeoutMs: CONTROL_READ_TIMEOUT_MS },
      )
    } catch (error) {
      await rpc.dispose()
      this.#rpc = undefined
      throw error
    }
    rpc.notify('initialized', {})
    this.#started = true
  }

  /**
   * Who is signed in, asked of the binary itself.
   *
   * We never read ~/.codex/auth.json. The binary owns its credentials and
   * answers questions about them; that is the whole compliance posture.
   */
  async account(): Promise<Account> {
    const { account } = await this.#callParsed('account/read', {}, AccountResponseSchema)
    if (!account) return { signedIn: false }
    switch (account.type) {
      case 'apiKey':
        return { signedIn: true, plan: 'API key' }
      case 'chatgpt':
        return {
          signedIn: true,
          ...(account.email ? { email: account.email } : {}),
          plan: planLabel(account.planType),
        }
      default:
        return { signedIn: true }
    }
  }

  /** Subscription availability and headroom, decided inside the adapter. */
  async rateLimitSource(): Promise<CodexLimitSource> {
    const { account } = await this.#callParsed(
      'account/read',
      {},
      AccountResponseSchema,
      CONTROL_READ_TIMEOUT_MS,
    ).catch((cause) => {
      if (cause instanceof ZodError) throw new Error('Codex account response was invalid.')
      throw cause
    })
    if (account?.type !== 'chatgpt') return { status: 'unavailable' }
    const response = await this.#callParsed(
      'account/rateLimits/read',
      {},
      CodexRateLimitResponseSchema,
      CONTROL_READ_TIMEOUT_MS,
    ).catch((cause) => {
      if (cause instanceof ZodError) throw new Error('Codex rate-limit response was invalid.')
      throw cause
    })
    return { status: 'ready', limits: mapCodexRateLimits(response) }
  }

  /** Compatibility view while the orchestrator migrates to the richer source state. */
  async rateLimits(): Promise<ProviderLimit[]> {
    const source = await this.rateLimitSource()
    return source.status === 'ready' ? source.limits : []
  }

  /**
   * Spend one earned reset. The caller owns the idempotency key so a retry of
   * the same attempt cannot redeem a second credit.
   */
  async consumeRateLimitReset(idempotencyKey: string): Promise<CodexResetOutcome> {
    const response = await this.#callParsed(
      'account/rateLimitResetCredit/consume',
      { idempotencyKey },
      ConsumeRateLimitResetResponseSchema,
      CONTROL_READ_TIMEOUT_MS,
    ).catch((cause) => {
      if (cause instanceof ZodError) throw new Error('Codex reset-credit response was invalid.')
      throw cause
    })
    return response.outcome
  }

  onUsageChanged(listener: () => void): void {
    this.on('usageChanged', listener)
  }

  /**
   * Starts the vendor's own OAuth flow. Returns the URL to open in a browser —
   * the user authenticates on OpenAI's site, not in our window, and we are
   * never in a position to see the credential.
   */
  async startLogin(): Promise<{ loginId: string; authUrl: string }> {
    const response = await this.#callParsed(
      'account/login/start',
      { type: 'chatgpt' },
      LoginAccountResponseSchema,
    )
    if (response.type !== 'chatgpt') throw new Error('unexpected login response')
    return { loginId: response.loginId, authUrl: response.authUrl }
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.#call('account/login/cancel', { loginId })
  }

  /** Bring-your-own-key. The key is the user's to use with any client. */
  async useApiKey(apiKey: string): Promise<Account> {
    await this.#call('account/login/start', { type: 'apiKey', apiKey })
    return this.account()
  }

  async signOut(): Promise<void> {
    await this.#call('account/logout', {})
  }

  /**
   * The real catalogue, from the provider. We never ship a hardcoded model list
   * — vendors add models constantly and a stale dropdown is worse than none.
   */
  async listModels(): Promise<Model[]> {
    const response = await this.#callParsed('model/list', {}, ModelListResponseSchema)
    const models: Model[] = response.data
      .filter((model) => !model.hidden && model.id !== 'gpt-5.2')
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        isDefault: model.isDefault,
        reasoningEfforts: model.supportedReasoningEfforts.map((option) =>
          String(option.reasoningEffort),
        ),
        ...(model.defaultReasoningEffort
          ? {
              defaultReasoningEffort: String(model.defaultReasoningEffort),
            }
          : {}),
        serviceTiers: model.serviceTiers.map((tier) => ({
          id: String(tier.id),
          name: String(tier.name),
          description: String(tier.description),
        })),
        ...(model.defaultServiceTier
          ? {
              defaultServiceTier: String(model.defaultServiceTier),
            }
          : {}),
      }))

    // Codex 0.147 omits older selectable models from model/list. Preserve the
    // last provider-advertised metadata while letting live rows win.
    for (const compatibilityModel of CODEX_COMPATIBILITY_MODELS) {
      if (!models.some((model) => model.id === compatibilityModel.id)) {
        models.push(compatibilityModel)
      }
    }
    return models
  }

  async listMcpServers(threadId?: string): Promise<McpServer[]> {
    const key = threadId ?? ''
    const cached = this.#mcpInventory.get(key)
    if (cached) return cached
    if (!this.#mcpInventoryLoads.has(key)) {
      const loading = this.#loadMcpServers(threadId)
        .then((servers) => {
          this.#mcpInventory.set(key, servers)
          this.emit('mcpChanged', threadId ? { threadId } : {})
        })
        .catch((cause) => {
          this.emit(
            'log',
            `MCP inventory refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        })
        .finally(() => this.#mcpInventoryLoads.delete(key))
      this.#mcpInventoryLoads.set(key, loading)
    }
    return mcpStartupInventory(this.#mcpStartup, threadId)
  }

  async #loadMcpServers(threadId?: string): Promise<McpServer[]> {
    const servers: McpServer[] = []
    let cursor: string | undefined
    do {
      const response = await this.#callParsed(
        'mcpServerStatus/list',
        {
          detail: 'full',
          ...(threadId ? { threadId: threadId } : {}),
          ...(cursor ? { cursor: cursor } : {}),
        },
        ListMcpServerStatusResponseSchema,
      )
      servers.push(
        ...response.data.map((status) =>
          mapMcpServerStatus(status, this.#mcpStartup.get(mcpStartupKey(threadId, status.name))),
        ),
      )
      cursor = response.nextCursor ?? undefined
    } while (cursor)
    return servers
  }

  async listSkills(projectPath: string): Promise<{
    skills: Skill[]
    errors: SkillDiscoveryError[]
  }> {
    const response = await this.#callParsed(
      'skills/list',
      { cwds: [projectPath], forceReload: true },
      SkillsListResponseSchema,
    )
    return mapSkillList(response, projectPath)
  }

  async setSkillEnabled(skillId: string, enabled: boolean): Promise<boolean> {
    const response = await this.#callParsed(
      'skills/config/write',
      { path: skillId, name: null, enabled },
      SkillsConfigWriteResponseSchema,
    )
    return response.effectiveEnabled
  }

  async reloadMcpServers(
    threadId: string,
    servers: McpServerConfig[],
    credentials: Record<string, string>,
  ): Promise<void> {
    const prepared = prepareMcpConfig(servers, credentials)
    for (const [name, value] of Object.entries(prepared.environment)) {
      if (this.#mcpEnvironment[name] !== value) {
        throw new Error('start a new session to apply new MCP credentials')
      }
    }
    try {
      await this.#call('thread/resume', {
        threadId,
        config: { mcp_servers: prepared.servers },
      })
    } catch {
      throw new Error('Codex could not hot-reload MCP config; start a new session to apply it')
    }
    await this.#call('config/mcpServer/reload', undefined)
    // Only after the process actually reloaded: assigning earlier left the
    // in-memory config disagreeing with the running Codex on failure. The
    // inventory cache describes the pre-reload world, so it goes too.
    this.#mcpServers = prepared.servers
    this.#mcpInventory.delete(threadId)
    this.#mcpInventoryLoads.delete(threadId)
    this.emit('mcpChanged', { threadId })
  }

  async startMcpOAuth(
    serverId: string,
    threadId: string,
  ): Promise<{ loginId: string; authUrl: string }> {
    const response = await this.#callParsed(
      'mcpServer/oauth/login',
      { name: serverId, threadId },
      McpServerOauthLoginResponseSchema,
    )
    const loginId = crypto.randomUUID()
    this.#mcpLogins.set(mcpLoginKey(threadId, serverId), loginId)
    return { loginId, authUrl: response.authorizationUrl }
  }

  onMcpOAuth(
    listener: (result: {
      serverId: string
      loginId: string
      success: boolean
      error: string | null
    }) => void,
  ): void {
    this.on('mcpOAuth', listener)
  }

  async startThread(workspacePath: string, options: StartOptions = {}): Promise<Thread> {
    const approval = options.approval ? CODEX_APPROVAL[options.approval] : undefined
    const config = {
      ...(options.effort
        ? {
            model_reasoning_effort: options.effort,
          }
        : {}),
      ...(Object.keys(this.#mcpServers).length
        ? {
            mcp_servers: this.#mcpServers,
          }
        : {}),
    }
    const response = await this.#callParsed(
      'thread/start',
      {
        cwd: workspacePath,
        ...(options.model ? { model: options.model } : {}),
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
        ...(options.instructions
          ? {
              developerInstructions: options.instructions,
            }
          : {}),
        ...(options.ephemeral !== undefined
          ? {
              ephemeral: options.ephemeral,
            }
          : {}),
        ...(Object.keys(config).length ? { config } : {}),
        ...approval,
      },
      ThreadStartResponseSchema,
      THREAD_START_TIMEOUT_MS,
    )
    this.#threadModels.set(response.thread.id, response.model)
    const thread = {
      id: response.thread.id,
      provider: 'codex' as const,
      workspacePath,
      createdAt: Date.now(),
    }
    this.#sessionThread = { id: thread.id, workspacePath }
    return thread
  }

  async resumeThread(
    threadId: string,
    workspacePath: string,
    options: Pick<StartOptions, 'instructions' | 'approval'> = {},
  ): Promise<Thread> {
    const approval = options.approval ? CODEX_APPROVAL[options.approval] : undefined
    const response = await this.#callParsed(
      'thread/resume',
      {
        threadId,
        cwd: workspacePath,
        ...(options.instructions
          ? {
              developerInstructions: options.instructions,
            }
          : {}),
        ...approval,
        ...(Object.keys(this.#mcpServers).length
          ? {
              config: { mcp_servers: this.#mcpServers },
            }
          : {}),
      },
      ThreadResumeResponseSchema,
    )
    this.#threadModels.set(response.thread.id, response.model)
    const thread = {
      id: response.thread.id,
      provider: 'codex' as const,
      workspacePath,
      // Codex reports seconds; guard against it ever switching to millis,
      // which the blind ×1000 would launch fifty millennia into the future.
      createdAt:
        response.thread.createdAt < 100_000_000_000
          ? response.thread.createdAt * 1_000
          : response.thread.createdAt,
    }
    this.#sessionThread = { id: thread.id, workspacePath }
    return thread
  }

  async setApproval(approval: ApprovalMode): Promise<void> {
    const thread = this.#sessionThread
    if (!thread) throw new Error('no active Codex thread')
    await this.resumeThread(thread.id, thread.workspacePath, { approval })
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: TurnOptions = {},
  ): Promise<string> {
    const response = await this.#callParsed(
      'turn/start',
      {
        threadId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.serviceTier
          ? {
              serviceTier: options.serviceTier,
            }
          : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        input: [
          { type: 'text', text, text_elements: [] },
          // Images go in as images so the model can actually see them; anything
          // else becomes a mention, which is Codex's way of saying "this path is
          // relevant" without pushing the whole file into context.
          ...attachments.map((path) =>
            isImage(path)
              ? { type: 'localImage', path }
              : { type: 'mention', name: basename(path), path },
          ),
        ],
      },
      TurnStartResponseSchema,
    )
    if (options.model) this.#threadModels.set(threadId, options.model)
    return response.turn.id
  }

  async interrupt(threadId: string): Promise<void> {
    const turnId = this.#activeTurns.get(threadId)
    if (!turnId) throw new Error('there is no running Codex turn to interrupt')
    await this.#call('turn/interrupt', { threadId, turnId })
  }

  /**
   * Answer a pending approval.
   *
   * The reply goes back on the exact JSON-RPC request that asked, which is why
   * the responder is held rather than the question re-derived — Codex is
   * blocked waiting on that specific id.
   */
  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.#approvals.get(approvalId)
    if (!pending) return
    this.#approvals.delete(approvalId)
    pending.respond(mapApprovalResponse(pending.kind, decision, pending.permissions))
    this.emit('event', { type: 'approval.resolved', id: approvalId })
    if (
      pending.kind === 'permissions' &&
      decision === 'abort' &&
      pending.threadId &&
      pending.turnId
    ) {
      void this.#call(
        'turn/interrupt',
        permissionInterruptParams(pending.threadId, pending.turnId),
      ).catch(() => this.emit('log', 'Codex permission abort failed to stop the turn'))
    }
  }

  respondToUserInput(requestId: string, answers: Record<string, string[]>): void {
    const respond = this.#userInputs.get(requestId)
    if (!respond) return
    this.#userInputs.delete(requestId)
    respond({
      answers: Object.fromEntries(
        Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
      ),
    })
    this.emit('event', { type: 'user_input.resolved', id: requestId })
  }

  /** Inject input without restarting the turn. Codex is one of the few engines that can. */
  async steer(threadId: string, text: string, attachments: string[] = []): Promise<void> {
    const expectedTurnId = this.#activeTurns.get(threadId)
    if (!expectedTurnId) throw new Error('there is no running Codex turn to steer')
    await this.#call('turn/steer', {
      threadId,
      expectedTurnId,
      input: [
        { type: 'text', text, text_elements: [] },
        ...attachments.map((path) =>
          isImage(path)
            ? { type: 'localImage', path }
            : { type: 'mention', name: basename(path), path },
        ),
      ],
    })
  }

  dispose(): Promise<void> {
    const stopped = this.#rpc ? Promise.resolve(this.#rpc.dispose()) : this.#processStop
    this.#rpc = undefined
    this.#started = false
    this.#mcpStartup.clear()
    this.#mcpInventory.clear()
    this.#mcpInventoryLoads.clear()
    this.#threadModels.clear()
    this.#activeTurns.clear()
    this.#sessionThread = undefined
    // Held responders close over the dead transport; answering one after
    // disposal would write into nothing. Drop them with the process.
    this.#approvals.clear()
    this.#userInputs.clear()
    this.#mcpLogins.clear()
    this.removeAllListeners()
    this.#processStop = stopped
    return stopped
  }

  #call(method: string, params: object | undefined): Promise<JsonRpcValue | undefined> {
    if (!this.#rpc) throw new Error('adapter not started')
    return this.#rpc.request(method, params)
  }

  #callParsed<Result>(
    method: string,
    params: object,
    result: JsonRpcResultParser<Result>,
    timeoutMs?: number,
  ): Promise<Result> {
    if (!this.#rpc) throw new Error('adapter not started')
    return this.#rpc.request(method, params, {
      result,
      ...(timeoutMs ? { timeoutMs: timeoutMs } : {}),
    })
  }

  /**
   * Codex asks permission by making a request of us, not by sending an event.
   * Anything we do not recognise is declined — silently approving a request we
   * could not even parse is the worst possible default.
   */
  #onServerRequest(
    method: string,
    params: JsonRpcValue | undefined,
    respond: (result: JsonRpcValue) => void,
  ): void {
    if (method === 'item/tool/requestUserInput') {
      const request = mapUserInputRequest(ToolRequestUserInputParamsSchema.parse(params))
      this.#userInputs.set(request.id, respond)
      this.emit('event', { type: 'user_input.requested', request })
      return
    }

    const kind = APPROVAL_KIND.get(method)
    if (!kind) {
      this.emit('log', `declined unhandled server request: ${method}`)
      respond({ decision: 'decline' })
      return
    }

    const approval: ParsedApprovalRequest =
      kind === 'permissions'
        ? { kind, params: PermissionsRequestApprovalParamsSchema.parse(params) }
        : { kind, params: ApprovalParamsSchema.parse(params) }
    const request = mapApprovalRequest(approval)
    const permission = approval.kind === 'permissions' ? approval.params : undefined
    const id = request.id
    // An id collision (a retried command reusing its itemId) would silently
    // drop the earlier responder and leave Codex blocked on it forever.
    const previous = this.#approvals.get(id)
    if (previous) {
      previous.respond(mapApprovalResponse(previous.kind, 'deny', previous.permissions))
      this.emit('event', { type: 'approval.resolved', id })
    }
    this.#approvals.set(id, {
      kind,
      respond,
      ...(permission
        ? {
            permissions: permission.permissions,
            threadId: permission.threadId,
          }
        : {}),
      ...(permission ? { turnId: permission.turnId } : {}),
    })

    this.emit('event', { type: 'approval.requested', request })
  }

  #onNotification(method: string, params: JsonRpcValue | undefined): void {
    if (isIgnorableCodexNotification(method)) return

    const emit = (event: DomainEvent) => this.emit('event', event)

    switch (method) {
      case 'skills/changed':
        this.emit('skillsChanged')
        return

      case 'thread/started': {
        const p = ThreadStartedNotificationSchema.parse(params)
        emit({
          type: 'thread.started',
          thread: {
            id: p.thread.id,
            provider: 'codex',
            workspacePath: String(p.thread.cwd ?? ''),
            createdAt: Date.now(),
          },
        })
        return
      }

      case 'turn/started': {
        const p = TurnStartedNotificationSchema.parse(params)
        this.#activeTurns.set(p.threadId, p.turn.id)
        emit({
          type: 'turn.started',
          turn: {
            id: p.turn.id,
            threadId: p.threadId,
            status: 'running',
            createdAt: Date.now(),
          },
        })
        return
      }

      case 'turn/completed': {
        const p = TurnCompletedNotificationSchema.parse(params)
        if (this.#activeTurns.get(p.threadId) === p.turn.id) this.#activeTurns.delete(p.threadId)
        // A turn that ends with unanswered approvals must not leave the
        // thread pinned to 'approval' forever — the request is durably in
        // the event log, so without a resolved event even a restart keeps
        // the ghost card. Decline what nobody answered.
        for (const [id, pending] of this.#approvals) {
          this.#approvals.delete(id)
          pending.respond(mapApprovalResponse(pending.kind, 'deny', pending.permissions))
          emit({ type: 'approval.resolved', id })
        }
        for (const [id, respond] of this.#userInputs) {
          this.#userInputs.delete(id)
          respond({ answers: {} })
          emit({ type: 'user_input.resolved', id })
        }
        emit({
          type: 'turn.completed',
          turnId: p.turn.id,
          // `inProgress` should not reach us here, but map it rather than crash.
          status: p.turn.status === 'inProgress' ? 'completed' : p.turn.status,
        })
        return
      }

      case 'item/started': {
        const p = ItemStartedNotificationSchema.parse(params)
        const item = mapThreadItem(p.item, {
          turnId: p.turnId,
          status: 'started',
          createdAt: p.startedAtMs,
        })
        emit({
          type: 'item.started',
          item,
        })
        return
      }

      case 'item/completed': {
        const p = ItemCompletedNotificationSchema.parse(params)
        const item = mapThreadItem(p.item, {
          turnId: p.turnId,
          status: 'completed',
          createdAt: p.completedAtMs,
        })
        emit({
          type: 'item.completed',
          item,
        })
        return
      }

      case 'item/autoApprovalReview/started': {
        emit({
          type: 'approval.review.started',
          review: mapAutoApprovalReview(GuardianReviewStartedSchema.parse(params)),
        })
        return
      }

      case 'item/autoApprovalReview/completed': {
        emit({
          type: 'approval.review.completed',
          review: mapAutoApprovalReview(GuardianReviewCompletedSchema.parse(params)),
        })
        return
      }

      case 'item/agentMessage/delta': {
        const p = ItemDeltaNotificationSchema.parse(params)
        emit({ type: 'item.delta', turnId: p.turnId, itemId: p.itemId, textDelta: p.delta })
        return
      }

      // Reasoning streams as its own delta channel. Without this the thinking
      // row sits empty until the item completes, which reads as a hang.
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const p = ItemDeltaNotificationSchema.parse(params)
        emit({ type: 'item.delta', turnId: p.turnId, itemId: p.itemId, textDelta: p.delta })
        return
      }

      // Command output, live. A build that prints for a minute should show it
      // printing, not a spinner and then a wall of text.
      case 'item/commandExecution/outputDelta': {
        const p = CommandOutputDeltaNotificationSchema.parse(params)
        const text = p.delta ?? (p.deltaBase64 ? decodeBase64(p.deltaBase64) : '')
        if (text) emit({ type: 'item.delta', turnId: p.turnId, itemId: p.itemId, textDelta: text })
        return
      }

      case 'turn/plan/updated': {
        const p = TurnPlanUpdatedNotificationSchema.parse(params)
        emit({
          type: 'plan.updated',
          turnId: p.turnId,
          steps: p.plan.map((entry) => ({
            text: entry.step,
            status:
              entry.status === 'completed'
                ? 'done'
                : entry.status === 'inProgress'
                  ? 'running'
                  : 'pending',
          })),
        })
        return
      }

      case 'turn/diff/updated': {
        const p = TurnDiffUpdatedNotificationSchema.parse(params)
        emit({ type: 'diff.updated', turnId: p.turnId, diff: p.diff })
        return
      }

      case 'thread/tokenUsage/updated': {
        const p = ThreadTokenUsageUpdatedNotificationSchema.parse(params)
        emit({
          type: 'usage.updated',
          usage: mapCodexUsage(p, this.#threadModels.get(p.threadId)),
        })
        return
      }

      case 'account/login/completed': {
        const p = AccountLoginCompletedNotificationSchema.parse(params)
        this.emit('login', p)
        return
      }

      case 'account/rateLimits/updated':
        this.emit('usageChanged')
        return

      case 'warning':
        this.emit('log', formatCodexWarning(WarningNotificationSchema.parse(params)))
        return

      case 'error': {
        const p = ErrorNotificationSchema.parse(params)
        const event = mapCodexError(p)
        if (event) emit(event)
        else this.emit('log', `Codex retrying after error: ${p.error.message}`)
        return
      }

      case 'mcpServer/startupStatus/updated': {
        const p = McpServerStatusUpdatedNotificationSchema.parse(params)
        this.#mcpStartup.set(mcpStartupKey(p.threadId ?? undefined, p.name), mapMcpStartupStatus(p))
        const inventory = this.#mcpInventory.get(p.threadId ?? '')
        if (inventory) {
          this.#mcpInventory.set(
            p.threadId ?? '',
            inventory.map((server) =>
              server.id === p.name ? { ...server, startup: mapMcpStartupStatus(p) } : server,
            ),
          )
        }
        this.emit('mcpChanged', p.threadId ? { threadId: p.threadId } : {})
        return
      }

      case 'mcpServer/oauthLogin/completed': {
        const p = McpServerOauthLoginCompletedNotificationSchema.parse(params)
        // A completion without a threadId still ends someone's login — match
        // by server name across threads rather than leaving the browser flow
        // finished and the UI waiting forever.
        const key = p.threadId
          ? mcpLoginKey(p.threadId, p.name)
          : [...this.#mcpLogins.keys()].find((candidate) => candidate.endsWith(`\0${p.name}`))
        const loginId = key ? this.#mcpLogins.get(key) : undefined
        if (!key || !loginId) return
        this.#mcpLogins.delete(key)
        this.emit('mcpOAuth', {
          serverId: p.name,
          loginId,
          success: p.success,
          error: p.error ?? null,
        })
        return
      }

      default:
        // Codex emits far more than we consume (realtime audio, MCP progress,
        // etc.). Ignoring the rest is correct; logging it is how we
        // notice when something worth mapping appears.
        this.emit('log', `unmapped notification: ${method}`)
    }
  }
}

function mcpStartupKey(threadId: string | undefined, server: string): string {
  return `${threadId ?? ''}\0${server}`
}

function mcpLoginKey(threadId: string, server: string): string {
  return `${threadId}\0${server}`
}

/** Same USD-per-credit rate OpenAI's own surfaces use. */
const CREDIT_USD_RATE = 0.04

/** Pure mapping kept separate from the app-server transport for fixture tests. */
export function mapCodexRateLimits(response: CodexRateLimitResponse): ProviderLimit[] {
  const buckets = response.rateLimitsByLimitId
    ? Object.entries(response.rateLimitsByLimitId).filter(
        (pair): pair is [string, CodexRateLimitSnapshot] => Boolean(pair[1]),
      )
    : []
  if (response.rateLimits && !buckets.some(([limitId]) => limitId === 'codex')) {
    buckets.unshift(['codex', response.rateLimits])
  }
  // Ensure the main codex bucket always appears first.
  buckets.sort(([a], [b]) => (a === 'codex' ? -1 : b === 'codex' ? 1 : 0))
  const rows: ProviderLimit[] = []
  for (const [limitId, snapshot] of buckets) {
    // Secondary buckets (e.g. Spark) carry their own name; the main
    // bucket falls back to the plain window label.
    const prefix = limitId === 'codex' ? '' : `${snapshot.limitName ?? titleCaseLimitId(limitId)} `
    rows.push(
      ...[snapshot.primary, snapshot.secondary].flatMap((window, index) => {
        if (!window) return []
        const usedPercent = finitePercent(window.usedPercent)
        if (usedPercent === undefined) return []
        const resetsAt = resetTimestamp(window.resetsAt)
        return [
          {
            label:
              friendlyLimitLabel(limitId, snapshot.limitName, window.windowDurationMins) ??
              prefix +
                rateLimitLabel(window.windowDurationMins, index === 0 ? 'Primary' : 'Secondary'),
            usedPercent,
            ...(!(resetsAt === undefined) ? { resetsAt } : {}),
          },
        ]
      }),
    )
  }
  const credits = (response.rateLimitsByLimitId?.['codex'] ?? response.rateLimits)?.credits
  if (credits?.hasCredits) {
    if (credits.unlimited) {
      rows.push({
        label: 'Credits',
        usedPercent: 0,
        valueLabel: 'Unlimited',
      })
    } else if (credits.balance !== null) {
      const balance = Math.max(0, Math.floor(Number(credits.balance)))
      if (Number.isFinite(balance)) {
        rows.push({
          label: 'Credits',
          usedPercent: 0,
          valueLabel: `$${(balance * CREDIT_USD_RATE).toFixed(2)} · ${balance} credits`,
        })
      }
    }
  }
  const resets = response.rateLimitResetCredits
  const availableResets = Number(resets?.availableCount)
  if (Number.isFinite(availableResets) && availableResets > 0) {
    rows.push({
      label: 'Rate limit resets',
      usedPercent: 0,
      valueLabel: `${Math.floor(availableResets)} available`,
      action: 'consume-reset',
    })
  }
  return rows
}

function finitePercent(value: number): number | undefined {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined
}

function resetTimestamp(value: number | null): number | undefined {
  if (value === null || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function titleCaseLimitId(limitId: string): string {
  return limitId
    .split(/[_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Friendly names for the two weekly windows this account actually shows: the
 * main codex quota reads "Weekly", the Spark quota "Weekly Spark".
 * Every other bucket or window keeps the raw duration label.
 */
function friendlyLimitLabel(
  limitId: string,
  limitName: string | null,
  windowDurationMins: number | null,
): string | undefined {
  if (windowDurationMins !== 7 * 24 * 60) return undefined
  if (limitId === 'codex') return 'Weekly'
  if (limitId === 'spark' || limitName?.toLowerCase().includes('spark')) return 'Weekly Spark'
  return undefined
}

function rateLimitLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
    return `${fallback} limit`
  }
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `${minutes} minutes`
}
