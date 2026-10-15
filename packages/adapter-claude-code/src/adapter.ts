import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  CanUseTool,
  ModelInfo,
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  Capabilities,
  DomainEvent,
  Item,
  McpServerConfig,
  Model,
  ProviderContextSettings,
  Thread,
  UserInputQuestion,
} from '@harness/contracts'
import { JsonRpcValueSchema, killTree, spawnCli } from '@harness/proc'
import { z } from 'zod'
import { CLAUDE_CAPABILITIES } from './capabilities.js'
import { ClaudeMcpRedactor, prepareClaudeMcpServers } from './mcp.js'
import { activateClaudeMcpServers, createClaudeMcpBootstrap } from './mcp-bootstrap.js'
import {
  ClaudeEventSchema,
  toDomainEvents,
  toolUseItemFields,
  toUsage,
  type ClaudeEvent,
} from './events.js'
import {
  claudeSdkSpawner,
  createClaudeQuery,
  waitForAbort,
  type ClaudeQueryFactory,
  type ClaudeQueryRuntime,
  type ClaudeSpawn,
} from './sdk-runtime.js'

export { CLAUDE_CAPABILITIES } from './capabilities.js'

/**
 * Claude Code is hosted through Anthropic's Agent SDK. The SDK keeps one
 * streaming session alive, owns the control protocol, and calls TasteCode back
 * for permissions and structured questions. Claude's own executable still
 * owns authentication; TasteCode never reads a credential file.
 */

const SUPPORTED = '2.1'
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
/**
 * Captured from claude 2.1.296, which advertises `msg_lifecycle_v1` on system/init. The SDK's
 * message union does not declare it: each uuid-stamped prompt is reported queued, started and
 * then completed or cancelled, and a `result` can arrive before the terminal state.
 */
const CommandLifecycleSchema = z.object({
  type: z.literal('command_lifecycle'),
  command_uuid: z.string(),
  state: z.string(),
})
const ToolLocationSchema = z.object({ cwd: z.string().optional() })
const ToolInputSchema = z.record(z.string(), JsonRpcValueSchema)
const ClaudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
/** Only the `applied` block is read; the rest of the answer carries the user's own settings. */
const ClaudeAppliedSettingsSchema = z.object({
  applied: z
    .object({
      ultracode: z.boolean().optional(),
      ultracodeAvailable: z.boolean().optional(),
    })
    .optional(),
})
const TodoInputSchema = z.object({
  todos: z.array(
    z.object({
      content: z.coerce.string(),
      status: z.coerce.string().optional(),
    }),
  ),
})
const UserInputSchema = z.object({
  questions: z.array(
    z.object({
      question: z.coerce.string(),
      header: z.coerce.string().optional(),
      multiSelect: z.boolean().optional(),
      options: z
        .array(
          z.object({
            label: z.coerce.string(),
            description: z.coerce.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
})

type ToolInput = z.infer<typeof ToolInputSchema>

/**
 * Claude Code's versioned catalog. The SDK model control intentionally returns
 * the short interactive-picker list, including a synthetic `default` row, so
 * live discovery is merged with this catalog instead of replacing it.
 *
 * The current lineup comes first in tier order (Fable, Opus, Sonnet, Haiku).
 * Older generations follow, newest generation first and in tier order within
 * one generation.
 */
const FULL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CURRENT_CLAUDE_MODELS: Model[] = [
  claudeModel('claude-fable-5-1', 'Fable 5.1', 'Long-horizon reasoning and coding', FULL_EFFORTS),
  claudeModel('claude-opus-5-5', 'Opus 5.5', 'Deep reasoning', FULL_EFFORTS, true),
  claudeModel('claude-sonnet-5-5', 'Sonnet 5.5', 'Balanced speed and capability', FULL_EFFORTS),
  claudeModel('claude-haiku-5-5', 'Haiku 5.5', 'Fastest and cheapest', FULL_EFFORTS),
]
const OLDER_CLAUDE_MODELS: Model[] = [
  claudeModel('claude-fable-5', 'Fable 5', 'Previous Fable generation', FULL_EFFORTS),
  claudeModel('claude-opus-5', 'Opus 5', 'Previous Opus generation', FULL_EFFORTS),
  claudeModel('claude-sonnet-5', 'Sonnet 5', 'Previous Sonnet generation', FULL_EFFORTS),
  claudeModel('claude-opus-4-8', 'Opus 4.8', 'Older Opus generation', FULL_EFFORTS),
  claudeModel('claude-opus-4-7', 'Opus 4.7', 'Older Opus generation', FULL_EFFORTS, false, 'xhigh'),
  claudeModel('claude-opus-4-6', 'Opus 4.6', 'Older Opus generation', [
    'low',
    'medium',
    'high',
    'max',
  ]),
  claudeModel('claude-opus-4-5', 'Opus 4.5', 'Older Opus generation', [
    'low',
    'medium',
    'high',
    'max',
  ]),
  claudeModel('claude-sonnet-4-6', 'Sonnet 4.6', 'Older Sonnet generation', [
    'low',
    'medium',
    'high',
    'max',
  ]),
  claudeModel('claude-haiku-4-5', 'Haiku 4.5', 'Previous Haiku generation', []),
]
export const CLAUDE_MODELS: Model[] = [...CURRENT_CLAUDE_MODELS, ...OLDER_CLAUDE_MODELS]

function claudeModel(
  id: string,
  displayName: string,
  description: string,
  reasoningEfforts: string[],
  isDefault = false,
  defaultReasoningEffort = 'high',
): Model {
  return {
    id,
    displayName,
    description,
    isDefault,
    reasoningEfforts,
    serviceTiers: [],
    ...(reasoningEfforts.length > 0 ? { defaultReasoningEffort } : {}),
  }
}

/**
 * Ultracode is the top level of Claude's effort control, but it is not an API
 * effort. claude 2.1.296 reads it as the session-scoped `ultracode` flag setting:
 * xhigh effort plus standing dynamic-workflow orchestration. That is what its
 * own `--effort ultracode` alias resolves to, so this sends the same pair.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode'

export function claudeEffortOptions(
  effort: string | undefined,
): Pick<ClaudeQueryOptions, 'effort' | 'settings'> {
  if (effort === undefined) return {}
  const level = ClaudeEffortSchema.parse(effort)
  return level === CLAUDE_ULTRACODE_EFFORT
    ? { effort: 'xhigh', settings: { ultracode: true } }
    : { effort: level }
}

/**
 * Claude Code offers Ultracode only while dynamic workflows are enabled and the
 * model supports xhigh effort. Discovery learns the first half from the
 * runtime's `applied.ultracodeAvailable`; each model's effort list gives the second.
 */
function withUltracode(model: Model, ultracodeAvailable: boolean): Model {
  if (!ultracodeAvailable || !model.reasoningEfforts.includes('xhigh')) return model
  if (model.reasoningEfforts.includes(CLAUDE_ULTRACODE_EFFORT)) return model
  return { ...model, reasoningEfforts: [...model.reasoningEfforts, CLAUDE_ULTRACODE_EFFORT] }
}

async function readClaudeAppliedSettings(
  query: ClaudeQueryRuntime,
): Promise<z.infer<typeof ClaudeAppliedSettingsSchema>['applied']> {
  if (typeof query.getSettings !== 'function') return undefined
  const parsed = ClaudeAppliedSettingsSchema.safeParse(await query.getSettings())
  return parsed.success ? parsed.data.applied : undefined
}

const PERMISSION_MODE = {
  ask: 'default',
  auto: 'acceptEdits',
  'auto-review': 'auto',
  full: 'bypassPermissions',
} satisfies Record<ApprovalMode, PermissionMode>

export type ClaudeAdapterEvents = {
  event: [DomainEvent]
  log: [string]
  usageChanged: []
  disconnected: []
}

export type ClaudeStartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
  ephemeral?: boolean | undefined
  mcpServers?: McpServerConfig[] | undefined
  mcpCredentials?: Record<string, string> | undefined
  context?: ProviderContextSettings | undefined
}

/**
 * Claude Code reads both settings from its environment: the window as a token
 * budget it clamps to the model's own, the compaction point as a percent that
 * can only bring compaction earlier. `DISABLE_AUTO_COMPACT` keeps a manual
 * /compact working, unlike `DISABLE_COMPACT`.
 */
export function claudeContextEnvironment(context: ProviderContextSettings | undefined) {
  if (!context) return {}
  return {
    ...(context.window !== undefined
      ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(context.window) }
      : {}),
    ...(context.compactAt === 'off'
      ? { DISABLE_AUTO_COMPACT: '1' }
      : context.compactAt !== undefined
        ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(context.compactAt) }
        : {}),
  }
}

export type ClaudeTurnOptions = Pick<ClaudeStartOptions, 'model' | 'effort'>

function applyClaudeTurnOptions(
  current: ClaudeStartOptions,
  next: ClaudeTurnOptions,
): ClaudeStartOptions {
  if (Object.keys(next).length === 0) return current
  const merged = { ...current }
  for (const field of ['model', 'effort'] as const) {
    if (!(field in next)) continue
    const value = next[field]
    if (value === undefined) delete merged[field]
    else merged[field] = value
  }
  return merged
}

/** claude 2.1.296 fails `--resume` of an id it has no transcript for with this result. */
function isMissingClaudeConversation(error: unknown): boolean {
  return /No conversation found with session ID/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

type ImageMediaType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'

const IMAGE_MIME_TYPES = new Map<string, ImageMediaType>([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

/** Build one SDK user message; prompts and file contents never travel on argv. */
export function claudeUserMessage(
  text: string,
  attachments: string[] = [],
  sessionId?: string,
): SDKUserMessage {
  const files = attachments.filter(
    (file) => !IMAGE_MIME_TYPES.has(path.extname(file).toLowerCase()),
  )
  const prompt = files.length
    ? `${text}\n\nAttached file paths:\n${files.map((file) => `- ${JSON.stringify(file)}`).join('\n')}`
    : text

  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...attachments.flatMap((file) => {
          const mediaType = IMAGE_MIME_TYPES.get(path.extname(file).toLowerCase())
          return mediaType
            ? [
                {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: mediaType,
                    data: readFileSync(file).toString('base64'),
                  },
                },
              ]
            : []
        }),
      ],
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    ...(sessionId ? { session_id: sessionId } : {}),
  }
}

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  readonly #values: SDKUserMessage[] = []
  readonly #waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
  #closed = false

  push(value: SDKUserMessage): void {
    if (this.#closed) throw new Error('Claude Agent SDK prompt stream is closed')
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value) return Promise.resolve({ value, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

type PendingApproval = {
  finish(result: PermissionResult): void
  input: ToolInput
  suggestions: NonNullable<Parameters<CanUseTool>[2]['suggestions']>
  toolUseId: string
}

type PendingUserInput = {
  finish(result: PermissionResult): void
  input: ToolInput
  toolUseId: string
}

type StreamBlock = {
  id: string
  turnId: string
  type: 'message' | 'reasoning'
  text: string
  createdAt: number
}

export class ClaudeCodeAdapter extends EventEmitter<ClaudeAdapterEvents> {
  readonly #createQuery: ClaudeQueryFactory
  readonly #spawn: ClaudeSpawn
  readonly #environment: NodeJS.ProcessEnv
  readonly #startupTimeoutMs: number
  #workspacePath = ''
  #threadId = ''
  #options: ClaudeStartOptions = {}
  #reportedModel: string | undefined
  #sessionId: string | undefined
  #resumeOnRestart = false
  #query: ClaudeQueryRuntime | undefined
  #queryAbort: AbortController | undefined
  #bootstrapReady: ReturnType<typeof createClaudeMcpBootstrap> | undefined
  #redactor = new ClaudeMcpRedactor()
  #promptQueue: PromptQueue | undefined
  #queryGeneration = 0
  #sessionGeneration = 0
  #configuration: Promise<void> = Promise.resolve()
  #starting: Promise<void> | undefined
  readonly #processes = new Set<ReturnType<ClaudeSpawn>>()
  #activeTurnId: string | undefined
  #interruptRequested = false
  /**
   * Steers sent during the current turn, by uuid, and whether the CLI reported that their run
   * started, so a stop receipt or a result can tell which of them still run.
   */
  readonly #turnSteers = new Map<string, boolean>()
  /** The CLI reports each prompt's lifecycle (`msg_lifecycle_v1`). */
  #messageLifecycle = false
  /** A run ended while a steer of the turn waited to start; the status that run ended with. */
  #heldTurnStatus: 'completed' | 'failed' | 'interrupted' | undefined
  /** A stop left steers queued: the SDK runs them next, still inside the turn they steered. */
  #steersOutliveRun = false
  /** Settles once a stop receipt is read; the stopped run's result may overtake it. */
  #stopReceipt: Promise<void> | undefined
  /** The SDK's `total_cost_usd` is a running total for the current query. */
  #queryCostUsd = 0
  #disposed = false
  readonly #pendingApprovals = new Map<string, PendingApproval>()
  readonly #pendingUserInputs = new Map<string, PendingUserInput>()
  #streamMessageId: string | undefined
  readonly #streamBlocks = new Map<number, StreamBlock>()
  readonly #streamItems = new Map<string, Item>()
  /** Tool calls awaiting their result, by tool_use id, so the result lands on the call. */
  readonly #toolCalls = new Map<string, Item>()
  readonly #streamedMessageIds = new Set<string>()

  constructor(
    options: {
      createQuery?: ClaudeQueryFactory
      spawn?: ClaudeSpawn
      environment?: NodeJS.ProcessEnv
      startupTimeoutMs?: number
    } = {},
  ) {
    super()
    this.#createQuery = options.createQuery ?? createClaudeQuery
    this.#spawn = options.spawn ?? spawnCli
    this.#environment = options.environment ?? process.env
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 15_000
    if (!Number.isFinite(this.#startupTimeoutMs) || this.#startupTimeoutMs <= 0)
      throw new Error('Claude startup timeout must be a positive number')
  }

  get capabilities(): Capabilities {
    return CLAUDE_CAPABILITIES
  }

  onDisconnected(listener: () => void): () => void {
    this.on('disconnected', listener)
    return () => this.off('disconnected', listener)
  }

  async startThread(workspacePath: string, options: ClaudeStartOptions = {}): Promise<Thread> {
    const sessionId = crypto.randomUUID()
    const threadId = `claude-${sessionId}`
    await this.#openSession(threadId, sessionId, workspacePath, options, false)
    return {
      id: threadId,
      provider: 'claude-code',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async resumeThread(
    threadId: string,
    workspacePath: string,
    options: ClaudeStartOptions = {},
  ): Promise<Thread> {
    const sessionId = threadId.startsWith('claude-') ? threadId.slice('claude-'.length) : threadId
    await this.#openSession(threadId, sessionId, workspacePath, options, true)
    return {
      id: threadId,
      provider: 'claude-code',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: ClaudeTurnOptions = {},
  ): Promise<string> {
    return this.#configure(async () => this.#sendTurn(threadId, text, attachments, options))
  }

  async #sendTurn(
    threadId: string,
    text: string,
    attachments: string[],
    options: ClaudeTurnOptions,
  ): Promise<string> {
    this.#assertThread(threadId)
    if (this.#activeTurnId) throw new Error('Claude already has a running turn')

    const previous = this.#options
    const next = applyClaudeTurnOptions(previous, options)
    if (previous.effort !== next.effort) {
      await this.#restartSession(next)
    } else if (previous.model !== next.model) {
      const query = this.#requireQuery()
      await query.setModel(next.model)
      if (query !== this.#query) throw new Error('Claude session changed during model selection')
    }
    this.#assertThread(threadId)
    this.#options = next

    this.#requirePromptQueue().push(claudeUserMessage(text, attachments, this.#sessionId))
    return this.#startTurn()
  }

  #startTurn(): string {
    const turnId = `${this.#threadId}-turn-${crypto.randomUUID()}`
    this.#activeTurnId = turnId
    this.#interruptRequested = false
    this.#turnSteers.clear()
    this.#steersOutliveRun = false
    this.#heldTurnStatus = undefined
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId: this.#threadId, status: 'running', createdAt: Date.now() },
    })
    return turnId
  }

  async steer(threadId: string, text: string, attachments: string[] = []): Promise<void> {
    this.#assertThread(threadId)
    if (!this.#activeTurnId) throw new Error('there is no running Claude turn to steer')
    const message = claudeUserMessage(text, attachments, this.#sessionId)
    this.#requirePromptQueue().push({ ...message, priority: 'now' })
    this.#turnSteers.set(message.uuid!, false)
  }

  async interrupt(): Promise<void> {
    const turnId = this.#activeTurnId
    if (!turnId || !this.#query) return
    const query = this.#query
    const redactor = this.#redactor
    this.#interruptRequested = true
    // The SDK keeps queued async messages through an interrupt and lists them in its receipt.
    const stopping = query.interrupt().then((receipt) => {
      if (
        this.#query === query &&
        this.#activeTurnId === turnId &&
        receipt?.still_queued.some((uuid) => this.#turnSteers.has(uuid))
      )
        this.#steersOutliveRun = true
    })
    const receipt =
      this.#turnSteers.size > 0
        ? stopping.then(
            () => undefined,
            () => undefined,
          )
        : undefined
    if (receipt) this.#stopReceipt = receipt
    try {
      await stopping
    } catch (error) {
      // The turn keeps running, so a later error result is real and must still surface.
      if (this.#query === query) this.#interruptRequested = false
      throw new Error(redactor.redact(error instanceof Error ? error.message : String(error)))
    } finally {
      if (receipt && this.#stopReceipt === receipt) this.#stopReceipt = undefined
    }
  }

  async setApproval(approval: ApprovalMode): Promise<void> {
    return this.#configure(async () => {
      this.#assertThread(this.#threadId)
      const query = this.#requireQuery()
      await query.setPermissionMode(PERMISSION_MODE[approval])
      if (query !== this.#query)
        throw new Error('Claude session changed during permission selection')
      this.#assertThread(this.#threadId)
      this.#options = { ...this.#options, approval }
    })
  }

  #configure<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.#sessionGeneration
    const redactor = this.#redactor
    const result = this.#configuration
      .then(async () => {
        if (generation !== this.#sessionGeneration) throw new Error('Claude session is closed')
        await this.#starting
        if (generation !== this.#sessionGeneration) throw new Error('Claude session is closed')
        return operation()
      })
      .catch((error: unknown) => {
        throw new Error(redactor.redact(error instanceof Error ? error.message : String(error)))
      })
    // A rejected transition must not prevent a retry or a later control call.
    this.#configuration = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.#pendingApprovals.get(approvalId)
    if (!pending) return
    const common = {
      toolUseID: pending.toolUseId,
      decisionClassification:
        decision === 'approve-session'
          ? ('user_permanent' as const)
          : decision === 'approve'
            ? ('user_temporary' as const)
            : ('user_reject' as const),
    }
    if (decision === 'approve' || decision === 'approve-session') {
      pending.finish({
        behavior: 'allow',
        updatedInput: pending.input,
        ...(decision === 'approve-session' && pending.suggestions.length > 0
          ? {
              updatedPermissions: pending.suggestions,
            }
          : {}),
        ...common,
      })
      return
    }
    pending.finish({
      behavior: 'deny',
      message:
        decision === 'abort' ? 'User cancelled tool execution.' : 'User declined tool execution.',
      ...(decision === 'abort' ? { interrupt: true } : {}),
      ...common,
    })
    if (decision === 'abort') {
      void this.interrupt().catch((error: unknown) => {
        this.#log(
          `Could not stop Claude: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
  }

  respondToUserInput(requestId: string, answers: Record<string, string[]>): void {
    const pending = this.#pendingUserInputs.get(requestId)
    if (!pending) return
    const sdkAnswers = Object.fromEntries(
      Object.entries(answers).map(([question, values]) => [question, values.join(', ')]),
    )
    pending.finish({
      behavior: 'allow',
      updatedInput: { ...pending.input, answers: sdkAnswers },
      toolUseID: pending.toolUseId,
      decisionClassification: 'user_temporary',
    })
  }

  /** Ask the installed Claude runtime for its live model inventory without sending a prompt. */
  async listModels(): Promise<Model[]> {
    const abort = new AbortController()
    const query = this.#createQuery({
      prompt: waitForAbort(abort.signal),
      options: this.#queryOptions({
        cwd: process.cwd(),
        abortController: abort,
        persistSession: false,
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
      }),
    })
    try {
      const models = await withTimeout(
        query.supportedModels(),
        30_000,
        'Claude model discovery timed out',
      )
      if (models.length === 0) return CLAUDE_MODELS
      const ultracodeAvailable = await withTimeout(
        readClaudeAppliedSettings(query),
        10_000,
        'Claude settings discovery timed out',
      ).then(
        (applied) => applied?.ultracodeAvailable === true,
        (error: unknown) => {
          this.#log(`Claude Ultracode discovery failed; not offering it: ${String(error)}`)
          return false
        },
      )
      return mergeClaudeModels(models).map((model) => withUltracode(model, ultracodeAvailable))
    } catch (error) {
      this.#log(`Claude model discovery fell back to known values: ${String(error)}`)
      return CLAUDE_MODELS
    } finally {
      abort.abort()
      query.close()
    }
  }

  dispose(): Promise<void> {
    const cleanup = () =>
      Promise.all([
        ...[...this.#processes].map((child) => killTree(child)),
        this.#bootstrapReady?.then(
          (bootstrap) => bootstrap.close(),
          () => undefined,
        ),
      ]).then(() => undefined)
    if (this.#disposed) return cleanup()
    this.#disposed = true
    this.#sessionGeneration += 1
    this.#queryGeneration += 1
    this.#settlePending('Claude session closed.')
    this.#queryAbort?.abort()
    this.#promptQueue?.close()
    let closeError: Error | undefined
    try {
      this.#query?.close()
    } catch (error) {
      closeError = new Error(
        this.#redactor.redact(error instanceof Error ? error.message : String(error)),
      )
    }
    this.#queryAbort = undefined
    this.#promptQueue = undefined
    this.#query = undefined
    this.#completeStreamingItems('failed')
    this.#activeTurnId = undefined
    this.#clearStreamingState()
    this.#options = {}
    this.#redactor = new ClaudeMcpRedactor()
    this.removeAllListeners()
    return cleanup().then(() => {
      if (closeError) throw closeError
    })
  }

  async #openSession(
    threadId: string,
    sessionId: string,
    workspacePath: string,
    options: ClaudeStartOptions,
    resume: boolean,
  ): Promise<void> {
    if (this.#query || this.#promptQueue || this.#starting)
      throw new Error('Claude adapter already has a session')
    this.#disposed = false
    this.#sessionGeneration += 1
    this.#threadId = threadId
    this.#sessionId = sessionId
    this.#resumeOnRestart = resume
    this.#workspacePath = workspacePath
    this.#options = options
    this.#reportedModel = options.model
    const starting = this.#startQuery(resume ? sessionId : undefined)
      .catch(async (error: unknown) => {
        if (!resume || this.#disposed || !isMissingClaudeConversation(error)) throw error
        // A session whose first prompt never reached the CLI has no transcript,
        // so --resume can never succeed. Create it under the same id instead.
        this.#log(`Claude session ${sessionId} has no transcript yet; creating it`)
        // A new generation keeps the failed query's late end from reporting a disconnect.
        this.#queryGeneration += 1
        this.#promptQueue?.close()
        this.#query?.close()
        this.#promptQueue = undefined
        this.#query = undefined
        this.#resumeOnRestart = false
        await this.#startQuery(undefined)
      })
      .catch(async (error: unknown) => {
        const message = this.#redactor.redact(
          error instanceof Error ? error.message : String(error),
        )
        await this.dispose()
        throw new Error(message)
      })
    this.#starting = starting
    try {
      await starting
    } finally {
      if (this.#starting === starting) this.#starting = undefined
    }
  }

  async #startQuery(resume?: string, options = this.#options): Promise<void> {
    const mcp = prepareClaudeMcpServers(options.mcpServers ?? [], options.mcpCredentials ?? {})
    const redactor = new ClaudeMcpRedactor(mcp.secrets)
    this.#redactor = redactor
    const promptQueue = new PromptQueue()
    const abort = new AbortController()
    this.#queryAbort = abort
    const effortOptions = claudeEffortOptions(options.effort)
    let bootstrap: Awaited<ReturnType<typeof createClaudeMcpBootstrap>> | undefined
    let bootstrapReady: ReturnType<typeof createClaudeMcpBootstrap> | undefined
    try {
      await withTimeout(
        (async () => {
          if (Object.keys(mcp.servers).length) {
            bootstrapReady = createClaudeMcpBootstrap(Object.keys(mcp.servers), abort.signal)
            this.#bootstrapReady = bootstrapReady
            bootstrap = await bootstrapReady
          }
          abort.signal.throwIfAborted()
          const query = this.#createQuery({
            prompt: promptQueue,
            options: this.#queryOptions(
              {
                cwd: this.#workspacePath,
                abortController: abort,
                env: { ...this.#environment, ...claudeContextEnvironment(options.context) },
                ...(bootstrap ? { mcpServers: bootstrap.servers } : {}),
                ...(options.model ? { model: options.model } : {}),
                ...effortOptions,
                systemPrompt: {
                  type: 'preset',
                  preset: 'claude_code',
                  ...(options.instructions
                    ? {
                        append: options.instructions,
                      }
                    : {}),
                },
                settingSources: ['user', 'project', 'local'],
                persistSession: !options.ephemeral,
                permissionMode: PERMISSION_MODE[options.approval ?? 'ask'],
                allowDangerouslySkipPermissions: true,
                includePartialMessages: true,
                canUseTool: this.#canUseTool,
                additionalDirectories: [this.#workspacePath],
                ...(resume ? { resume } : this.#sessionId ? { sessionId: this.#sessionId } : {}),
              },
              redactor,
            ),
          })
          const generation = ++this.#queryGeneration
          this.#promptQueue = promptQueue
          this.#query = query
          this.#queryCostUsd = 0
          void this.#consume(query, generation)
          await query.initializationResult()
          if (bootstrap)
            await activateClaudeMcpServers(query, bootstrap.servers, mcp.servers, abort.signal)
          if (this.#query !== query || abort.signal.aborted)
            throw new Error('Claude session is closed')
          if (options.effort === CLAUDE_ULTRACODE_EFFORT) this.#confirmUltracode(query)
        })(),
        this.#startupTimeoutMs,
        'Claude session startup timed out. Check Claude Code and the project MCP servers, then retry.',
        abort.signal,
      )
    } catch (error) {
      abort.abort()
      throw new Error(redactor.redact(error instanceof Error ? error.message : String(error)))
    } finally {
      try {
        await bootstrapReady?.then(
          (value) => value.close(),
          () => undefined,
        )
      } finally {
        if (this.#bootstrapReady === bootstrapReady) this.#bootstrapReady = undefined
      }
    }
  }

  #queryOptions(
    overrides: ClaudeQueryOptions,
    redactor = new ClaudeMcpRedactor(),
  ): ClaudeQueryOptions {
    const log = (chunk: string) => {
      const line = chunk.trimEnd()
      if (line) this.emit('log', line)
    }
    return {
      pathToClaudeCodeExecutable: 'claude',
      env: { ...this.#environment },
      spawnClaudeCodeProcess: claudeSdkSpawner(
        this.#spawn,
        (chunk) => log(redactor.push(chunk)),
        undefined,
        (child) => {
          this.#processes.add(child)
          child.once('exit', () => {
            void killTree(child).then(
              () => this.#processes.delete(child),
              () => undefined,
            )
          })
        },
        () => log(redactor.finish()),
      ),
      ...overrides,
    }
  }

  /** The runtime can still decline Ultracode, for example after dynamic workflows were turned off. */
  #confirmUltracode(query: ClaudeQueryRuntime): void {
    void readClaudeAppliedSettings(query).then(
      (applied) => {
        if (applied && applied.ultracode !== true) {
          this.#log('Claude Code did not turn Ultracode on for this session')
        }
      },
      () => undefined,
    )
  }

  async #restartSession(options: ClaudeStartOptions): Promise<void> {
    if (this.#activeTurnId) throw new Error('Claude effort cannot change during a running turn')
    const generation = ++this.#queryGeneration
    this.#queryAbort?.abort()
    this.#promptQueue?.close()
    this.#query?.close()
    this.#promptQueue = undefined
    this.#query = undefined
    this.#clearStreamingState()
    try {
      // An unused session has no transcript yet, so it must keep --session-id.
      await this.#startQuery(this.#resumeOnRestart ? this.#sessionId : undefined, options)
    } catch (error) {
      const message = this.#redactor.redact(error instanceof Error ? error.message : String(error))
      // dispose() drops every listener, so the owner must learn the session is gone first.
      // #consume already announced it when the failed query ended on its own.
      if (!this.#disposed && (this.#query || this.#queryGeneration === generation)) {
        this.#settlePending('Claude session disconnected.')
        this.emit('disconnected')
      }
      await this.dispose()
      throw new Error(message)
    }
  }

  #log(message: string): void {
    this.emit('log', this.#redactor.redact(message))
  }

  async #consume(query: ClaudeQueryRuntime, generation: number): Promise<void> {
    try {
      for await (const message of query) {
        if (generation !== this.#queryGeneration || this.#disposed) return
        if (message.type === 'result' && this.#stopReceipt) {
          await this.#stopReceipt
          if (generation !== this.#queryGeneration || this.#disposed) return
        }
        this.#onMessage(message)
      }
      if (generation === this.#queryGeneration && !this.#disposed && this.#activeTurnId) {
        this.#failActiveTurn('Claude Agent SDK session ended before the turn completed.')
      }
    } catch (error) {
      if (generation !== this.#queryGeneration || this.#disposed) return
      this.#failActiveTurn(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === this.#queryGeneration && this.#query === query) {
        this.#query = undefined
        this.#promptQueue?.close()
        this.#promptQueue = undefined
        this.#settlePending('Claude session disconnected.')
        if (!this.#disposed) this.emit('disconnected')
      }
    }
  }

  #onMessage(message: SDKMessage): void {
    const sessionId = 'session_id' in message ? message.session_id : undefined
    if (sessionId) this.#sessionId = sessionId

    if ((message as { type: string }).type === 'command_lifecycle') {
      this.#onCommandLifecycle(message)
      return
    }

    if (message.type === 'stream_event') {
      this.#onStreamEvent(message)
      return
    }

    if (message.type === 'assistant') {
      // Subagent (Task) snapshots belong to the sidechain. Saved history leaves them out, so
      // the live transcript must too, and they must not touch the main plan or model label.
      if (message.parent_tool_use_id) return
      if (message.error) this.#log(`Claude assistant error: ${message.error}`)
      const parsed = ClaudeEventSchema.safeParse(message)
      if (!parsed.success) {
        this.#log(`ignored malformed Claude assistant event: ${parsed.error.message}`)
        return
      }
      // Output that no turn waits for, such as a steer that outlived its turn, gets its own.
      const turnId = this.#activeTurnId ?? this.#startTurn()
      const event = parsed.data
      this.#reportedModel = event.message?.model
      const streamed = event.message?.id && this.#streamedMessageIds.has(event.message.id)
      const filtered: ClaudeEvent =
        streamed && event.message?.content
          ? {
              ...event,
              message: {
                ...event.message,
                content: event.message.content.filter(
                  (block) => block.type !== 'text' && block.type !== 'thinking',
                ),
              },
            }
          : event
      this.#emitDomainEvents(toDomainEvents(filtered, turnId, this.#toolCalls))
      this.#emitTodoPlan(event)
      return
    }

    if (message.type === 'user') {
      if (!this.#activeTurnId || message.parent_tool_use_id) return
      const parsed = ClaudeEventSchema.safeParse(message)
      if (!parsed.success) {
        this.#log(`ignored malformed Claude user event: ${parsed.error.message}`)
        return
      }
      this.#emitDomainEvents(toDomainEvents(parsed.data, this.#activeTurnId, this.#toolCalls))
      return
    }

    if (message.type === 'result') {
      const turnId = this.#activeTurnId
      if (!turnId) return
      this.#resumeOnRestart = true
      // Usage tokens are per turn, but the cost is the query's running total: report only
      // this turn's share so the store can sum turns. A drop means the SDK started over.
      const total = message.total_cost_usd
      const costUsd = total < this.#queryCostUsd ? total : total - this.#queryCostUsd
      this.#queryCostUsd = total
      const usage = toUsage(message.usage, costUsd)
      if (usage) {
        this.emit('event', {
          type: 'usage.updated',
          usage: {
            ...usage,
            ...(this.#reportedModel ? { model: this.#reportedModel } : {}),
          },
        })
      }
      if (message.is_error && 'errors' in message && message.errors.length > 0) {
        const errors = this.#redactor.redact(message.errors.join('\n'))
        // A stopped turn ends as an error result carrying "[ede_diagnostic]" lines; that is
        // the expected outcome of Stop, not something to show as an error.
        if (this.#interruptRequested) this.#log(`Claude stopped turn: ${errors}`)
        else this.emit('event', { type: 'thread.error', threadId: this.#threadId, message: errors })
      }
      const status = this.#interruptRequested
        ? 'interrupted'
        : message.is_error
          ? 'failed'
          : 'completed'
      this.#completeStreamingItems(status === 'completed' ? 'completed' : 'failed')
      // A steer cuts the run it steers short, and the CLI starts it as a run of its own, Stop
      // or not. Until every steer has started, a result ends only one run of the turn.
      const steerWaits =
        this.#messageLifecycle && [...this.#turnSteers.values()].some((started) => !started)
      // Only the stopped run ended. The steers it left queued run next, and their answer
      // and result belong to the turn they steered, not to whichever prompt comes after.
      if (steerWaits || this.#steersOutliveRun) {
        // Without lifecycle reports the next result is the steers' own.
        if (steerWaits) this.#heldTurnStatus = status
        else this.#turnSteers.clear()
        this.#steersOutliveRun = false
      } else {
        this.emit('event', {
          type: 'turn.completed',
          turnId,
          status,
        })
        this.#activeTurnId = undefined
      }
      this.#interruptRequested = false
      this.#settlePending('Claude turn ended before the request was answered.')
      this.#clearStreamingState()
      return
    }

    if (message.type === 'rate_limit_event') {
      if ((message.rate_limit_info.utilization ?? 0) > 0.9) {
        this.emit(
          'log',
          `rate limit at ${Math.round((message.rate_limit_info.utilization ?? 0) * 100)}%`,
        )
      }
      this.emit('usageChanged')
      return
    }

    if (message.type === 'auth_status' && message.error) {
      this.#log(`Claude authentication: ${message.error}`)
      return
    }

    if (message.type === 'system' && message.subtype === 'init') {
      this.#reportedModel = message.model
      this.#messageLifecycle = message.capabilities?.includes('msg_lifecycle_v1') ?? false
      if (message.claude_code_version && !message.claude_code_version.startsWith(SUPPORTED)) {
        this.emit(
          'log',
          `claude-code ${message.claude_code_version} is newer than the ${SUPPORTED}.x compatibility baseline`,
        )
      }
    }
  }

  #onCommandLifecycle(message: unknown): void {
    const parsed = CommandLifecycleSchema.safeParse(message)
    const turnId = this.#activeTurnId
    if (!parsed.success || !turnId || !this.#turnSteers.has(parsed.data.command_uuid)) return
    const { command_uuid: uuid, state } = parsed.data
    if (state === 'started') {
      this.#turnSteers.set(uuid, true)
      this.#heldTurnStatus = undefined
      return
    }
    if (state !== 'completed' && state !== 'cancelled') return
    this.#turnSteers.delete(uuid)
    // A held turn is between runs. A steer that ends without a run of its own, cancelled or
    // folded into a run that already reported, may leave it nothing more to wait for.
    const status = this.#heldTurnStatus
    if (!status || [...this.#turnSteers.values()].some((started) => !started)) return
    this.#heldTurnStatus = undefined
    this.emit('event', { type: 'turn.completed', turnId, status })
    this.#activeTurnId = undefined
  }

  #onStreamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>): void {
    if (message.parent_tool_use_id) return
    const event = message.event
    const type = event.type
    const turnId =
      this.#activeTurnId ??
      (type === 'message_start' || type === 'content_block_start' ? this.#startTurn() : undefined)
    if (!turnId) return
    if (type === 'message_start') {
      this.#streamMessageId = event.message.id
      return
    }

    if (type === 'content_block_start') {
      const index = event.index
      const raw = event.content_block
      if (raw.type === 'tool_use') {
        const parsedInput = ToolInputSchema.safeParse(raw.input)
        const input = parsedInput.success ? parsedInput.data : {}
        const id = `${raw.id}-call`
        const item: Item = {
          id,
          turnId,
          status: 'started',
          ...toolUseItemFields(raw.name, input),
          createdAt: Date.now(),
        }
        this.#streamItems.set(id, item)
        this.emit('event', { type: 'item.started', item })
        return
      }
      if (raw.type !== 'text' && raw.type !== 'thinking') return
      const messageId = this.#streamMessageId ?? message.uuid
      const text = raw.type === 'text' ? raw.text : raw.thinking
      const block: StreamBlock = {
        id: `${messageId}-${raw.type}-${index}`,
        turnId,
        type: raw.type === 'text' ? 'message' : 'reasoning',
        text,
        createdAt: Date.now(),
      }
      this.#streamBlocks.set(index, block)
      this.#streamedMessageIds.add(messageId)
      const item: Item = {
        id: block.id,
        turnId,
        type: block.type,
        status: 'started',
        ...(block.type === 'message' ? { role: 'assistant' as const } : {}),
        text: '',
        createdAt: block.createdAt,
      }
      this.#streamItems.set(item.id, item)
      this.emit('event', { type: 'item.started', item })
      if (text)
        this.emit('event', { type: 'item.delta', turnId, itemId: block.id, textDelta: text })
      return
    }

    if (type === 'content_block_delta') {
      const index = event.index
      const delta = event.delta
      const text =
        delta?.type === 'text_delta'
          ? delta.text
          : delta?.type === 'thinking_delta'
            ? delta.thinking
            : ''
      const block = this.#streamBlocks.get(index)
      if (!block || !text) return
      block.text += text
      this.emit('event', { type: 'item.delta', turnId, itemId: block.id, textDelta: text })
      return
    }

    if (type === 'content_block_stop') {
      const index = event.index
      const block = this.#streamBlocks.get(index)
      if (!block) return
      this.#streamBlocks.delete(index)
      this.#streamItems.delete(block.id)
      this.emit('event', {
        type: 'item.completed',
        item: {
          id: block.id,
          turnId: block.turnId,
          type: block.type,
          status: 'completed',
          ...(block.type === 'message' ? { role: 'assistant' as const } : {}),
          text: block.text,
          createdAt: block.createdAt,
        },
      })
    }
  }

  #emitTodoPlan(event: ClaudeEvent): void {
    const content = event.message?.content ?? []
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      if (block.name !== 'TodoWrite') continue
      const parsed = TodoInputSchema.safeParse(block.input)
      if (!parsed.success) continue
      const steps = parsed.data.todos.flatMap((todo) => {
        const text = todo.content.trim()
        if (!text) return []
        const rawStatus = todo.status ?? 'pending'
        return [
          {
            text,
            status:
              rawStatus === 'completed'
                ? ('done' as const)
                : rawStatus === 'in_progress'
                  ? ('running' as const)
                  : ('pending' as const),
          },
        ]
      })
      if (steps.length > 0 && this.#activeTurnId) {
        this.emit('event', { type: 'plan.updated', turnId: this.#activeTurnId, steps })
      }
    }
  }

  #emitDomainEvents(events: DomainEvent[]): void {
    for (const event of events) {
      if (event.type === 'item.completed') this.#streamItems.delete(event.item.id)
      if (event.type === 'usage.updated' && this.#reportedModel) {
        this.emit('event', { ...event, usage: { ...event.usage, model: this.#reportedModel } })
      } else {
        this.emit('event', event)
      }
    }
  }

  #canUseTool: CanUseTool = async (toolName, input, options) => {
    const parsedInput = ToolInputSchema.parse(input)
    if (toolName === 'AskUserQuestion') return this.#requestUserInput(parsedInput, options)
    if ((this.#options.approval ?? 'ask') === 'full') {
      return { behavior: 'allow', updatedInput: parsedInput, toolUseID: options.toolUseID }
    }
    if (!this.#activeTurnId) {
      return {
        behavior: 'deny',
        message: 'Claude turn is no longer active.',
        toolUseID: options.toolUseID,
      }
    }

    const id = crypto.randomUUID()
    const request = approvalRequest(id, toolName, parsedInput, options)
    return new Promise<PermissionResult>((resolve) => {
      let finished = false
      const finish = (result: PermissionResult) => {
        if (finished) return
        finished = true
        this.#pendingApprovals.delete(id)
        options.signal.removeEventListener('abort', onAbort)
        this.emit('event', { type: 'approval.resolved', id })
        resolve(result)
      }
      const onAbort = () =>
        finish({
          behavior: 'deny',
          message: 'Tool request was cancelled.',
          toolUseID: options.toolUseID,
          decisionClassification: 'user_reject',
        })
      this.#pendingApprovals.set(id, {
        finish,
        input: parsedInput,
        suggestions: options.suggestions ?? [],
        toolUseId: options.toolUseID,
      })
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.emit('event', { type: 'approval.requested', request })
    })
  }

  #requestUserInput(
    input: ToolInput,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (!this.#activeTurnId) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'Claude turn is no longer active.',
        toolUseID: options.toolUseID,
      })
    }
    const questions = parseUserInputQuestions(input)
    if (questions.length === 0) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'Claude asked an invalid empty question.',
        toolUseID: options.toolUseID,
      })
    }
    const id = crypto.randomUUID()
    return new Promise<PermissionResult>((resolve) => {
      let finished = false
      const finish = (result: PermissionResult) => {
        if (finished) return
        finished = true
        this.#pendingUserInputs.delete(id)
        options.signal.removeEventListener('abort', onAbort)
        this.emit('event', { type: 'user_input.resolved', id })
        resolve(result)
      }
      const onAbort = () =>
        finish({
          behavior: 'deny',
          message: 'User question was cancelled.',
          toolUseID: options.toolUseID,
          decisionClassification: 'user_reject',
        })
      this.#pendingUserInputs.set(id, { finish, input, toolUseId: options.toolUseID })
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.emit('event', {
        type: 'user_input.requested',
        request: {
          id,
          turnId: this.#activeTurnId!,
          questions,
          autoResolutionMs: null,
          createdAt: Date.now(),
        },
      })
    })
  }

  #settlePending(message: string): void {
    for (const pending of this.#pendingApprovals.values()) {
      pending.finish({
        behavior: 'deny',
        message,
        toolUseID: pending.toolUseId,
        decisionClassification: 'user_reject',
      })
    }
    for (const pending of this.#pendingUserInputs.values()) {
      pending.finish({
        behavior: 'deny',
        message,
        toolUseID: pending.toolUseId,
        decisionClassification: 'user_reject',
      })
    }
  }

  #failActiveTurn(message: string): void {
    message = this.#redactor.redact(message)
    const turnId = this.#activeTurnId
    if (!turnId) {
      this.emit('log', message)
      return
    }
    this.emit('event', { type: 'thread.error', threadId: this.#threadId, message })
    this.#completeStreamingItems('failed')
    this.emit('event', {
      type: 'turn.completed',
      turnId,
      status: this.#interruptRequested ? 'interrupted' : 'failed',
    })
    this.#activeTurnId = undefined
    this.#interruptRequested = false
    this.#settlePending(message)
    this.#clearStreamingState()
  }

  #clearStreamingState(): void {
    this.#streamMessageId = undefined
    this.#streamBlocks.clear()
    this.#streamItems.clear()
    this.#toolCalls.clear()
    this.#streamedMessageIds.clear()
  }

  #completeStreamingItems(status: 'completed' | 'failed'): void {
    for (const item of this.#streamItems.values()) {
      const { text: _streamedText, ...started } = item
      this.emit('event', { type: 'item.completed', item: { ...started, status } })
    }
    // A call whose result never came back ends with the turn, not as "running".
    for (const call of this.#toolCalls.values()) {
      this.emit('event', { type: 'item.completed', item: { ...call, status } })
    }
    this.#streamItems.clear()
    this.#toolCalls.clear()
    this.#streamBlocks.clear()
  }

  #assertThread(threadId: string): void {
    if (!this.#threadId || threadId !== this.#threadId) throw new Error('unknown Claude thread')
    if (this.#disposed) throw new Error('Claude session is closed')
  }

  #requireQuery(): ClaudeQueryRuntime {
    if (!this.#query) throw new Error('Claude Agent SDK session is not running')
    return this.#query
  }

  #requirePromptQueue(): PromptQueue {
    if (!this.#promptQueue) throw new Error('Claude Agent SDK prompt stream is not running')
    return this.#promptQueue
  }
}

function approvalRequest(
  id: string,
  toolName: string,
  input: ToolInput,
  options: Parameters<CanUseTool>[2],
): ApprovalRequest {
  const location = ToolLocationSchema.safeParse(input)
  const cwd = location.success ? location.data.cwd : undefined
  const kind = SHELL_TOOLS.has(toolName)
    ? ('command' as const)
    : EDIT_TOOLS.has(toolName)
      ? ('file_change' as const)
      : ('permissions' as const)
  const pathValue = options.blockedPath ?? input['file_path'] ?? input['path']
  const explanation = options.title ?? options.description ?? options.decisionReason
  const reason =
    kind === 'permissions'
      ? [toolName, explanation, JSON.stringify(input)].filter(Boolean).join('\n').slice(0, 2_000)
      : explanation
  return {
    id,
    kind,
    ...(reason ? { reason } : {}),
    ...(kind === 'command'
      ? {
          command: String(input['command'] ?? toolName),
        }
      : {}),
    ...(cwd ? { cwd } : {}),
    ...(pathValue ? { path: String(pathValue) } : {}),
    createdAt: Date.now(),
  }
}

function parseUserInputQuestions(input: ToolInput): UserInputQuestion[] {
  const parsed = UserInputSchema.safeParse(input)
  if (!parsed.success) return []
  return parsed.data.questions.flatMap((raw, index) => {
    const question = raw.question.trim()
    if (!question) return []
    const options = (raw.options ?? []).flatMap((option) => {
      const label = option.label.trim()
      if (!label) return []
      return [
        {
          label,
          description: option.description?.trim() || `Choose ${label}`,
        },
      ]
    })
    return [
      {
        // Claude Code uses the full question text as the answer-map key.
        id: question,
        header: raw.header?.trim() || `Question ${index + 1}`,
        question,
        allowOther: true,
        ...(raw.multiSelect ? { multiSelect: true } : {}),
        secret: false,
        options: options.length > 0 ? options : null,
      },
    ]
  })
}

type DiscoveredClaudeModel = {
  model: Model
  resolvedId: string
}

function mergeClaudeModels(models: ModelInfo[]): Model[] {
  const defaultEntry = models.find((model) => model.value === 'default')
  const defaultResolvedId = defaultEntry ? resolvedSdkModelId(defaultEntry) : undefined
  const discovered = models
    .filter((model) => model.value !== 'default')
    .map((model) => mapSdkModel(model))
    .filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => candidate.resolvedId === entry.resolvedId) === index,
    )

  if (
    defaultEntry &&
    defaultResolvedId &&
    !discovered.some((entry) => entry.resolvedId === defaultResolvedId)
  ) {
    discovered.unshift(mapSdkModel(defaultEntry, defaultResolvedId))
  }

  // One row per model: an alias such as `sonnet` and its `[1m]` variant both
  // resolve to the same family, and the standard-context row represents it.
  const used = new Set<DiscoveredClaudeModel>()
  const takeFamily = (family: string): DiscoveredClaudeModel | undefined => {
    const matches = discovered.filter(
      (entry) => !used.has(entry) && claudeModelFamily(entry.resolvedId) === family,
    )
    for (const entry of matches) used.add(entry)
    return matches.find((entry) => !entry.resolvedId.endsWith('[1m]')) ?? matches[0]
  }
  // A live row keeps its catalog row's default flag, so an answer without a
  // `default` row still selects the catalog default, not whichever row is first.
  const fromCatalog = (catalog: Model[]): Model[] =>
    catalog.map((catalogModel) => {
      const selected = takeFamily(claudeModelFamily(catalogModel.id))
      return selected ? { ...selected.model, isDefault: catalogModel.isDefault } : catalogModel
    })

  const current = fromCatalog(CURRENT_CLAUDE_MODELS)
  const older = fromCatalog(OLDER_CLAUDE_MODELS)
  const unknown: DiscoveredClaudeModel[] = []
  for (const entry of discovered) {
    if (used.has(entry)) continue
    const selected = takeFamily(claudeModelFamily(entry.resolvedId))
    if (selected) unknown.push(selected)
  }
  // A model the catalog does not list yet is most likely a new release, so it
  // follows the current lineup instead of sinking below older generations.
  unknown.sort((left, right) => compareClaudeReleases(left.resolvedId, right.resolvedId))
  const merged = [...current, ...unknown.map((entry) => entry.model), ...older]

  let defaultIndex = defaultResolvedId
    ? merged.findIndex(
        (model) =>
          model.id === defaultResolvedId ||
          discovered.some(
            (entry) => entry.model.id === model.id && entry.resolvedId === defaultResolvedId,
          ),
      )
    : -1
  if (defaultIndex < 0) defaultIndex = merged.findIndex((model) => model.isDefault)
  const selectedDefault = defaultIndex >= 0 ? defaultIndex : 0
  return merged.map((model, index) => ({ ...model, isDefault: index === selectedDefault }))
}

function mapSdkModel(model: ModelInfo, id = model.value): DiscoveredClaudeModel {
  const reasoningEfforts = model.supportedEffortLevels
    ? [...model.supportedEffortLevels]
    : model.supportsEffort
      ? [...FULL_EFFORTS]
      : []
  const resolvedId = resolvedSdkModelId(model)
  return {
    resolvedId,
    model: {
      id,
      displayName: versionedClaudeModelName(resolvedId) ?? model.displayName,
      description: model.description,
      isDefault: false,
      reasoningEfforts,
      ...(reasoningEfforts.length > 0 ? { defaultReasoningEffort: 'high' } : {}),
      serviceTiers: [],
    },
  }
}

function resolvedSdkModelId(model: ModelInfo): string {
  const resolved = model.resolvedModel?.trim() || model.value
  return model.value.endsWith('[1m]') && !resolved.endsWith('[1m]') ? `${resolved}[1m]` : resolved
}

function claudeModelFamily(id: string): string {
  return id.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')
}

const CLAUDE_VERSIONED_ID = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/
const CLAUDE_TIERS = ['fable', 'opus', 'sonnet', 'haiku']

/**
 * Newest version first, then Fable, Opus, Sonnet and Haiku within one version.
 * Ids without a recognizable version keep their order after the versioned ones.
 */
function compareClaudeReleases(leftId: string, rightId: string): number {
  const left = claudeRelease(leftId)
  const right = claudeRelease(rightId)
  if (!left || !right) return (left ? 0 : 1) - (right ? 0 : 1)
  return right.major - left.major || right.minor - left.minor || left.tier - right.tier
}

function claudeRelease(id: string): { tier: number; major: number; minor: number } | undefined {
  const match = claudeModelFamily(id).match(CLAUDE_VERSIONED_ID)
  if (!match) return undefined
  return {
    tier: CLAUDE_TIERS.indexOf(match[1]!),
    major: Number(match[2]),
    minor: Number(match[3] ?? 0),
  }
}

function versionedClaudeModelName(id: string): string | undefined {
  const match = claudeModelFamily(id).match(CLAUDE_VERSIONED_ID)
  if (!match) return undefined
  const family = `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)}`
  const version = `${match[2]}${match[3] ? `.${match[3]}` : ''}`
  return `${family} ${version}`
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        if (signal) {
          onAbort = () => reject(new Error('Claude session is closed'))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
