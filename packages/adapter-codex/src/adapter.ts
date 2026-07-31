import { EventEmitter } from 'node:events'
import type {
  Account,
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  Capabilities,
  DomainEvent,
  Model,
  Thread,
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
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification'
import type { TurnStartedNotification } from './generated/v2/TurnStartedNotification'
import type { TurnStartResponse } from './generated/v2/TurnStartResponse'
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
  images: true,
}

export type StartOptions = {
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
const APPROVAL: Partial<Record<ApprovalMode, { approvalPolicy: string; sandbox: string }>> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  full: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
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
}

export class CodexAdapter extends EventEmitter<CodexAdapterEvents> {
  #rpc: StdioJsonRpc | undefined
  #voice = new CodexVoiceTranscriber(<T>(method: string, params: unknown) =>
    this.#call<T>(method, params),
  )
  #started = false
  /**
   * Approvals waiting on an answer, keyed by our id. Holds the JSON-RPC
   * responder because Codex is blocked on that specific request id.
   */
  #approvals = new Map<
    string,
    { kind: ApprovalRequest['kind']; respond: (result: unknown) => void }
  >()

  get capabilities(): Capabilities {
    return CODEX_CAPABILITIES
  }

  /** Spawn the app-server and complete the handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.#started) return

    const child = spawnCli('codex', ['app-server'])
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

  async startThread(workspacePath: string, options: StartOptions = {}): Promise<Thread> {
    const approval = options.approval ? APPROVAL[options.approval] : undefined
    if (options.approval && !approval) {
      throw new Error('Codex automatic approval review is not implemented')
    }
    const response = await this.#call<ThreadStartResponse>('thread/start', {
      cwd: workspacePath,
      ...(options.model ? { model: options.model } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      ...(options.effort ? { config: { model_reasoning_effort: options.effort } } : {}),
      ...(approval ?? {}),
    })
    return {
      id: response.thread.id,
      provider: 'codex',
      workspacePath,
      createdAt: Date.now(),
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

  /** Inject input without restarting the turn. Codex is one of the few engines that can. */
  async steer(threadId: string, text: string): Promise<void> {
    await this.#call('turn/steer', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
  }

  dispose(): void {
    this.#rpc?.dispose()
    this.#rpc = undefined
    this.#started = false
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
        emit({
          type: 'item.started',
          item: mapThreadItem(p.item, {
            turnId: p.turnId,
            status: 'started',
            createdAt: p.startedAtMs,
          }),
        })
        return
      }

      case 'item/completed': {
        const p = params as ItemCompletedNotification
        emit({
          type: 'item.completed',
          item: mapThreadItem(p.item, {
            turnId: p.turnId,
            status: 'completed',
            createdAt: p.completedAtMs,
          }),
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
        emit({
          type: 'usage.updated',
          usage: {
            inputTokens: total.inputTokens,
            cachedInputTokens: total.cachedInputTokens,
            outputTokens: total.outputTokens,
            reasoningTokens: total.reasoningOutputTokens,
            totalTokens: total.totalTokens,
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

      default:
        // Codex emits far more than we consume (realtime audio, MCP progress,
        // remote control). Ignoring the rest is correct; logging it is how we
        // notice when something worth mapping appears.
        this.emit('log', `unmapped notification: ${method}`)
    }
  }
}

function rateLimitLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return `${fallback} limit`
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `${minutes} minutes`
}
