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
  UserInputRequest,
} from '@harness/contracts'
import type { LoginAccountResponse } from './generated/v2/LoginAccountResponse'
import type { GetAccountRateLimitsResponse } from './generated/v2/GetAccountRateLimitsResponse'
import type { ModelListResponse } from './generated/v2/ModelListResponse'
import { mapThreadItem } from './map-item.js'
import { spawnCli, StdioJsonRpc } from '@harness/proc'
import type { AgentMessageDeltaNotification } from './generated/v2/AgentMessageDeltaNotification'
import type { ItemCompletedNotification } from './generated/v2/ItemCompletedNotification'
import type { ItemStartedNotification } from './generated/v2/ItemStartedNotification'
import type { ThreadStartedNotification } from './generated/v2/ThreadStartedNotification'
import type { ThreadTokenUsageUpdatedNotification } from './generated/v2/ThreadTokenUsageUpdatedNotification'
import type { TurnPlanUpdatedNotification } from './generated/v2/TurnPlanUpdatedNotification'
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse'
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse'
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification'
import type { TurnStartedNotification } from './generated/v2/TurnStartedNotification'
import type { TurnStartResponse } from './generated/v2/TurnStartResponse'
import type { ListMcpServerStatusResponse } from './generated/v2/ListMcpServerStatusResponse'
import type { McpServerStatusUpdatedNotification } from './generated/v2/McpServerStatusUpdatedNotification'
import type { McpServerOauthLoginResponse } from './generated/v2/McpServerOauthLoginResponse'
import type { McpServerOauthLoginCompletedNotification } from './generated/v2/McpServerOauthLoginCompletedNotification'
import type { GuardianApprovalReviewAction } from './generated/v2/GuardianApprovalReviewAction'
import type { GuardianApprovalReviewStatus } from './generated/v2/GuardianApprovalReviewStatus'
import type { ItemGuardianApprovalReviewCompletedNotification } from './generated/v2/ItemGuardianApprovalReviewCompletedNotification'
import type { ItemGuardianApprovalReviewStartedNotification } from './generated/v2/ItemGuardianApprovalReviewStartedNotification'
import type { JsonValue } from './generated/serde_json/JsonValue.js'
import {
  mapMcpServerStatus,
  mapMcpStartupStatus,
  mcpStartupInventory,
  prepareMcpConfig,
} from './mcp.js'
import type { SkillsListResponse } from './generated/v2/SkillsListResponse.js'
import type { SkillsConfigWriteResponse } from './generated/v2/SkillsConfigWriteResponse.js'
import type { ToolRequestUserInputParams } from './generated/v2/ToolRequestUserInputParams.js'
import { mapSkillList } from './skills.js'
import {
  CodexVoiceTranscriber,
  type VoiceCapability,
  type VoiceTranscriptionInput,
} from './voice.js'

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

const CLIENT_NAME = 'personal-harness'

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

export const CODEX_CAPABILITIES: Capabilities = {
  steer: true,
  fork: true,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  userInput: true,
  autoReview: true,
  images: true,
}

export type StartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  serviceTier?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
}

export type TurnOptions = Pick<StartOptions, 'model' | 'serviceTier' | 'effort'>

/**
 * Our three user-facing modes onto Codex's approval policy and sandbox.
 *
 * `full` is genuinely dangerous, which is why the UI never makes it the quiet
 * default and never remembers it silently across sessions.
 */
export const CODEX_APPROVAL: Record<
  ApprovalMode,
  { approvalPolicy: string; sandbox: string; approvalsReviewer?: 'auto_review' }
> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  'auto-review': {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    approvalsReviewer: 'auto_review',
  },
  full: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
}

const REVIEW_STATUS: Record<GuardianApprovalReviewStatus, ApprovalReview['status']> = {
  inProgress: 'in_progress',
  approved: 'approved',
  denied: 'denied',
  timedOut: 'timed_out',
  aborted: 'aborted',
}

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

function describeApprovalReviewAction(action: GuardianApprovalReviewAction): string {
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

export function mapAutoApprovalReview(
  params:
    ItemGuardianApprovalReviewStartedNotification | ItemGuardianApprovalReviewCompletedNotification,
): ApprovalReview {
  return {
    id: params.reviewId,
    turnId: params.turnId,
    status: REVIEW_STATUS[params.review.status],
    description: describeApprovalReviewAction(params.action),
    ...(params.review.rationale ? { rationale: params.review.rationale } : {}),
    ...(params.review.riskLevel ? { riskLevel: params.review.riskLevel } : {}),
    startedAt: params.startedAtMs,
    ...('completedAtMs' in params ? { completedAt: params.completedAtMs } : {}),
  }
}

/**
 * Codex's account union has variants we do not model (Bedrock, and whatever
 * comes next), so the fallback is a bare `type` we can still branch on.
 */
type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'other' }

/** The vendor's plan ids are not display strings. */
function planLabel(plan: string): string {
  const named: Record<string, string> = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
  }
  return named[plan] ?? 'Signed in'
}

/** Which server requests are approval prompts, and what they are about. */
const APPROVAL_KIND: Record<string, ApprovalRequest['kind'] | undefined> = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'file_change',
  'item/permissions/requestApproval': 'permissions',
  execCommandApproval: 'command',
  applyPatchApproval: 'file_change',
}

/**
 * Our four answers onto Codex's per-kind decision vocabulary.
 *
 * `abort` maps to cancel, which stops the turn rather than just this step —
 * "no, and stop" is a different intent from "not this one".
 */
const DECISION: Record<ApprovalRequest['kind'], Record<ApprovalDecision, string>> = {
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
}

export type CodexAdapterEvents = {
  event: [DomainEvent]
  log: [string]
  /** Emitted when the browser half of an OAuth flow finishes. */
  login: [{ loginId: string | null; success: boolean; error: string | null }]
  mcpOAuth: [{ serverId: string; loginId: string; success: boolean; error: string | null }]
  mcpChanged: [{ threadId?: string }]
  skillsChanged: []
}

export class CodexAdapter extends EventEmitter<CodexAdapterEvents> {
  #rpc: StdioJsonRpc | undefined
  #voice = new CodexVoiceTranscriber(<T>(method: string, params: unknown) =>
    this.#call<T>(method, params),
  )
  #started = false
  #mcpStartup = new Map<string, McpStartupStatus>()
  #mcpInventory = new Map<string, McpServer[]>()
  #mcpInventoryLoads = new Map<string, Promise<void>>()
  #threadModels = new Map<string, string>()
  #mcpServers: Record<string, JsonValue>
  #mcpEnvironment: NodeJS.ProcessEnv
  #mcpLogins = new Map<string, string>()
  /**
   * Approvals waiting on an answer, keyed by our id. Holds the JSON-RPC
   * responder because Codex is blocked on that specific request id.
   */
  #approvals = new Map<
    string,
    { kind: ApprovalRequest['kind']; respond: (result: unknown) => void }
  >()
  #userInputs = new Map<string, (result: unknown) => void>()

  constructor(
    options: {
      mcpServers?: McpServerConfig[]
      mcpCredentials?: Record<string, string>
    } = {},
  ) {
    super()
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
    const child = spawnCli('codex', ['app-server', '--enable', 'default_mode_request_user_input'], {
      env: this.#mcpEnvironment,
    })
    const rpc = new StdioJsonRpc(child)
    this.#rpc = rpc

    rpc.onStderr((text) => this.emit('log', text.trimEnd()))
    rpc.onNotification((method, params) => this.#onNotification(method, params))

    rpc.onServerRequest((method, params, respond) => this.#onServerRequest(method, params, respond))

    await rpc.request('initialize', {
      clientInfo: { name: CLIENT_NAME, title: 'Personal Harness', version: '0.0.0' },
    })
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
    try {
      // The response wraps the account rather than being one.
      const { account } = await this.#call<{ account: CodexAccount | null }>('account/read', {})
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
    } catch {
      return { signedIn: false }
    }
  }

  /** Subscription headroom as reported by Codex itself. */
  async rateLimits(): Promise<
    Array<{ label: string; usedPercent: number; resetsAt?: number | undefined }>
  > {
    try {
      const response = await this.#call<GetAccountRateLimitsResponse>('account/rateLimits/read', {})
      const snapshot = response.rateLimitsByLimitId?.['codex'] ?? response.rateLimits
      return [snapshot.primary, snapshot.secondary].flatMap((window, index) => {
        if (!window) return []
        const resetsAt =
          window.resetsAt === null
            ? undefined
            : window.resetsAt < 1_000_000_000_000
              ? window.resetsAt * 1000
              : window.resetsAt
        return [
          {
            label: rateLimitLabel(window.windowDurationMins, index === 0 ? 'Primary' : 'Secondary'),
            usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
            ...(resetsAt === undefined ? {} : { resetsAt }),
          },
        ]
      })
    } catch {
      return []
    }
  }

  /**
   * Starts the vendor's own OAuth flow. Returns the URL to open in a browser —
   * the user authenticates on OpenAI's site, not in our window, and we are
   * never in a position to see the credential.
   */
  async startLogin(): Promise<{ loginId: string; authUrl: string }> {
    const response = await this.#call<LoginAccountResponse>('account/login/start', {
      type: 'chatgpt',
    })
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

  voiceCapability(): Promise<VoiceCapability> {
    return this.#voice.capability()
  }

  transcribeVoice(input: VoiceTranscriptionInput, signal?: AbortSignal): Promise<string> {
    return this.#voice.transcribe(input, signal)
  }

  /**
   * The real catalogue, from the provider. We never ship a hardcoded model list
   * — vendors add models constantly and a stale dropdown is worse than none.
   */
  async listModels(): Promise<Model[]> {
    const response = await this.#call<ModelListResponse>('model/list', {})
    return response.data
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        isDefault: model.isDefault,
        reasoningEfforts: model.supportedReasoningEfforts.map((option) =>
          String(option.reasoningEffort),
        ),
        ...(model.defaultReasoningEffort
          ? { defaultReasoningEffort: String(model.defaultReasoningEffort) }
          : {}),
        serviceTiers: model.serviceTiers.map((tier) => ({
          id: String(tier.id),
          name: String(tier.name),
          description: String(tier.description),
        })),
        ...(model.defaultServiceTier
          ? { defaultServiceTier: String(model.defaultServiceTier) }
          : {}),
      }))
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
        .catch((error: unknown) => {
          this.emit(
            'log',
            `MCP inventory refresh failed: ${error instanceof Error ? error.message : String(error)}`,
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
      const response = await this.#call<ListMcpServerStatusResponse>('mcpServerStatus/list', {
        detail: 'full',
        ...(threadId ? { threadId } : {}),
        ...(cursor ? { cursor } : {}),
      })
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
    const response = await this.#call<SkillsListResponse>('skills/list', {
      cwds: [projectPath],
      forceReload: true,
    })
    return mapSkillList(response, projectPath)
  }

  async setSkillEnabled(skillId: string, enabled: boolean): Promise<boolean> {
    const response = await this.#call<SkillsConfigWriteResponse>('skills/config/write', {
      path: skillId,
      name: null,
      enabled,
    })
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
    const response = await this.#call<McpServerOauthLoginResponse>('mcpServer/oauth/login', {
      name: serverId,
      threadId,
    })
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
      ...(options.effort ? { model_reasoning_effort: options.effort } : {}),
      ...(Object.keys(this.#mcpServers).length ? { mcp_servers: this.#mcpServers } : {}),
    }
    const response = await this.#call<ThreadStartResponse>('thread/start', {
      cwd: workspacePath,
      ...(options.model ? { model: options.model } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      ...(options.instructions ? { developerInstructions: options.instructions } : {}),
      ...(Object.keys(config).length ? { config } : {}),
      ...(approval ?? {}),
    })
    this.#threadModels.set(response.thread.id, response.model)
    return {
      id: response.thread.id,
      provider: 'codex',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async resumeThread(
    threadId: string,
    workspacePath: string,
    options: Pick<StartOptions, 'instructions'> = {},
  ): Promise<Thread> {
    const response = await this.#call<ThreadResumeResponse>('thread/resume', {
      threadId,
      cwd: workspacePath,
      ...(options.instructions ? { developerInstructions: options.instructions } : {}),
      ...(Object.keys(this.#mcpServers).length
        ? { config: { mcp_servers: this.#mcpServers } }
        : {}),
    })
    this.#threadModels.set(response.thread.id, response.model)
    return {
      id: response.thread.id,
      provider: 'codex',
      workspacePath,
      // Codex reports seconds; guard against it ever switching to millis,
      // which the blind ×1000 would launch fifty millennia into the future.
      createdAt:
        response.thread.createdAt < 100_000_000_000
          ? response.thread.createdAt * 1_000
          : response.thread.createdAt,
    }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: TurnOptions = {},
  ): Promise<string> {
    const response = await this.#call<TurnStartResponse>('turn/start', {
      threadId,
      ...(options.model ? { model: options.model } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
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
    })
    if (options.model) this.#threadModels.set(threadId, options.model)
    return response.turn.id
  }

  async interrupt(threadId: string): Promise<void> {
    await this.#call('turn/interrupt', { threadId })
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
    pending.respond({ decision: DECISION[pending.kind][decision] })
    this.emit('event', { type: 'approval.resolved', id: approvalId })
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
    await this.#call('turn/steer', {
      threadId,
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

  dispose(): void {
    this.#rpc?.dispose()
    this.#rpc = undefined
    this.#started = false
    this.#mcpStartup.clear()
    this.#mcpInventory.clear()
    this.#mcpInventoryLoads.clear()
    this.#threadModels.clear()
    // Held responders close over the dead transport; answering one after
    // disposal would write into nothing. Drop them with the process.
    this.#approvals.clear()
    this.#userInputs.clear()
    this.#mcpLogins.clear()
  }

  #call<T>(method: string, params: unknown): Promise<T> {
    if (!this.#rpc) throw new Error('adapter not started')
    return this.#rpc.request<T>(method, params)
  }

  /**
   * Codex asks permission by making a request of us, not by sending an event.
   * Anything we do not recognise is declined — silently approving a request we
   * could not even parse is the worst possible default.
   */
  #onServerRequest(method: string, params: unknown, respond: (result: unknown) => void): void {
    if (method === 'item/tool/requestUserInput') {
      const request = mapUserInputRequest(params as ToolRequestUserInputParams)
      this.#userInputs.set(request.id, respond)
      this.emit('event', { type: 'user_input.requested', request })
      return
    }

    const kind = APPROVAL_KIND[method]
    if (!kind) {
      this.emit('log', `declined unhandled server request: ${method}`)
      respond({ decision: 'decline' })
      return
    }

    const p = params as {
      itemId?: string
      approvalId?: string | null
      reason?: string | null
      command?: string | null
      cwd?: string | null
      grantRoot?: string | null
    }
    const id = p.approvalId ?? p.itemId ?? crypto.randomUUID()
    // An id collision (a retried command reusing its itemId) would silently
    // drop the earlier responder and leave Codex blocked on it forever.
    const previous = this.#approvals.get(id)
    if (previous) {
      previous.respond({ decision: DECISION[previous.kind]['deny'] })
      this.emit('event', { type: 'approval.resolved', id })
    }
    this.#approvals.set(id, { kind, respond })

    this.emit('event', {
      type: 'approval.requested',
      request: {
        id,
        kind,
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.command ? { command: p.command } : {}),
        ...(p.cwd ? { cwd: String(p.cwd) } : {}),
        ...(p.grantRoot ? { path: String(p.grantRoot) } : {}),
        createdAt: Date.now(),
      },
    })
  }

  #onNotification(method: string, params: unknown): void {
    const emit = (event: DomainEvent) => this.emit('event', event)

    switch (method) {
      case 'skills/changed':
        this.emit('skillsChanged')
        return

      case 'thread/started': {
        const p = params as ThreadStartedNotification
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
        const p = params as TurnStartedNotification
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
        const p = params as TurnCompletedNotification
        // A turn that ends with unanswered approvals must not leave the
        // thread pinned to 'approval' forever — the request is durably in
        // the event log, so without a resolved event even a restart keeps
        // the ghost card. Decline what nobody answered.
        for (const [id, pending] of [...this.#approvals]) {
          this.#approvals.delete(id)
          pending.respond({ decision: DECISION[pending.kind]['deny'] })
          emit({ type: 'approval.resolved', id })
        }
        for (const [id, respond] of [...this.#userInputs]) {
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
        const p = params as ItemStartedNotification
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
        const p = params as ItemCompletedNotification
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
          review: mapAutoApprovalReview(params as ItemGuardianApprovalReviewStartedNotification),
        })
        return
      }

      case 'item/autoApprovalReview/completed': {
        emit({
          type: 'approval.review.completed',
          review: mapAutoApprovalReview(params as ItemGuardianApprovalReviewCompletedNotification),
        })
        return
      }

      case 'item/agentMessage/delta': {
        const p = params as AgentMessageDeltaNotification
        emit({ type: 'item.delta', turnId: p.turnId, itemId: p.itemId, textDelta: p.delta })
        return
      }

      // Reasoning streams as its own delta channel. Without this the thinking
      // row sits empty until the item completes, which reads as a hang.
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const p = params as { turnId: string; itemId: string; delta: string }
        emit({ type: 'item.delta', turnId: p.turnId, itemId: p.itemId, textDelta: p.delta })
        return
      }

      // Command output, live. A build that prints for a minute should show it
      // printing, not a spinner and then a wall of text.
      case 'item/commandExecution/outputDelta': {
        const p = params as { turnId: string; itemId: string; delta?: string; deltaBase64?: string }
        const text = p.delta ?? (p.deltaBase64 ? decodeBase64(p.deltaBase64) : '')
        if (text) emit({ type: 'item.delta', turnId: p.turnId, itemId: p.itemId, textDelta: text })
        return
      }

      case 'turn/plan/updated': {
        const p = params as TurnPlanUpdatedNotification
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
        const p = params as { turnId: string; diff: string }
        emit({ type: 'diff.updated', turnId: p.turnId, diff: p.diff })
        return
      }

      case 'thread/tokenUsage/updated': {
        const p = params as ThreadTokenUsageUpdatedNotification
        const total = p.tokenUsage.total
        const model = this.#threadModels.get(p.threadId)
        emit({
          type: 'usage.updated',
          usage: {
            ...(model ? { model } : {}),
            inputTokens: total.inputTokens,
            cachedInputTokens: total.cachedInputTokens,
            outputTokens: total.outputTokens,
            reasoningTokens: total.reasoningOutputTokens,
            totalTokens: total.totalTokens,
            cumulative: true,
            inputIncludesCached: true,
            ...(p.tokenUsage.modelContextWindow
              ? { contextWindow: p.tokenUsage.modelContextWindow }
              : {}),
          },
        })
        return
      }

      case 'account/login/completed': {
        const p = params as { loginId: string | null; success: boolean; error: string | null }
        this.emit('login', p)
        return
      }

      case 'mcpServer/startupStatus/updated': {
        const p = params as McpServerStatusUpdatedNotification
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
        const p = params as McpServerOauthLoginCompletedNotification
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
        // remote control). Ignoring the rest is correct; logging it is how we
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

function rateLimitLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return `${fallback} limit`
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `${minutes} minutes`
}
