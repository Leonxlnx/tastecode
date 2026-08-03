import { EventEmitter } from 'node:events'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Capabilities,
  DomainEvent,
  Thread,
  Usage,
} from '@harness/contracts'

export type ApiToolCall = { id: string; name: string; input: unknown }

export type ApiMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ApiToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; isError: boolean }

export type ApiTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ApiStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ApiToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' }

export type ApiTransport = (request: {
  model: string
  messages: readonly ApiMessage[]
  tools: readonly ApiTool[]
  signal: AbortSignal
}) => AsyncIterable<ApiStreamEvent>

export type ApiSessionState = { thread: Thread; messages: ApiMessage[] }
export type ApiToolResult = { content: string; isError?: boolean }

export const API_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  images: false,
}

type Events = { event: [DomainEvent]; log: [string] }

export class ApiAgentSession extends EventEmitter<Events> {
  readonly capabilities = API_CAPABILITIES
  readonly #model: string
  readonly #transport: ApiTransport
  readonly #tools: readonly ApiTool[]
  readonly #executeTool: (call: ApiToolCall, signal: AbortSignal) => Promise<ApiToolResult>
  readonly #reviewTool: (call: ApiToolCall) => Omit<ApprovalRequest, 'id' | 'createdAt'> | undefined
  readonly #maxToolCalls: number
  readonly #secrets: readonly string[]
  #thread: Thread | undefined
  #messages: ApiMessage[] = []
  #active: { turnId: string; controller: AbortController; done: Promise<void> } | undefined
  #approval: { id: string; resolve: (decision: ApprovalDecision) => void } | undefined
  #approvedTools = new Set<string>()
  #turnCounter = 0

  constructor(options: {
    model: string
    transport: ApiTransport
    tools?: readonly ApiTool[]
    executeTool?: (call: ApiToolCall, signal: AbortSignal) => Promise<ApiToolResult>
    reviewTool?: (call: ApiToolCall) => Omit<ApprovalRequest, 'id' | 'createdAt'> | undefined
    maxToolCalls?: number
    secrets?: readonly string[]
  }) {
    super()
    this.#model = options.model
    this.#transport = options.transport
    this.#tools = options.tools ?? []
    this.#executeTool =
      options.executeTool ??
      (async () => ({ content: 'Tool execution is unavailable.', isError: true }))
    this.#reviewTool = options.reviewTool ?? (() => undefined)
    this.#maxToolCalls = options.maxToolCalls ?? 32
    if (!Number.isInteger(this.#maxToolCalls) || this.#maxToolCalls < 1) {
      throw new Error('maxToolCalls must be a positive integer')
    }
    this.#secrets = (options.secrets ?? []).filter((secret) => secret.length >= 4)
  }

  startThread(workspacePath: string, connectionId: string): Thread {
    if (!connectionId) throw new Error('connectionId is required')
    const thread: Thread = {
      id: `api-${crypto.randomUUID()}`,
      provider: 'api',
      connectionId,
      workspacePath,
      createdAt: Date.now(),
    }
    this.#thread = thread
    this.#messages = []
    return thread
  }

  resumeThread(state: ApiSessionState): Thread {
    if (state.thread.provider !== 'api') throw new Error('only API threads can resume here')
    this.#thread = structuredClone(state.thread)
    this.#messages = structuredClone(state.messages)
    return this.#thread
  }

  snapshot(): ApiSessionState {
    if (!this.#thread) throw new Error('session has not started')
    return structuredClone({ thread: this.#thread, messages: this.#messages })
  }

  async sendTurn(threadId: string, text: string, attachments: string[] = []): Promise<string> {
    const thread = this.#requireThread(threadId)
    if (this.#active) throw new Error('a turn is already running')
    if (attachments.length > 0) throw new Error('direct API attachments are not supported yet')

    const turnId = `${thread.id}-turn-${++this.#turnCounter}`
    const controller = new AbortController()
    const done = this.#runTurn(turnId, text, controller.signal).finally(() => {
      if (this.#active?.turnId === turnId) this.#active = undefined
    })
    this.#active = { turnId, controller, done }
    return turnId
  }

  async interrupt(threadId: string): Promise<void> {
    this.#requireThread(threadId)
    this.#active?.controller.abort()
    await this.#active?.done
  }

  async waitForTurn(turnId: string): Promise<void> {
    if (this.#active?.turnId === turnId) await this.#active.done
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    if (this.#approval?.id !== approvalId) return
    this.#approval.resolve(decision)
  }

  dispose(): void {
    this.#active?.controller.abort()
  }

  async #runTurn(turnId: string, text: string, signal: AbortSignal): Promise<void> {
    const thread = this.#thread!
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId: thread.id, status: 'running', createdAt: Date.now() },
    })
    this.#messages.push({ role: 'user', content: text })

    try {
      let toolCalls = 0
      while (true) {
        const response = await this.#stream(turnId, signal)
        this.#messages.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.calls,
        })
        if (response.finish === 'stop') break
        if (response.calls.length === 0) throw new Error('missing tool calls')

        for (const call of response.calls) {
          if (++toolCalls > this.#maxToolCalls) throw new Error('tool call limit exceeded')
          await this.#runTool(turnId, call, signal)
        }
      }
      if (!signal.aborted) {
        this.emit('event', { type: 'turn.completed', turnId, status: 'completed' })
      }
    } catch (error) {
      const interrupted = signal.aborted
      if (!interrupted) {
        this.emit('log', 'direct API model request failed')
        this.emit('event', {
          type: 'thread.error',
          threadId: thread.id,
          message: 'The model request failed.',
        })
      }
      this.emit('event', {
        type: 'turn.completed',
        turnId,
        status: interrupted ? 'interrupted' : 'failed',
      })
    }
  }

  async #stream(
    turnId: string,
    signal: AbortSignal,
  ): Promise<{ text: string; calls: ApiToolCall[]; finish: 'stop' | 'tool_calls' }> {
    const itemId = `${turnId}-assistant-${this.#messages.length}`
    let started = false
    let text = ''
    let finish: 'stop' | 'tool_calls' | undefined
    const calls: ApiToolCall[] = []
    for await (const event of this.#transport({
      model: this.#model,
      messages: this.#messages,
      tools: this.#tools,
      signal,
    })) {
      if (event.type === 'text') {
        if (!started) {
          started = true
          this.emit('event', {
            type: 'item.started',
            item: {
              id: itemId,
              turnId,
              type: 'message',
              role: 'assistant',
              status: 'started',
              text: '',
              createdAt: Date.now(),
            },
          })
        }
        const delta = this.#redact(event.delta)
        text += delta
        this.emit('event', { type: 'item.delta', turnId, itemId, textDelta: delta })
      } else if (event.type === 'tool_call') {
        calls.push(event.call)
      } else if (event.type === 'usage') {
        this.emit('event', { type: 'usage.updated', usage: event.usage })
      } else if (event.type === 'finish') {
        finish = event.reason
      }
    }
    if (!finish) throw new Error('transport ended without a finish event')
    if (started) {
      this.emit('event', {
        type: 'item.completed',
        item: {
          id: itemId,
          turnId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text,
          createdAt: Date.now(),
        },
      })
    }
    return { text, calls, finish }
  }

  async #runTool(turnId: string, call: ApiToolCall, signal: AbortSignal): Promise<void> {
    const itemId = `${turnId}-tool-${call.id}`
    const createdAt = Date.now()
    this.emit('event', {
      type: 'item.started',
      item: {
        id: itemId,
        turnId,
        type: 'tool_call',
        status: 'started',
        text: call.name,
        createdAt,
      },
    })

    let result: ApiToolResult
    if (await this.#approved(call, signal)) {
      try {
        result = await this.#executeTool(call, signal)
      } catch {
        result = { content: 'Tool execution failed.', isError: true }
      }
    } else {
      result = { content: 'Tool execution was denied.', isError: true }
    }
    const content = this.#redact(result.content)
    this.#messages.push({
      role: 'tool',
      content,
      toolCallId: call.id,
      isError: result.isError ?? false,
    })
    this.emit('event', {
      type: 'item.completed',
      item: {
        id: itemId,
        turnId,
        type: 'tool_call',
        status: result.isError ? 'failed' : 'completed',
        text: `${call.name}\n${content}`,
        createdAt,
      },
    })
  }

  async #approved(call: ApiToolCall, signal: AbortSignal): Promise<boolean> {
    const review = this.#reviewTool(call)
    if (!review || this.#approvedTools.has(call.name)) return true
    const request: ApprovalRequest = {
      ...review,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    }
    const pending = new Promise<ApprovalDecision>((resolve) => {
      const finish = (value: ApprovalDecision) => {
        signal.removeEventListener('abort', abort)
        this.#approval = undefined
        resolve(value)
      }
      const abort = () => finish('abort')
      this.#approval = { id: request.id, resolve: finish }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    this.emit('event', { type: 'approval.requested', request })
    const decision = await pending
    this.emit('event', { type: 'approval.resolved', id: request.id })
    if (decision === 'abort') throw new DOMException('interrupted', 'AbortError')
    if (decision === 'approve-session') this.#approvedTools.add(call.name)
    return decision === 'approve' || decision === 'approve-session'
  }

  #redact(value: string): string {
    return this.#secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value)
  }

  #requireThread(threadId: string): Thread {
    if (!this.#thread || this.#thread.id !== threadId) throw new Error('no such API thread')
    return this.#thread
  }
}
