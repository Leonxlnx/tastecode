import { EventEmitter } from 'node:events'
import type { Capabilities, DomainEvent, Thread, Usage } from '@harness/contracts'

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
  #thread: Thread | undefined
  #messages: ApiMessage[] = []
  #active: { turnId: string; controller: AbortController; done: Promise<void> } | undefined
  #turnCounter = 0

  constructor(options: { model: string; transport: ApiTransport; tools?: readonly ApiTool[] }) {
    super()
    this.#model = options.model
    this.#transport = options.transport
    this.#tools = options.tools ?? []
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

  respondToApproval(): void {}

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
      let answer = ''
      let finish: 'stop' | 'tool_calls' | undefined
      const itemId = `${turnId}-assistant`
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
      for await (const event of this.#transport({
        model: this.#model,
        messages: this.#messages,
        tools: this.#tools,
        signal,
      })) {
        if (event.type === 'text') {
          answer += event.delta
          this.emit('event', { type: 'item.delta', turnId, itemId, textDelta: event.delta })
        } else if (event.type === 'usage') {
          this.emit('event', { type: 'usage.updated', usage: event.usage })
        } else if (event.type === 'finish') {
          finish = event.reason
        }
      }
      if (!finish) throw new Error('transport ended without a finish event')
      if (finish !== 'stop') throw new Error('tool calls are not implemented yet')
      this.#messages.push({ role: 'assistant', content: answer, toolCalls: [] })
      this.emit('event', {
        type: 'item.completed',
        item: {
          id: itemId,
          turnId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: answer,
          createdAt: Date.now(),
        },
      })
      this.emit('event', { type: 'turn.completed', turnId, status: 'completed' })
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

  #requireThread(threadId: string): Thread {
    if (!this.#thread || this.#thread.id !== threadId) throw new Error('no such API thread')
    return this.#thread
  }
}
