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
import {
  JsonRpcValueSchema,
  killTree,
  readNdjson,
  spawnCli,
  type JsonRpcValue,
} from '@harness/proc'
import { z } from 'zod'
import { propertiesWhen } from './properties-when.js'

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

const PiResponseSchema = z.object({
  id: z.string().optional(),
  type: z.literal('response'),
  command: z.string(),
  success: z.boolean(),
  data: JsonRpcValueSchema.optional(),
  error: z.string().optional(),
})

const PiModelSchema = z.object({
  provider: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  reasoning: z.boolean().optional(),
})

const PiMessageSchema = z.object({
  role: z.string().optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
  usage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      reasoning: z.number().optional(),
      totalTokens: z.number().optional(),
      cost: z.object({ total: z.number().optional() }).optional(),
    })
    .optional(),
})

const PiEventSchema = z.object({
  type: z.string().optional(),
  willRetry: z.boolean().optional(),
  assistantMessageEvent: z
    .object({ type: z.string().optional(), delta: z.string().optional() })
    .optional(),
  message: PiMessageSchema.optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  args: JsonRpcValueSchema.optional(),
  result: JsonRpcValueSchema.optional(),
  partialResult: JsonRpcValueSchema.optional(),
  isError: z.boolean().optional(),
})

const ExtensionUiRequestSchema = z.object({
  type: z.literal('extension_ui_request'),
  id: z.string().optional(),
})

const PiStateSchema = z.object({
  sessionId: z.string().optional(),
  model: PiModelSchema.optional(),
  thinkingLevel: z.string().optional(),
})
const PiAvailableModelsSchema = z.object({ models: z.array(PiModelSchema).optional() })
const PiThinkingLevelsSchema = z.object({ levels: z.array(z.string()).optional() })
const JsonObjectSchema = z.record(z.string(), JsonRpcValueSchema)
const ToolResultSchema = z.object({
  content: z.array(z.object({ text: z.string().optional() })).optional(),
})

type PiResponse = z.infer<typeof PiResponseSchema>
type PiMessage = z.infer<typeof PiMessageSchema>
type PiEvent = z.infer<typeof PiEventSchema>

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
    {
      resolve: (value: JsonRpcValue | undefined) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
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
    const state = await this.#requestParsed('get_state', {}, PiStateSchema)
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
    await this.#request('abort').catch((cause) => {
      this.#failTurn(cause instanceof Error ? cause.message : String(cause))
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
      this.#requestParsed('get_available_models', {}, PiAvailableModelsSchema),
      this.#requestParsed('get_state', {}, PiStateSchema),
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
            const thinking = await this.#requestParsed(
              'get_available_thinking_levels',
              {},
              PiThinkingLevelsSchema,
            )
            reasoningEfforts = thinking.levels ?? []
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
          ...propertiesWhen(
            selected?.provider === model.provider &&
              selected.id === model.id &&
              state.thinkingLevel &&
              reasoningEfforts.includes(state.thinkingLevel),
            () => ({ defaultReasoningEffort: state.thinkingLevel }),
          ),
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
    child.on('close', (code) => {
      if (this.#child !== child) return
      this.#child = undefined
      if (!this.#intentionalStop) {
        this.#processFailed(`${this.#displayName} exited with code ${code ?? 'unknown'}`)
      }
    })
  }

  #request(
    type: string,
    fields: Record<string, JsonRpcValue> = {},
  ): Promise<JsonRpcValue | undefined> {
    const child = this.#child
    if (!child) return Promise.reject(new Error(`${this.#displayName} is not running`))
    const id = `harness-${++this.#requestCounter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${this.#displayName} did not answer ${type}`))
      }, 20_000)
      this.#pending.set(id, { resolve, reject, timer })
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

  #requestParsed<Result>(
    type: string,
    fields: Record<string, JsonRpcValue>,
    result: z.ZodType<Result>,
  ): Promise<Result> {
    return this.#request(type, fields).then((value) => result.parse(value))
  }

  #onValue(value: JsonRpcValue): void {
    const response = PiResponseSchema.safeParse(value)
    if (response.success) {
      this.#onResponse(response.data)
      return
    }
    const extensionRequest = ExtensionUiRequestSchema.safeParse(value)
    if (extensionRequest.success) {
      this.emit(
        'log',
        `${this.#displayName} requested extension UI that this custom integration cannot answer`,
      )
      if (extensionRequest.data.id && this.#child) {
        this.#child.stdin.write(
          `${JSON.stringify({
            type: 'extension_ui_response',
            id: extensionRequest.data.id,
            cancelled: true,
          })}\n`,
        )
      }
      return
    }
    const event = PiEventSchema.safeParse(value)
    if (event.success) this.#onEvent(event.data)
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
        ...propertiesWhen(role, (role) => ({ role })),
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

  #startTool(toolCallId: string, name: string, args: JsonRpcValue | undefined): void {
    const turnId = this.#activeTurnId!
    const details = JsonObjectSchema.safeParse(args)
    const command = details.success ? z.string().safeParse(details.data['command']) : undefined
    const path = details.success ? z.string().safeParse(details.data['path']) : undefined
    const commandText = command?.success ? command.data : undefined
    const filePath = path?.success ? path.data : undefined
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
      ...propertiesWhen(itemType === 'command' && commandText, (includedCommand) => ({
        command: includedCommand,
      })),
      ...propertiesWhen(itemType === 'file_change' && filePath, (includedPath) => ({
        path: includedPath,
      })),
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

  #completeTool(toolCallId: string, result: JsonRpcValue | undefined, failed: boolean): void {
    const key = `tool:${toolCallId}`
    const open = this.#items.get(key)
    if (!open) return
    this.#items.delete(key)
    const text = open.text || resultText(result) || open.item.text
    this.emit('event', {
      type: 'item.completed',
      item: {
        ...open.item,
        status: failed ? 'failed' : 'completed',
        ...propertiesWhen(text, (text) => ({ text })),
      },
    })
  }

  #emitUsage(message: PiMessage | undefined): void {
    const usage = message?.usage
    if (!usage) return
    const input = number(usage.input)
    const cached = number(usage.cacheRead)
    const output = number(usage.output)
    const cost = usage.cost?.total
    this.emit('event', {
      type: 'usage.updated',
      usage: {
        inputTokens: input,
        cachedInputTokens: cached,
        outputTokens: output,
        reasoningTokens: number(usage.reasoning),
        totalTokens: number(usage.totalTokens) || input + cached + output,
        inputIncludesCached: false,
        ...propertiesWhen(cost !== undefined && cost >= 0, () => ({ costUsd: cost })),
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

function resultText(value: JsonRpcValue | undefined): string {
  const direct = z.string().safeParse(value)
  if (direct.success) return direct.data
  const result = ToolResultSchema.safeParse(value)
  return (result.success ? (result.data.content ?? []) : [])
    .map((entry) => entry.text ?? '')
    .filter(Boolean)
    .join('\n')
}

function number(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}
