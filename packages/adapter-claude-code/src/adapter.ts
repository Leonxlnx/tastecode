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
  Model,
  Thread,
  UserInputQuestion,
} from '@harness/contracts'
import { spawnCli } from '@harness/proc'
import { toDomainEvents, toUsage, type ClaudeEvent } from './events.js'
import {
  claudeSdkSpawner,
  createClaudeQuery,
  waitForAbort,
  type ClaudeQueryFactory,
  type ClaudeQueryRuntime,
  type ClaudeSpawn,
} from './sdk-runtime.js'

/**
 * Claude Code is hosted through Anthropic's Agent SDK. The SDK keeps one
 * streaming session alive, owns the control protocol, and calls TasteCode back
 * for permissions and structured questions. Claude's own executable still
 * owns authentication; TasteCode never reads a credential file.
 */

const SUPPORTED = '2.1'
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

export const CLAUDE_CAPABILITIES: Capabilities = {
  steer: true,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  userInput: true,
  autoReview: true,
  images: true,
}

/**
 * Claude Code's versioned catalog. The SDK model control intentionally returns
 * the short interactive-picker list, including a synthetic `default` row, so
 * live discovery is merged with this catalog instead of replacing it.
 */
const FULL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const CLAUDE_MODELS: Model[] = [
  claudeModel(
    'claude-fable-5',
    'Claude Fable 5',
    'Most capable — flagship tier',
    FULL_EFFORTS,
    true,
  ),
  claudeModel('claude-opus-5', 'Claude Opus 5', 'Deep reasoning', FULL_EFFORTS),
  claudeModel('claude-sonnet-5', 'Claude Sonnet 5', 'Balanced speed and capability', FULL_EFFORTS),
  claudeModel('claude-haiku-4-5', 'Claude Haiku 4.5', 'Fastest and cheapest', []),
  claudeModel('claude-opus-4-8', 'Claude Opus 4.8', 'Previous Opus generation', FULL_EFFORTS),
  claudeModel(
    'claude-opus-4-7',
    'Claude Opus 4.7',
    'Older Opus generation',
    FULL_EFFORTS,
    false,
    'xhigh',
  ),
  claudeModel('claude-opus-4-6', 'Claude Opus 4.6', 'Older Opus generation', [
    'low',
    'medium',
    'high',
    'max',
  ]),
  claudeModel('claude-opus-4-5', 'Claude Opus 4.5', 'Older Opus generation', [
    'low',
    'medium',
    'high',
    'max',
  ]),
  claudeModel('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Previous Sonnet generation', [
    'low',
    'medium',
    'high',
    'max',
  ]),
]

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

const PERMISSION_MODE: Record<ApprovalMode, PermissionMode> = {
  ask: 'default',
  auto: 'acceptEdits',
  'auto-review': 'auto',
  full: 'bypassPermissions',
}

export type ClaudeAdapterEvents = {
  event: [DomainEvent]
  log: [string]
  usageChanged: []
}

export type ClaudeStartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
  ephemeral?: boolean | undefined
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

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** Build one SDK user message; prompts and file contents never travel on argv. */
export function claudeUserMessage(
  text: string,
  attachments: string[] = [],
  sessionId?: string,
): SDKUserMessage {
  const files = attachments.filter((file) => !IMAGE_MIME_TYPES[path.extname(file).toLowerCase()])
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
          const mediaType = IMAGE_MIME_TYPES[path.extname(file).toLowerCase()]
          return mediaType
            ? [
                {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: mediaType as
                      'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp',
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
  input: Record<string, unknown>
  suggestions: NonNullable<Parameters<CanUseTool>[2]['suggestions']>
  toolUseId: string
}

type PendingUserInput = {
  finish(result: PermissionResult): void
  input: Record<string, unknown>
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
  #workspacePath = ''
  #threadId = ''
  #options: ClaudeStartOptions = {}
  #reportedModel: string | undefined
  #sessionId: string | undefined
  #query: ClaudeQueryRuntime | undefined
  #promptQueue: PromptQueue | undefined
  #queryGeneration = 0
  #turnCounter = 0
  #activeTurnId: string | undefined
  #interruptRequested = false
  #disposed = false
  readonly #pendingApprovals = new Map<string, PendingApproval>()
  readonly #pendingUserInputs = new Map<string, PendingUserInput>()
  #streamMessageId: string | undefined
  readonly #streamBlocks = new Map<number, StreamBlock>()
  readonly #streamedMessageIds = new Set<string>()

  constructor(
    options: {
      createQuery?: ClaudeQueryFactory
      spawn?: ClaudeSpawn
      environment?: NodeJS.ProcessEnv
    } = {},
  ) {
    super()
    this.#createQuery = options.createQuery ?? createClaudeQuery
    this.#spawn = options.spawn ?? spawnCli
    this.#environment = options.environment ?? process.env
  }

  get capabilities(): Capabilities {
    return CLAUDE_CAPABILITIES
  }

  async startThread(workspacePath: string, options: ClaudeStartOptions = {}): Promise<Thread> {
    const sessionId = crypto.randomUUID()
    const threadId = `claude-${sessionId}`
    this.#openSession(threadId, sessionId, workspacePath, options, false)
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
    this.#openSession(threadId, sessionId, workspacePath, options, true)
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
    this.#assertThread(threadId)
    if (this.#activeTurnId) throw new Error('Claude already has a running turn')

    const previous = this.#options
    const next = applyClaudeTurnOptions(previous, options)
    this.#options = next
    if (previous.effort !== next.effort) {
      this.#restartSession()
    } else if (previous.model !== next.model) {
      await this.#requireQuery().setModel(next.model)
    }

    const queue = this.#requirePromptQueue()
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    queue.push(claudeUserMessage(text, attachments, this.#sessionId))
    this.#activeTurnId = turnId
    this.#interruptRequested = false
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })
    return turnId
  }

  async steer(threadId: string, text: string, attachments: string[] = []): Promise<void> {
    this.#assertThread(threadId)
    if (!this.#activeTurnId) throw new Error('there is no running Claude turn to steer')
    this.#requirePromptQueue().push({
      ...claudeUserMessage(text, attachments, this.#sessionId),
      priority: 'now',
    })
  }

  async interrupt(): Promise<void> {
    if (!this.#activeTurnId || !this.#query) return
    this.#interruptRequested = true
    await this.#query.interrupt()
  }

  async setApproval(approval: ApprovalMode): Promise<void> {
    this.#options = { ...this.#options, approval }
    if (this.#query) await this.#query.setPermissionMode(PERMISSION_MODE[approval])
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
          ? { updatedPermissions: pending.suggestions }
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
    if (decision === 'abort') void this.interrupt()
  }

  respondToUserInput(requestId: string, answers: Record<string, string[]>): void {
    const pending = this.#pendingUserInputs.get(requestId)
    if (!pending) return
    const sdkAnswers = Object.fromEntries(
      Object.entries(answers).map(([question, values]) => [
        question,
        values.length > 1 ? values : (values[0] ?? ''),
      ]),
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
        10_000,
        'Claude model discovery timed out',
      )
      return models.length > 0 ? mergeClaudeModels(models) : CLAUDE_MODELS
    } catch (error) {
      this.emit('log', `Claude model discovery fell back to known values: ${String(error)}`)
      return CLAUDE_MODELS
    } finally {
      abort.abort()
      query.close()
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#queryGeneration += 1
    this.#settlePending('Claude session closed.')
    this.#promptQueue?.close()
    this.#query?.close()
    this.#promptQueue = undefined
    this.#query = undefined
    this.#activeTurnId = undefined
    this.#clearStreamingState()
    this.removeAllListeners()
  }

  #openSession(
    threadId: string,
    sessionId: string,
    workspacePath: string,
    options: ClaudeStartOptions,
    resume: boolean,
  ): void {
    if (this.#query || this.#promptQueue) throw new Error('Claude adapter already has a session')
    this.#disposed = false
    this.#threadId = threadId
    this.#sessionId = sessionId
    this.#workspacePath = workspacePath
    this.#options = options
    this.#reportedModel = options.model
    this.#startQuery(resume ? sessionId : undefined)
  }

  #startQuery(resume?: string): void {
    const promptQueue = new PromptQueue()
    const query = this.#createQuery({
      prompt: promptQueue,
      options: this.#queryOptions({
        cwd: this.#workspacePath,
        ...(this.#options.model ? { model: this.#options.model } : {}),
        ...(this.#options.effort
          ? { effort: this.#options.effort as NonNullable<ClaudeQueryOptions['effort']> }
          : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(this.#options.instructions ? { append: this.#options.instructions } : {}),
        },
        settingSources: ['user', 'project', 'local'],
        persistSession: !this.#options.ephemeral,
        permissionMode: PERMISSION_MODE[this.#options.approval ?? 'ask'],
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        canUseTool: this.#canUseTool,
        additionalDirectories: [this.#workspacePath],
        ...(resume ? { resume } : this.#sessionId ? { sessionId: this.#sessionId } : {}),
      }),
    })
    const generation = ++this.#queryGeneration
    this.#promptQueue = promptQueue
    this.#query = query
    void this.#consume(query, generation)
  }

  #queryOptions(overrides: ClaudeQueryOptions): ClaudeQueryOptions {
    return {
      pathToClaudeCodeExecutable: 'claude',
      env: { ...this.#environment },
      spawnClaudeCodeProcess: claudeSdkSpawner(this.#spawn, (chunk) => {
        const line = chunk.trimEnd()
        if (line) this.emit('log', line)
      }),
      ...overrides,
    }
  }

  #restartSession(): void {
    if (this.#activeTurnId) throw new Error('Claude effort cannot change during a running turn')
    this.#queryGeneration += 1
    this.#promptQueue?.close()
    this.#query?.close()
    this.#promptQueue = undefined
    this.#query = undefined
    this.#clearStreamingState()
    this.#startQuery(this.#sessionId)
  }

  async #consume(query: ClaudeQueryRuntime, generation: number): Promise<void> {
    try {
      for await (const message of query) {
        if (generation !== this.#queryGeneration || this.#disposed) return
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
        this.#promptQueue = undefined
      }
    }
  }

  #onMessage(message: SDKMessage): void {
    const sessionId = 'session_id' in message ? message.session_id : undefined
    if (sessionId) this.#sessionId = sessionId

    if (message.type === 'stream_event') {
      this.#onStreamEvent(message)
      return
    }

    if (message.type === 'assistant') {
      if (!this.#activeTurnId) {
        this.emit('log', 'ignored Claude assistant replay outside an active turn')
        return
      }
      this.#reportedModel = message.message.model
      if (message.error) this.emit('log', `Claude assistant error: ${message.error}`)
      const event = message as unknown as ClaudeEvent
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
      this.#emitDomainEvents(toDomainEvents(filtered, this.#activeTurnId))
      this.#emitTodoPlan(event)
      return
    }

    if (message.type === 'user') {
      if (this.#activeTurnId)
        this.#emitDomainEvents(
          toDomainEvents(message as unknown as ClaudeEvent, this.#activeTurnId),
        )
      return
    }

    if (message.type === 'result') {
      const turnId = this.#activeTurnId
      if (!turnId) return
      const usage = toUsage(message.usage, message.total_cost_usd)
      if (usage) {
        this.emit('event', {
          type: 'usage.updated',
          usage: { ...usage, ...(this.#reportedModel ? { model: this.#reportedModel } : {}) },
        })
      }
      if (message.is_error && 'errors' in message && message.errors.length > 0) {
        this.emit('event', {
          type: 'thread.error',
          threadId: this.#threadId,
          message: message.errors.join('\n'),
        })
      }
      this.emit('event', {
        type: 'turn.completed',
        turnId,
        status: this.#interruptRequested
          ? 'interrupted'
          : message.is_error
            ? 'failed'
            : 'completed',
      })
      this.#activeTurnId = undefined
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
      this.emit('log', `Claude authentication: ${message.error}`)
      return
    }

    if (message.type === 'system' && message.subtype === 'init') {
      this.#reportedModel = message.model
      if (message.claude_code_version && !message.claude_code_version.startsWith(SUPPORTED)) {
        this.emit(
          'log',
          `claude-code ${message.claude_code_version} is newer than the ${SUPPORTED}.x compatibility baseline`,
        )
      }
    }
  }

  #onStreamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>): void {
    const turnId = this.#activeTurnId
    if (!turnId || message.parent_tool_use_id) return
    const event = message.event as unknown as Record<string, unknown>
    const type = String(event['type'] ?? '')
    if (type === 'message_start') {
      const raw = event['message'] as Record<string, unknown> | undefined
      this.#streamMessageId = String(raw?.['id'] ?? message.uuid)
      return
    }

    const index = typeof event['index'] === 'number' ? event['index'] : -1
    if (type === 'content_block_start') {
      const raw = event['content_block'] as Record<string, unknown> | undefined
      const blockType = raw?.['type']
      if (blockType === 'tool_use') {
        const name = String(raw?.['name'] ?? 'tool')
        const input =
          raw?.['input'] && typeof raw['input'] === 'object'
            ? (raw['input'] as Record<string, unknown>)
            : {}
        const id = `${String(raw?.['id'] ?? `${message.uuid}-${index}`)}-call`
        this.emit('event', {
          type: 'item.started',
          item: {
            id,
            turnId,
            status: 'started',
            ...toolItemFields(name, input),
            createdAt: Date.now(),
          },
        })
        return
      }
      if (blockType !== 'text' && blockType !== 'thinking') return
      const messageId = this.#streamMessageId ?? message.uuid
      const text = String(blockType === 'text' ? (raw?.['text'] ?? '') : (raw?.['thinking'] ?? ''))
      const block: StreamBlock = {
        id: `${messageId}-${blockType}-${index}`,
        turnId,
        type: blockType === 'text' ? 'message' : 'reasoning',
        text,
        createdAt: Date.now(),
      }
      this.#streamBlocks.set(index, block)
      this.#streamedMessageIds.add(messageId)
      this.emit('event', {
        type: 'item.started',
        item: {
          id: block.id,
          turnId,
          type: block.type,
          status: 'started',
          ...(block.type === 'message' ? { role: 'assistant' as const } : {}),
          text: '',
          createdAt: block.createdAt,
        },
      })
      if (text)
        this.emit('event', { type: 'item.delta', turnId, itemId: block.id, textDelta: text })
      return
    }

    if (type === 'content_block_delta') {
      const delta = event['delta'] as Record<string, unknown> | undefined
      const text =
        delta?.['type'] === 'text_delta'
          ? String(delta['text'] ?? '')
          : delta?.['type'] === 'thinking_delta'
            ? String(delta['thinking'] ?? '')
            : ''
      const block = this.#streamBlocks.get(index)
      if (!block || !text) return
      block.text += text
      this.emit('event', { type: 'item.delta', turnId, itemId: block.id, textDelta: text })
      return
    }

    if (type === 'content_block_stop') {
      const block = this.#streamBlocks.get(index)
      if (!block) return
      this.#streamBlocks.delete(index)
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
      const tool = block as { name?: string; input?: Record<string, unknown> }
      if (tool.name !== 'TodoWrite' || !Array.isArray(tool.input?.['todos'])) continue
      const steps = tool.input['todos'].flatMap((value) => {
        if (!value || typeof value !== 'object') return []
        const todo = value as Record<string, unknown>
        const text = String(todo['content'] ?? '').trim()
        if (!text) return []
        const rawStatus = String(todo['status'] ?? 'pending')
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
      if (event.type === 'usage.updated' && this.#reportedModel) {
        this.emit('event', { ...event, usage: { ...event.usage, model: this.#reportedModel } })
      } else {
        this.emit('event', event)
      }
    }
  }

  #canUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName === 'AskUserQuestion') return this.#requestUserInput(input, options)
    if ((this.#options.approval ?? 'ask') === 'full') {
      return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
    }
    if (!this.#activeTurnId) {
      return {
        behavior: 'deny',
        message: 'Claude turn is no longer active.',
        toolUseID: options.toolUseID,
      }
    }

    const id = crypto.randomUUID()
    const request = approvalRequest(id, toolName, input, options)
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
        input,
        suggestions: options.suggestions ?? [],
        toolUseId: options.toolUseID,
      })
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.emit('event', { type: 'approval.requested', request })
    })
  }

  #requestUserInput(
    input: Record<string, unknown>,
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
    for (const pending of [...this.#pendingApprovals.values()]) {
      pending.finish({
        behavior: 'deny',
        message,
        toolUseID: pending.toolUseId,
        decisionClassification: 'user_reject',
      })
    }
    for (const pending of [...this.#pendingUserInputs.values()]) {
      pending.finish({
        behavior: 'deny',
        message,
        toolUseID: pending.toolUseId,
        decisionClassification: 'user_reject',
      })
    }
  }

  #failActiveTurn(message: string): void {
    const turnId = this.#activeTurnId
    if (!turnId) {
      this.emit('log', message)
      return
    }
    this.emit('event', { type: 'thread.error', threadId: this.#threadId, message })
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
    this.#streamedMessageIds.clear()
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
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): ApprovalRequest {
  const kind = SHELL_TOOLS.has(toolName)
    ? ('command' as const)
    : EDIT_TOOLS.has(toolName)
      ? ('file_change' as const)
      : ('permissions' as const)
  const pathValue = options.blockedPath ?? input['file_path'] ?? input['path']
  return {
    id,
    kind,
    ...(options.title || options.description || options.decisionReason
      ? { reason: options.title ?? options.description ?? options.decisionReason }
      : {}),
    ...(kind === 'command' ? { command: String(input['command'] ?? toolName) } : {}),
    ...(typeof input['cwd'] === 'string' ? { cwd: input['cwd'] } : {}),
    ...(pathValue ? { path: String(pathValue) } : {}),
    createdAt: Date.now(),
  }
}

function toolItemFields(
  toolName: string,
  input: Record<string, unknown>,
):
  | { type: 'command'; command: string }
  | { type: 'file_change'; path: string }
  | { type: 'tool_call'; text: string } {
  if (SHELL_TOOLS.has(toolName)) {
    return { type: 'command', command: String(input['command'] ?? toolName) }
  }
  if (EDIT_TOOLS.has(toolName)) {
    return { type: 'file_change', path: String(input['file_path'] ?? '') }
  }
  return { type: 'tool_call', text: toolName }
}

function parseUserInputQuestions(input: Record<string, unknown>): UserInputQuestion[] {
  if (!Array.isArray(input['questions'])) return []
  return input['questions'].flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const raw = value as Record<string, unknown>
    const question = String(raw['question'] ?? '').trim()
    if (!question) return []
    const options = Array.isArray(raw['options'])
      ? raw['options'].flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const option = entry as Record<string, unknown>
          const label = String(option['label'] ?? '').trim()
          if (!label) return []
          return [
            {
              label,
              description: String(option['description'] ?? '').trim() || `Choose ${label}`,
            },
          ]
        })
      : []
    return [
      {
        // Claude Code uses the full question text as the answer-map key.
        id: question,
        header: String(raw['header'] ?? '').trim() || `Question ${index + 1}`,
        question,
        allowOther: true,
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

  const merged: Model[] = []
  const used = new Set<DiscoveredClaudeModel>()
  for (const catalogModel of CLAUDE_MODELS) {
    const family = claudeModelFamily(catalogModel.id)
    const matches = discovered.filter((entry) => claudeModelFamily(entry.resolvedId) === family)
    const extended = matches.filter((entry) => entry.resolvedId.endsWith('[1m]'))
    const standard = matches.find((entry) => !entry.resolvedId.endsWith('[1m]'))

    for (const entry of extended) {
      merged.push(entry.model)
      used.add(entry)
    }
    if (standard) {
      merged.push(standard.model)
      used.add(standard)
    } else {
      merged.push(catalogModel)
    }
  }
  for (const entry of discovered) {
    if (!used.has(entry)) merged.push(entry.model)
  }

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

function versionedClaudeModelName(id: string): string | undefined {
  const match = claudeModelFamily(id).match(/^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/)
  if (!match) return undefined
  const family = `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)}`
  const version = `${match[2]}${match[3] ? `.${match[3]}` : ''}`
  return `Claude ${family} ${version}${id.endsWith('[1m]') ? ' (1M context)' : ''}`
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
