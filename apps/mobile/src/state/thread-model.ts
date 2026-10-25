import type {
  ApprovalMode,
  ApprovalRequest,
  DomainEvent,
  Item,
  PlanStep,
  Usage,
  UserInputRequest,
} from '@harness/contracts'

/** What a chat screen renders. Rebuilt at most a few times a second while a reply streams. */
export type ThreadView = {
  items: readonly Item[]
  running: boolean
  activeTurnId: string | undefined
  /** When each turn started and ended, in server time. */
  turnStarted: Readonly<Record<string, number>>
  turnEnded: Readonly<Record<string, number>>
  plan: readonly PlanStep[]
  approvals: readonly ApprovalRequest[]
  userInputs: readonly UserInputRequest[]
  usage: Usage | undefined
  /** The model the provider last reported working with. */
  model: string | undefined
  error: string | undefined
}

export const LOCAL_PREFIX = 'local:'

/**
 * Folds the server's event log into a transcript, the same rules as the
 * desktop's reducer: an item is identified by its id, deltas append to the item
 * that is still streaming, and a completed item is never reopened.
 */
export class ThreadModel {
  #items: Item[] = []
  #index = new Map<string, number>()
  #running = false
  #activeTurnId: string | undefined
  #turnStarted: Record<string, number> = {}
  #turnEnded: Record<string, number> = {}
  #plan: PlanStep[] = []
  #approvals: ApprovalRequest[] = []
  #userInputs: UserInputRequest[] = []
  #usage: Usage | undefined
  #model: string | undefined
  #error: string | undefined
  #view: ThreadView | undefined

  apply(event: DomainEvent): void {
    this.#view = undefined
    switch (event.type) {
      case 'turn.started':
        this.#running = true
        this.#activeTurnId = event.turn.id
        this.#turnStarted = { ...this.#turnStarted, [event.turn.id]: event.turn.createdAt }
        this.#plan = []
        this.#error = undefined
        return
      case 'turn.completed':
        this.#running = false
        this.#activeTurnId = undefined
        this.#approvals = []
        if (event.completedAt !== undefined) {
          this.#turnEnded = { ...this.#turnEnded, [event.turnId]: event.completedAt }
        }
        this.#settleStreaming(event.turnId)
        return
      case 'item.started':
        this.#start(event.item)
        return
      case 'item.delta':
        this.#delta(event.itemId, event.turnId, event.textDelta)
        return
      case 'item.completed':
        this.#complete(event.item)
        if (event.item.type === 'error') this.#error = event.item.text
        return
      case 'thread.error':
        this.#running = false
        this.#activeTurnId = undefined
        this.#approvals = []
        this.#userInputs = []
        this.#error = event.message
        this.#append({
          id: `error:${this.#items.length}:${event.message.length}`,
          turnId: '',
          type: 'error',
          status: 'completed',
          text: event.message,
          createdAt: Date.now(),
        })
        return
      case 'plan.updated':
        this.#plan = event.steps
        return
      case 'usage.updated':
        this.#usage = event.usage
        if (event.usage.model) this.#model = event.usage.model
        return
      case 'approval.requested':
        if (!this.#approvals.some((request) => request.id === event.request.id)) {
          this.#approvals = [...this.#approvals, event.request]
        }
        return
      case 'approval.resolved':
        this.#approvals = this.#approvals.filter((request) => request.id !== event.id)
        return
      case 'user_input.requested':
        if (!this.#userInputs.some((request) => request.id === event.request.id)) {
          this.#userInputs = [...this.#userInputs, event.request]
        }
        return
      case 'user_input.resolved':
        this.#userInputs = this.#userInputs.filter((request) => request.id !== event.id)
        return
      default:
        return
    }
  }

  /** Older turns from a backward page, placed before everything already shown. */
  prepend(older: ThreadModel): void {
    this.#view = undefined
    const known = new Set(this.#items.map((item) => item.id))
    this.#items = [...older.#items.filter((item) => !known.has(item.id)), ...this.#items]
    this.#reindex()
    this.#turnStarted = { ...older.#turnStarted, ...this.#turnStarted }
    this.#turnEnded = { ...older.#turnEnded, ...this.#turnEnded }
    this.#model ??= older.#model
  }

  /** The prompt the phone just sent, shown before the computer confirms it. */
  addLocalMessage(id: string, text: string, attachments: string[]): void {
    this.#view = undefined
    this.#append({
      id,
      turnId: '',
      type: 'message',
      role: 'user',
      status: 'completed',
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: Date.now(),
    })
  }

  removeLocalMessage(id: string): void {
    const index = this.#index.get(id)
    if (index === undefined || !id.startsWith(LOCAL_PREFIX)) return
    this.#view = undefined
    this.#items = this.#items.filter((item) => item.id !== id)
    this.#reindex()
  }

  /** Accepts the server's running flag after a history read. */
  setRunning(running: boolean): void {
    if (this.#running === running) return
    this.#view = undefined
    this.#running = running
    if (!running) this.#activeTurnId = undefined
  }

  view(): ThreadView {
    this.#view ??= {
      items: this.#items.slice(),
      running: this.#running,
      activeTurnId: this.#activeTurnId,
      turnStarted: this.#turnStarted,
      turnEnded: this.#turnEnded,
      plan: this.#plan,
      approvals: this.#approvals,
      userInputs: this.#userInputs,
      usage: this.#usage,
      model: this.#model,
      error: this.#error,
    }
    return this.#view
  }

  #append(item: Item): void {
    this.#index.set(item.id, this.#items.length)
    this.#items.push(item)
  }

  #start(item: Item): void {
    const index = this.#index.get(item.id)
    if (index === undefined) {
      this.#append(item)
      return
    }
    const existing = this.#items[index]!
    const local = existing.id.startsWith(LOCAL_PREFIX) && existing.turnId === ''
    // Completion is final; a late or replayed start never reopens finished work.
    if (!local && existing.status !== 'started') return
    this.#items[index] = {
      ...item,
      ...(!item.text && existing.text ? { text: existing.text } : {}),
    }
  }

  #delta(itemId: string, turnId: string, text: string): void {
    const index = this.#index.get(itemId)
    if (index === undefined) {
      if (this.#activeTurnId && turnId !== this.#activeTurnId) return
      this.#append({
        id: itemId,
        turnId: this.#activeTurnId ?? turnId,
        type: 'message',
        status: 'started',
        role: 'assistant',
        text,
        createdAt: Date.now(),
      })
      return
    }
    const existing = this.#items[index]!
    if (existing.status !== 'started') return
    this.#items[index] = { ...existing, text: (existing.text ?? '') + text }
  }

  #complete(item: Item): void {
    const index = this.#index.get(item.id)
    if (index === undefined) {
      this.#append(item)
      return
    }
    const streamed = this.#items[index]!.text
    // A completion without text keeps what streamed in.
    this.#items[index] = { ...item, ...(!item.text && streamed ? { text: streamed } : {}) }
  }

  /** Items a provider never completed stop looking live once their turn ends. */
  #settleStreaming(turnId: string): void {
    for (let index = 0; index < this.#items.length; index += 1) {
      const item = this.#items[index]!
      if (item.status === 'started' && item.turnId === turnId) {
        this.#items[index] = { ...item, status: 'completed' }
      }
    }
  }

  #reindex(): void {
    this.#index = new Map(this.#items.map((item, position) => [item.id, position]))
  }
}

export type HistoryEntry = { seq: number; event: DomainEvent }

export function modelFrom(entries: readonly HistoryEntry[]): ThreadModel {
  const model = new ThreadModel()
  for (const entry of entries) model.apply(entry.event)
  return model
}

export function approvalModeOr(mode: ApprovalMode | undefined): ApprovalMode {
  return mode ?? 'ask'
}
