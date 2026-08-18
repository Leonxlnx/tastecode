import { EventEmitter } from 'node:events'
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  Capabilities,
  DomainEvent,
  Item,
  Thread,
  Usage,
} from '@harness/contracts'
import type { JsonObject, JsonValue } from './json.js'

export type ApiToolCall = { id: string; name: string; input: JsonValue }

export type ApiMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ApiToolCall[]; transportState?: JsonValue }
  | { role: 'tool'; content: string; toolCallId: string; isError: boolean }

export type ApiTool = {
  name: string
  description: string
  inputSchema: JsonObject
}

export type ApiStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ApiToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'state'; value: JsonValue }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' }

export type ApiTransport = (request: {
  model: string
  messages: readonly ApiMessage[]
  tools: readonly ApiTool[]
  signal: AbortSignal
}) => AsyncIterable<ApiStreamEvent>

export type ApiSessionState = { thread: Thread; messages: ApiMessage[]; turnCounter: number }
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

interface StreamResult {
  text: string
  calls: ApiToolCall[]
  finish: 'stop' | 'tool_calls'
  state: JsonValue | undefined
}

interface RedactedDelta {
  chunk: string
  pending: string
}

export class ApiAgentSession extends EventEmitter<Events> {
  readonly capabilities = API_CAPABILITIES
  readonly #model: string
  readonly #transport: ApiTransport
  readonly #tools: readonly ApiTool[]
  readonly #executeTool: (call: ApiToolCall, signal: AbortSignal) => Promise<ApiToolResult>
  readonly #reviewTool: (call: ApiToolCall) => Omit<ApprovalRequest, 'id' | 'createdAt'> | undefined
  readonly #onSetApproval: ((approval: ApprovalMode) => void) | undefined
  readonly #maxToolCalls: number
  readonly #secrets: readonly string[]
  readonly #instructions: string | undefined
  #instructionsPending = false
  #thread: Thread | undefined
  #messages: ApiMessage[] = []
  #active: { turnId: string; controller: AbortController; done: Promise<void> } | undefined
  readonly #openItems = new Map<string, Item>()
  #approval: { id: string; resolve: (decision: ApprovalDecision) => void } | undefined
  #approvedTools = new Set<string>()
  #turnCounter = 0

  constructor(options: {
    model: string
    transport: ApiTransport
    tools?: readonly ApiTool[]
    executeTool?: (call: ApiToolCall, signal: AbortSignal) => Promise<ApiToolResult>
    reviewTool?: (call: ApiToolCall) => Omit<ApprovalRequest, 'id' | 'createdAt'> | undefined
    /** Live access-level change; the owner swaps the review policy behind it. */
    setApproval?: (approval: ApprovalMode) => void
    maxToolCalls?: number
    secrets?: readonly string[]
    instructions?: string
  }) {
    super()
    this.#model = options.model
    this.#transport = options.transport
    this.#tools = options.tools ?? []
    this.#executeTool =
      options.executeTool ??
      (async () => ({ content: 'Tool execution is unavailable.', isError: true }))
    this.#reviewTool = options.reviewTool ?? (() => undefined)
    this.#onSetApproval = options.setApproval
    this.#maxToolCalls = options.maxToolCalls ?? 32
    if (!Number.isInteger(this.#maxToolCalls) || this.#maxToolCalls < 1) {
      throw new Error('maxToolCalls must be a positive integer')
    }
    this.#secrets = (options.secrets ?? []).filter((secret) => secret.length >= 4)
    this.#instructions = options.instructions
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
    this.#instructionsPending = Boolean(this.#instructions)
    return thread
  }

  resumeThread(state: ApiSessionState): Thread {
    if (state.thread.provider !== 'api') throw new Error('only API threads can resume here')
    this.#thread = structuredClone(state.thread)
    this.#messages = structuredClone(state.messages)
    this.#turnCounter = state.turnCounter
    this.#instructionsPending = this.#messages.length === 0 && Boolean(this.#instructions)
    return this.#thread
  }

  snapshot(): ApiSessionState {
    if (!this.#thread) throw new Error('session has not started')
    return structuredClone({
      thread: this.#thread,
      messages: this.#messages,
      turnCounter: this.#turnCounter,
    })
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

  setApproval(approval: ApprovalMode): void {
    this.#onSetApproval?.(approval)
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
    const prompt =
      this.#instructionsPending && this.#instructions
        ? `<system-instructions>\n${this.#instructions}\n</system-instructions>\n\n${text}`
        : text
    this.#instructionsPending = false
    this.#messages.push({ role: 'user', content: prompt })

    try {
      let toolCalls = 0
      while (true) {
        signal.throwIfAborted()
        const response = await this.#stream(turnId, signal)
        const assistant: ApiMessage = {
          role: 'assistant',
          content: response.text,
          toolCalls: response.calls,
        }
        if (response.state !== undefined) assistant.transportState = response.state
        this.#messages.push(assistant)
        if (response.finish === 'stop') break
        if (response.calls.length === 0) throw new Error('missing tool calls')

        for (const call of response.calls) {
          if (++toolCalls > this.#maxToolCalls) throw new Error('tool call limit exceeded')
          await this.#runTool(turnId, call, signal)
        }
      }
      this.#finishOpenItems('completed')
      this.emit('event', {
        type: 'turn.completed',
        turnId,
        status: signal.aborted ? 'interrupted' : 'completed',
      })
    } catch (error) {
      const interrupted = signal.aborted
      // Orphaned tool_use blocks brick the thread: an assistant message with
      // tool calls but no tool results makes every later Anthropic request
      // fail with a 400. Close the books before this state can persist.
      // The last message may already be a tool result; the calls to close
      // out live on the last *assistant* message, wherever it sits.
      const last = this.#messages.findLast((message) => message.role === 'assistant')
      if (last?.role === 'assistant' && last.toolCalls?.length) {
        const answered = new Set(
          this.#messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.toolCallId),
        )
        for (const call of last.toolCalls) {
          if (!answered.has(call.id)) {
            this.#messages.push({
              role: 'tool',
              toolCallId: call.id,
              content: 'Tool execution was interrupted.',
              isError: true,
            })
          }
        }
      }
      if (!interrupted) {
        const detail = error instanceof Error ? error.message : String(error)
        this.emit('log', `direct API model request failed: ${detail}`)
        this.emit('event', {
          type: 'thread.error',
          threadId: thread.id,
          // The redacted real cause, not a shrug — "credit balance too low"
          // and "invalid api key" are actionable; "request failed" is not.
          message: this.#redact(detail) || 'The model request failed.',
        })
      }
      this.#finishOpenItems('failed')
      this.emit('event', {
        type: 'turn.completed',
        turnId,
        status: interrupted ? 'interrupted' : 'failed',
      })
    }
  }

  async #stream(turnId: string, signal: AbortSignal): Promise<StreamResult> {
    const itemId = `${turnId}-assistant-${this.#messages.length}`
    const reasoningId = `${itemId}-reasoning`
    let started = false
    let reasoningStarted = false
    let text = ''
    let reasoning = ''
    let finish: 'stop' | 'tool_calls' | undefined
    let state: JsonValue | undefined
    const calls: ApiToolCall[] = []
    // Per-delta redaction misses a secret split across two chunks. Redact a
    // rolling window instead: only the unemitted tail is scanned, holding
    // back enough to cover the longest secret still possibly mid-arrival.
    // (Redacting the full accumulated text per delta was O(n²) — hundreds of
    // MB of scanning on a long response.) The held-back tail is safe to keep
    // in redacted form: complete secrets are already replaced, and a partial
    // secret at the very end is untouched by redaction so it still matches
    // once the rest arrives.
    const holdback =
      this.#secrets.length > 0 ? Math.max(...this.#secrets.map((secret) => secret.length)) - 1 : 0
    let pendingText = ''
    let pendingReasoning = ''
    const safeDelta = (pending: string): RedactedDelta => {
      const redacted = this.#redact(pending)
      const safe = Math.max(0, redacted.length - holdback)
      return { chunk: redacted.slice(0, safe), pending: redacted.slice(safe) }
    }
    for await (const event of this.#transport({
      model: this.#model,
      messages: this.#messages,
      tools: this.#tools,
      signal,
    })) {
      if (event.type === 'text') {
        if (!started) {
          started = true
          this.#startItem({
            id: itemId,
            turnId,
            type: 'message',
            role: 'assistant',
            status: 'started',
            text: '',
            createdAt: Date.now(),
          })
        }
        const step = safeDelta(pendingText + event.delta)
        pendingText = step.pending
        text += step.chunk
        if (step.chunk) {
          this.emit('event', { type: 'item.delta', turnId, itemId, textDelta: step.chunk })
        }
      } else if (event.type === 'reasoning') {
        if (!reasoningStarted) {
          reasoningStarted = true
          this.#startItem({
            id: reasoningId,
            turnId,
            type: 'reasoning',
            status: 'started',
            text: '',
            createdAt: Date.now(),
          })
        }
        const step = safeDelta(pendingReasoning + event.delta)
        pendingReasoning = step.pending
        reasoning += step.chunk
        if (step.chunk) {
          this.emit('event', {
            type: 'item.delta',
            turnId,
            itemId: reasoningId,
            textDelta: step.chunk,
          })
        }
      } else if (event.type === 'tool_call') {
        calls.push(event.call)
      } else if (event.type === 'usage') {
        this.emit('event', {
          type: 'usage.updated',
          usage: { ...event.usage, model: this.#model },
        })
      } else if (event.type === 'state') {
        state = event.value
      } else if (event.type === 'finish') {
        finish = event.reason
      }
    }
    if (!finish) throw new Error('transport ended without a finish event')
    // The stream is over — nothing is mid-arrival, so the held-back tails can
    // be redacted one last time and emitted.
    const tailText = this.#redact(pendingText)
    if (tailText) {
      text += tailText
      if (started) this.emit('event', { type: 'item.delta', turnId, itemId, textDelta: tailText })
    }
    const tailReasoning = this.#redact(pendingReasoning)
    if (tailReasoning) {
      reasoning += tailReasoning
      if (reasoningStarted) {
        this.emit('event', {
          type: 'item.delta',
          turnId,
          itemId: reasoningId,
          textDelta: tailReasoning,
        })
      }
    }
    if (started) {
      this.#completeItem({
        id: itemId,
        turnId,
        type: 'message',
        role: 'assistant',
        phase: finish === 'tool_calls' ? 'commentary' : 'final_answer',
        status: 'completed',
        text,
        createdAt: Date.now(),
      })
    }
    if (reasoningStarted) {
      this.#completeItem({
        id: reasoningId,
        turnId,
        type: 'reasoning',
        status: 'completed',
        text: reasoning,
        createdAt: Date.now(),
      })
    }
    return { text, calls, finish, state }
  }

  async #runTool(turnId: string, call: ApiToolCall, signal: AbortSignal): Promise<void> {
    const itemId = `${turnId}-tool-${call.id}`
    const createdAt = Date.now()
    this.#startItem({
      id: itemId,
      turnId,
      type: 'tool_call',
      status: 'started',
      text: call.name,
      createdAt,
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
    this.#completeItem({
      id: itemId,
      turnId,
      type: 'tool_call',
      status: result.isError ? 'failed' : 'completed',
      text: `${call.name}\n${content}`,
      createdAt,
    })
  }

  #startItem(item: Item): void {
    this.#openItems.set(item.id, item)
    this.emit('event', { type: 'item.started', item })
  }

  #completeItem(item: Item): void {
    this.#openItems.delete(item.id)
    this.emit('event', { type: 'item.completed', item })
  }

  #finishOpenItems(status: 'completed' | 'failed'): void {
    for (const item of this.#openItems.values()) {
      const { text: _streamedText, ...started } = item
      this.emit('event', { type: 'item.completed', item: { ...started, status } })
    }
    this.#openItems.clear()
  }

  async #approved(call: ApiToolCall, signal: AbortSignal): Promise<boolean> {
    const review = this.#reviewTool(call)
    // Session approval is keyed on what the user actually reviewed — command
    // plus path plus reason — not on the tool name. Approving one `bash`
    // invocation must not silently approve every future one.
    const approvalKey = review
      ? `${call.name}\0${review.command ?? ''}\0${review.path ?? ''}\0${review.reason ?? ''}`
      : call.name
    if (!review || this.#approvedTools.has(approvalKey)) return true
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
    if (decision === 'approve-session') this.#approvedTools.add(approvalKey)
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
