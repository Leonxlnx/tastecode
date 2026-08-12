import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  ApprovalDecision,
  ApprovalMode,
  Capabilities,
  DomainEvent,
  Item,
  Model,
  Thread,
} from '@harness/contracts'
import { killTree, readNdjson, spawnCli } from '@harness/proc'

export const PI_CAPABILITIES: Capabilities = {
  steer: true,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: false,
  images: false,
}

type Spawn = typeof spawnCli
type Events = { event: [DomainEvent]; log: [string] }

export type PiAdapterOptions = {
  command: string
  args?: string[]
  displayName?: string
  spawn?: Spawn
  workspacePath?: string
}

type PiStartOptions = {
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
  instructions?: string | undefined
}

type PiTurnOptions = Pick<PiStartOptions, 'model' | 'effort'>

type PiResponse = {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiModel = {
  provider?: string
  id?: string
  name?: string
  contextWindow?: number
  reasoning?: boolean
}

type PiMessage = {
  role?: string
  stopReason?: string
  errorMessage?: string
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    reasoning?: number
    totalTokens?: number
    cost?: { total?: number }
  }
}

type PiEvent = {
  type?: string
  willRetry?: boolean
  assistantMessageEvent?: { type?: string; delta?: string }
  message?: PiMessage
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
  partialResult?: unknown
  isError?: boolean
}

type OpenItem = { item: Item; text: string }

/**
 * Pi's documented RPC mode: strict JSONL commands on stdin and responses plus
 * streaming session events on stdout. Custom forks can extend that protocol,
 * but this adapter deliberately consumes only the stable common subset.
 */
export class PiAdapter extends EventEmitter<Events> {
  readonly #command: string
  readonly #args: string[]
  readonly #displayName: string
  readonly #spawn: Spawn
  readonly #defaultWorkspacePath: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  #workspacePath = ''
  #threadId: string | undefined
  #activeTurnId: string | undefined
  #turnCounter = 0
  #itemCounter = 0
  #requestCounter = 0
  #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  #items = new Map<string, OpenItem>()
  #turnFailed = false
  #pendingError: string | undefined
  #interrupting = false
  #instructions: string | undefined
  #instructionsPending = false
  #model: string | undefined
  #effort: string | undefined
  #intentionalStop = false

  constructor(options: PiAdapterOptions) {
    super()
    this.#command = options.command
    this.#args = options.args ?? []
    this.#displayName = options.displayName ?? 'Pi'
    this.#spawn = options.spawn ?? spawnCli
    this.#defaultWorkspacePath = options.workspacePath
  }

  get capabilities(): Capabilities {
    return PI_CAPABILITIES
  }

  async startThread(workspacePath: string, options: PiStartOptions = {}): Promise<Thread> {
    if (options.approval === 'auto-review') {
      throw new Error('Pi RPC does not support automatic approval review')
    }
    this.#workspacePath = workspacePath
    this.#instructions = options.instructions
    this.#instructionsPending = Boolean(options.instructions)
    this.#model = options.model
    this.#effort = options.effort
    await this.#startProcess(workspacePath)
    const state = await this.#request<{ sessionId?: string }>('get_state')
    await this.#applyModelOptions()
    const sessionId = state.sessionId || crypto.randomUUID()
    this.#threadId = `pi-${sessionId}`
    return {
      id: this.#threadId,
      provider: 'pi',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: PiTurnOptions = {},
  ): Promise<string> {
    if (!this.#child || threadId !== this.#threadId) throw new Error('Pi session has not started')
    if (this.#activeTurnId) throw new Error('a Pi turn is already running')
    if (attachments.length > 0) throw new Error('Pi RPC file attachments are not supported yet')
    if ('model' in options) this.#model = options.model
    if ('effort' in options) this.#effort = options.effort
    await this.#applyModelOptions()

    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    this.#activeTurnId = turnId
    this.#turnFailed = false
    this.#pendingError = undefined
    this.#interrupting = false
    this.#itemCounter = 0
    this.#items.clear()
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })
    const prompt =
      this.#instructionsPending && this.#instructions
        ? `<system-instructions>\n${this.#instructions}\n</system-instructions>\n\n${text}`
        : text
    this.#instructionsPending = false
    try {
      await this.#request('prompt', { message: prompt })
    } catch (error) {
      this.#failTurn(error instanceof Error ? error.message : String(error))
      throw error
    }
    return turnId
  }

  async steer(threadId: string, text: string, attachments: string[] = []): Promise<void> {
    if (threadId !== this.#threadId || !this.#activeTurnId) {
      throw new Error('Pi has no active turn to steer')
    }
    if (attachments.length > 0) throw new Error('Pi RPC file attachments are not supported yet')
    await this.#request('steer', { message: text })
  }

  async interrupt(): Promise<void> {
    if (!this.#activeTurnId) return
    this.#interrupting = true
    await this.#request('abort').catch((error: unknown) => {
      this.#failTurn(error instanceof Error ? error.message : String(error))
    })
  }

  respondToApproval(_approvalId: string, _decision: ApprovalDecision): void {}

  async listModels(): Promise<Model[]> {
    // Discovery should not create an empty Pi session file every time the
    // renderer refreshes its catalog.
    await this.#startProcess(
      this.#workspacePath || this.#defaultWorkspacePath || process.cwd(),
      true,
    )
    const [available, state] = await Promise.all([
      this.#request<{ models?: PiModel[] }>('get_available_models'),
      this.#request<{ model?: PiModel; thinkingLevel?: string }>('get_state'),
    ])
    const selected = state.model
    const models: Model[] = []
    try {
      for (const model of available.models ?? []) {
        if (!model.provider || !model.id) continue
        let reasoningEfforts: string[] = []
        if (model.reasoning) {
          try {
            await this.#request('set_model', { provider: model.provider, modelId: model.id })
            const thinking = await this.#request<{ levels?: string[] }>(
              'get_available_thinking_levels',
            )
            reasoningEfforts = Array.isArray(thinking.levels)
              ? thinking.levels.filter((level): level is string => typeof level === 'string')
              : []
          } catch (error) {
            this.emit(
              'log',
              `${this.#displayName} could not inspect reasoning levels for ${model.provider}/${model.id}: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        models.push({
          id: `${model.provider}/${model.id}`,
          displayName: model.name || model.id,
          description: model.provider,
          isDefault: selected?.provider === model.provider && selected.id === model.id,
          reasoningEfforts,
          ...(selected?.provider === model.provider &&
          selected.id === model.id &&
          state.thinkingLevel &&
          reasoningEfforts.includes(state.thinkingLevel)
            ? { defaultReasoningEffort: state.thinkingLevel }
            : {}),
          serviceTiers: [],
        })
      }
    } finally {
      if (selected?.provider && selected.id) {
        await this.#request('set_model', {
          provider: selected.provider,
          modelId: selected.id,
        }).catch(() => {})
      }
      if (state.thinkingLevel) {
        await this.#request('set_thinking_level', { level: state.thinkingLevel }).catch(() => {})
      }
    }
    return models
  }

  dispose(): void {
    this.#intentionalStop = true
    if (this.#child) killTree(this.#child)
    this.#child = undefined
    this.#rejectPending(new Error(`${this.#displayName} stopped`))
    this.#activeTurnId = undefined
    this.#threadId = undefined
    this.#items.clear()
  }

  async #startProcess(cwd: string, ephemeral = false): Promise<void> {
    if (this.#child) return
    this.#intentionalStop = false
    const child = this.#spawn(
      this.#command,
      [...this.#args, ...(ephemeral ? ['--no-session'] : []), '--mode', 'rpc'],
      { cwd },
    )
    this.#child = child
    readNdjson(
      child.stdout,
      (value) => this.#onValue(value),
      (line) => this.emit('log', `${this.#displayName} non-JSON output: ${line.slice(0, 200)}`),
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trimEnd()))
    child.stdin.on('error', (error) => {
      if (this.#child === child) this.#processFailed(error.message)
    })
    child.on('error', (error) => {
      if (this.#child === child) this.#processFailed(error.message)
    })
    child.on('exit', (code) => {
      if (this.#child !== child) return
      this.#child = undefined
      if (!this.#intentionalStop) {
        this.#processFailed(`${this.#displayName} exited with code ${code ?? 'unknown'}`)
      }
    })
  }

  #request<T = unknown>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    const child = this.#child
    if (!child) return Promise.reject(new Error(`${this.#displayName} is not running`))
    const id = `harness-${++this.#requestCounter}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${this.#displayName} did not answer ${type}`))
      }, 20_000)
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
        if (!error) return
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error)
      })
    })
  }

  #onValue(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const record = value as Record<string, unknown>
    if (record.type === 'response') {
      this.#onResponse(record as PiResponse)
      return
    }
    if (record.type === 'extension_ui_request') {
      this.emit(
        'log',
        `${this.#displayName} requested extension UI that this custom integration cannot answer`,
      )
      if (typeof record.id === 'string' && this.#child) {
        this.#child.stdin.write(
          `${JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true })}\n`,
        )
      }
      return
    }
    this.#onEvent(record as PiEvent)
  }

  #onResponse(response: PiResponse): void {
    if (!response.id) return
    const pending = this.#pending.get(response.id)
    if (!pending) return
    this.#pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.success) pending.resolve(response.data)
    else pending.reject(new Error(response.error || `${response.command} failed`))
  }

  #onEvent(event: PiEvent): void {
    const turnId = this.#activeTurnId
    if (!turnId) return
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent
      if (update?.type === 'text_delta' && update.delta) {
        this.#deltaItem('message', 'assistant', update.delta)
      } else if (update?.type === 'thinking_delta' && update.delta) {
        this.#deltaItem('reasoning', undefined, update.delta)
      }
      return
    }
    if (event.type === 'message_end') {
      this.#completeItem('message')
      this.#completeItem('reasoning')
      this.#emitUsage(event.message)
      if (event.message?.stopReason === 'error') {
        this.#pendingError = event.message.errorMessage ?? 'Pi stopped with an error'
      }
      return
    }
    if (event.type === 'tool_execution_start' && event.toolCallId) {
      this.#startTool(event.toolCallId, event.toolName ?? 'tool', event.args)
      return
    }
    if (event.type === 'tool_execution_update' && event.toolCallId) {
      const text = resultText(event.partialResult)
      if (text) this.#deltaTool(event.toolCallId, text)
      return
    }
    if (event.type === 'tool_execution_end' && event.toolCallId) {
      this.#completeTool(event.toolCallId, event.result, event.isError === true)
      return
    }
    if (event.type === 'agent_end' && event.willRetry === true) {
      // Pi's auto-retry emits an error message_end before starting the next
      // attempt. It is not the turn result unless the agent finally settles.
      this.#pendingError = undefined
      return
    }
    if (event.type === 'agent_end') this.#finishTurn()
    if (event.type === 'agent_settled') this.#finishTurn()
  }

  #deltaItem(type: 'message' | 'reasoning', role: 'assistant' | undefined, delta: string): void {
    const turnId = this.#activeTurnId!
    let open = this.#items.get(type)
    if (!open) {
      const item: Item = {
        id: `${turnId}-${type}-${++this.#itemCounter}`,
        turnId,
        type,
        status: 'started',
        ...(role ? { role } : {}),
        text: '',
        createdAt: Date.now(),
      }
      open = { item, text: '' }
      this.#items.set(type, open)
      this.emit('event', { type: 'item.started', item })
    }
    open.text += delta
    this.emit('event', { type: 'item.delta', turnId, itemId: open.item.id, textDelta: delta })
  }

  #completeItem(key: string): void {
    const open = this.#items.get(key)
    if (!open) return
    this.#items.delete(key)
    this.emit('event', {
      type: 'item.completed',
      item: { ...open.item, status: 'completed', text: open.text },
    })
  }

  #startTool(toolCallId: string, name: string, args: unknown): void {
    const turnId = this.#activeTurnId!
    const details = object(args)
    const itemType =
      name === 'bash'
        ? 'command'
        : name === 'write' || name === 'edit'
          ? 'file_change'
          : 'tool_call'
    const item: Item = {
      id: `${turnId}-tool-${toolCallId}`,
      turnId,
      type: itemType,
      status: 'started',
      text: name,
      ...(itemType === 'command' && typeof details.command === 'string'
        ? { command: details.command }
        : {}),
      ...(itemType === 'file_change' && typeof details.path === 'string'
        ? { path: details.path }
        : {}),
      createdAt: Date.now(),
    }
    this.#items.set(`tool:${toolCallId}`, { item, text: '' })
    this.emit('event', { type: 'item.started', item })
  }

  #deltaTool(toolCallId: string, delta: string): void {
    const open = this.#items.get(`tool:${toolCallId}`)
    if (!open) return
    open.text += delta
    this.emit('event', {
      type: 'item.delta',
      turnId: open.item.turnId,
      itemId: open.item.id,
      textDelta: delta,
    })
  }

  #completeTool(toolCallId: string, result: unknown, failed: boolean): void {
    const key = `tool:${toolCallId}`
    const open = this.#items.get(key)
    if (!open) return
    this.#items.delete(key)
    const text = open.text || resultText(result) || open.item.text
    this.emit('event', {
      type: 'item.completed',
      item: { ...open.item, status: failed ? 'failed' : 'completed', ...(text ? { text } : {}) },
    })
  }

  #emitUsage(message: PiMessage | undefined): void {
    const usage = message?.usage
    if (!usage) return
    const input = number(usage.input)
    const cached = number(usage.cacheRead)
    const output = number(usage.output)
    this.emit('event', {
      type: 'usage.updated',
      usage: {
        inputTokens: input,
        cachedInputTokens: cached,
        outputTokens: output,
        reasoningTokens: number(usage.reasoning),
        totalTokens: number(usage.totalTokens) || input + cached + output,
        inputIncludesCached: false,
        ...(typeof usage.cost?.total === 'number' && usage.cost.total >= 0
          ? { costUsd: usage.cost.total }
          : {}),
      },
    })
  }

  async #applyModelOptions(): Promise<void> {
    if (this.#model) {
      const slash = this.#model.indexOf('/')
      if (slash < 1 || slash === this.#model.length - 1) {
        throw new Error('Pi models use provider/model')
      }
      await this.#request('set_model', {
        provider: this.#model.slice(0, slash),
        modelId: this.#model.slice(slash + 1),
      })
    }
    if (this.#effort) await this.#request('set_thinking_level', { level: this.#effort })
  }

  #finishTurn(): void {
    const turnId = this.#activeTurnId
    if (!turnId) return
    for (const key of [...this.#items.keys()]) this.#completeItem(key)
    if (this.#pendingError) {
      this.#turnFailed = true
      this.emit('event', {
        type: 'thread.error',
        threadId: this.#threadId!,
        message: this.#pendingError,
      })
      this.#pendingError = undefined
    }
    const status = this.#interrupting ? 'interrupted' : this.#turnFailed ? 'failed' : 'completed'
    this.#activeTurnId = undefined
    this.#pendingError = undefined
    this.#items.clear()
    this.emit('event', { type: 'turn.completed', turnId, status })
  }

  #failTurn(message: string): void {
    const turnId = this.#activeTurnId
    if (!turnId) return
    this.emit('event', { type: 'thread.error', threadId: this.#threadId!, message })
    this.#activeTurnId = undefined
    this.#items.clear()
    this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
  }

  #processFailed(message: string): void {
    this.#rejectPending(new Error(message))
    this.#failTurn(message)
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value
  const record = object(value)
  const content = Array.isArray(record.content) ? record.content : []
  return content
    .map((entry) => object(entry))
    .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
    .filter(Boolean)
    .join('\n')
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
