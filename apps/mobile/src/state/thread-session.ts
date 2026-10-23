import type {
  ApprovalDecision,
  ApprovalMode,
  DomainEvent,
  QueuedTurn,
  ResultOf,
} from '@harness/contracts'
import type { Connection } from '../link/connection'
import { IndeterminateError } from '../link/errors'
import { Store } from '../store'
import {
  LOCAL_PREFIX,
  modelFrom,
  ThreadModel,
  type HistoryEntry,
  type ThreadView,
} from './thread-model'

export type ThreadScreenState = {
  status: 'loading' | 'ready' | 'error'
  error: string | undefined
  view: ThreadView
  /** The access level the chat resumes with. */
  approval: ApprovalMode
  /** Absent once the whole history is loaded. */
  olderCursor: string | undefined
  loadingOlder: boolean
  queue: readonly QueuedTurn[]
  /** Queued prompts the computer has not confirmed yet; they show but cannot be acted on. */
  unconfirmed: ReadonlySet<string>
  canSteer: boolean
}

/** Whole turns in the first page; older turns load when asked. */
const NEWEST_TURNS = 12
const OLDER_TURNS = 20
/** Streamed text reaches the screen at most this often. */
const DELTA_FRAME_MS = 60

export type TurnOptions = { model?: string; effort?: string; serviceTier?: string }

/**
 * One open chat: its transcript as the computer has it, kept current from the
 * live event stream and caught up after any gap. Both the phone and the
 * desktop write to the same server-side chat, so what either sends shows up
 * here in order.
 */
export class ThreadSession {
  readonly state: Store<ThreadScreenState>
  #model = new ThreadModel()
  /** Prompts queued from here whose `thread.sendTurn` has not answered yet. */
  #sending = new Map<string, QueuedTurn>()
  #lastSeq = 0
  /** Live events that arrive while a full read is in flight. */
  #buffer: HistoryEntry[] | undefined
  #frame: ReturnType<typeof setTimeout> | undefined
  #subscriptions: Array<() => void> = []
  #loading: Promise<void> | undefined

  constructor(
    readonly threadId: string,
    private readonly connection: Connection,
  ) {
    this.state = new Store<ThreadScreenState>({
      status: 'loading',
      error: undefined,
      view: this.#model.view(),
      approval: 'ask',
      olderCursor: undefined,
      loadingOlder: false,
      queue: [],
      unconfirmed: new Set(),
      canSteer: false,
    })
    this.#subscriptions.push(
      connection.on('thread.event', ({ threadId, event, seq }) => {
        if (threadId === this.threadId) this.#receive(event, seq)
      }),
      connection.on('thread.queue', ({ threadId, items, canSteer }) => {
        if (threadId === this.threadId) this.#listQueue(items, canSteer)
      }),
      connection.on('providerHistory.changed', ({ threadIds }) => {
        if (threadIds.includes(this.threadId)) void this.load()
      }),
      connection.onOpen(() => void this.resync()),
      connection.onGap(() => void this.resync()),
    )
    void this.load()
    void this.#readQueue()
  }

  dispose(): void {
    clearTimeout(this.#frame)
    for (const unsubscribe of this.#subscriptions) unsubscribe()
    this.#subscriptions = []
  }

  /** Reads the newest turns, replacing whatever is shown. */
  load(): Promise<void> {
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined
    })
    return this.#loading
  }

  async #load(): Promise<void> {
    this.#buffer = []
    try {
      const result = await this.connection.request('thread.history', {
        threadId: this.threadId,
        page: { turnLimit: NEWEST_TURNS },
      })
      this.#adopt(result)
    } catch (error) {
      const buffered = this.#buffer
      this.#buffer = undefined
      // Keep what is on screen; live events that arrived meanwhile still apply.
      for (const entry of buffered ?? []) this.#apply(entry.event, entry.seq)
      this.#patch({
        status: this.state.get().status === 'ready' ? 'ready' : 'error',
        error: message(error),
      })
    }
  }

  #adopt(result: ResultOf<'thread.history'>): void {
    const model = modelFrom(result.events)
    const local = this.#model
      .view()
      .items.filter((item) => item.id.startsWith(LOCAL_PREFIX) && item.turnId === '')
    let lastSeq = result.page?.snapshotSeq ?? 0
    for (const entry of result.events) lastSeq = Math.max(lastSeq, entry.seq)
    model.setRunning(result.running)
    const buffered = this.#buffer ?? []
    this.#buffer = undefined
    this.#model = model
    this.#lastSeq = lastSeq
    for (const entry of buffered) this.#apply(entry.event, entry.seq)
    // A prompt sent while this read was in flight stays until the computer confirms it.
    for (const item of local) {
      if (!model.view().items.some((existing) => existing.id === item.id)) {
        model.addLocalMessage(item.id, item.text ?? '', item.attachments ?? [])
      }
    }
    this.#patch({
      status: 'ready',
      error: undefined,
      view: this.#model.view(),
      approval: result.approval ?? 'ask',
      olderCursor: result.page?.olderCursor ?? undefined,
    })
  }

  /** Catches up after a reconnect or a missed push, without reloading what is shown. */
  async resync(): Promise<void> {
    if (this.state.get().status !== 'ready' || this.#loading) {
      await this.load()
      return
    }
    try {
      const result = await this.connection.request('thread.history', {
        threadId: this.threadId,
        afterSeq: this.#lastSeq,
      })
      if (result.reset) {
        await this.load()
        return
      }
      for (const entry of result.events) this.#apply(entry.event, entry.seq)
      this.#model.setRunning(result.running)
      this.#patch({
        view: this.#model.view(),
        approval: result.approval ?? this.state.get().approval,
      })
      void this.#readQueue()
    } catch {
      // The next open or gap tries again.
    }
  }

  async loadOlder(): Promise<void> {
    const { olderCursor, loadingOlder } = this.state.get()
    if (!olderCursor || loadingOlder) return
    this.#patch({ loadingOlder: true })
    try {
      const result = await this.connection.request('thread.history', {
        threadId: this.threadId,
        page: { before: olderCursor, turnLimit: OLDER_TURNS },
      })
      if (result.reset) {
        this.#patch({ loadingOlder: false })
        await this.load()
        return
      }
      this.#model.prepend(modelFrom(result.events))
      this.#patch({
        view: this.#model.view(),
        olderCursor: result.page?.olderCursor ?? undefined,
        loadingOlder: false,
      })
    } catch (error) {
      this.#patch({ loadingOlder: false, error: message(error) })
    }
  }

  /** Shows a prompt at once; the server's copy replaces it under the same id. */
  addLocalMessage(text: string, attachments: string[] = []): string {
    const id = `${LOCAL_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    this.#model.addLocalMessage(id, text, attachments)
    this.#patch({ view: this.#model.view() })
    return id
  }

  /**
   * Sends a prompt. While a turn runs the computer queues it behind that turn,
   * so it appears in the queue rather than the transcript.
   */
  async send(
    text: string,
    attachments: string[],
    options: TurnOptions,
    localId?: string,
  ): Promise<void> {
    const queued = this.#model.view().running
    const id =
      localId ??
      (queued
        ? `${LOCAL_PREFIX}${Date.now().toString(36)}`
        : this.addLocalMessage(text, attachments))
    // Queued behind the running turn: it shows in the queue at once, and the
    // computer's list replaces it when that arrives.
    if (queued) {
      const entry: QueuedTurn = { id, text, attachments, createdAt: Date.now() }
      this.#sending.set(id, entry)
      this.#patch({
        queue: [...this.state.get().queue, entry],
        unconfirmed: new Set(this.#sending.keys()),
      })
    }
    try {
      const result = await this.connection.request('thread.sendTurn', {
        threadId: this.threadId,
        text,
        clientSubmissionId: id,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      })
      if (this.#sending.delete(id)) this.#patch({ unconfirmed: new Set(this.#sending.keys()) })
      if (result.queued) {
        this.#model.removeLocalMessage(id)
        this.#patch({ view: this.#model.view() })
        void this.#readQueue()
      } else if (queued) {
        // The turn ended meanwhile, so the prompt ran instead of waiting.
        this.#dropQueued(id)
      }
    } catch (error) {
      if (this.#sending.delete(id)) this.#patch({ unconfirmed: new Set(this.#sending.keys()) })
      if (!(error instanceof IndeterminateError)) {
        this.#model.removeLocalMessage(id)
        this.#dropQueued(id)
        this.#patch({ view: this.#model.view() })
      }
      throw error
    }
  }

  async interrupt(): Promise<void> {
    await this.connection.request('thread.interrupt', { threadId: this.threadId })
  }

  async respondToApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    await this.connection.request('thread.respondToApproval', {
      threadId: this.threadId,
      approvalId,
      decision,
    })
  }

  async respondToUserInput(requestId: string, answers: Record<string, string[]>): Promise<void> {
    await this.connection.request('thread.respondToUserInput', {
      threadId: this.threadId,
      requestId,
      answers,
    })
  }

  async setApproval(approval: ApprovalMode): Promise<void> {
    const previous = this.state.get().approval
    this.#patch({ approval })
    try {
      await this.connection.request('thread.setApproval', { threadId: this.threadId, approval })
    } catch (error) {
      this.#patch({ approval: previous })
      throw error
    }
  }

  async steer(queuedTurnId: string): Promise<void> {
    await this.connection.request('thread.steerQueuedTurn', {
      threadId: this.threadId,
      queuedTurnId,
    })
  }

  /** Moves at once; the computer's answer or list puts it right if it disagrees. */
  async moveQueued(queuedTurnId: string, direction: 'up' | 'down'): Promise<void> {
    const queue = [...this.state.get().queue]
    const from = queue.findIndex((entry) => entry.id === queuedTurnId)
    const to = from + (direction === 'up' ? -1 : 1)
    if (from >= 0 && to >= 0 && to < queue.length) {
      ;[queue[from], queue[to]] = [queue[to]!, queue[from]!]
      this.#patch({ queue })
    }
    try {
      await this.connection.request('thread.moveQueuedTurn', {
        threadId: this.threadId,
        queuedTurnId,
        direction,
      })
    } catch (error) {
      void this.#readQueue()
      throw error
    }
  }

  /** Removes at once; a refusal brings the computer's list back. */
  async deleteQueued(queuedTurnId: string): Promise<void> {
    this.#dropQueued(queuedTurnId)
    try {
      await this.connection.request('thread.deleteQueuedTurn', {
        threadId: this.threadId,
        queuedTurnId,
      })
    } catch (error) {
      void this.#readQueue()
      throw error
    }
  }

  /** The computer's list, with prompts still on their way kept at its end. */
  #listQueue(items: readonly QueuedTurn[], canSteer: boolean): void {
    const listed = new Set(items.map((entry) => entry.id))
    const waiting = [...this.#sending.values()].filter((entry) => !listed.has(entry.id))
    this.#patch({ queue: [...items, ...waiting], canSteer })
  }

  #dropQueued(queuedTurnId: string): void {
    const queue = this.state.get().queue
    if (queue.some((entry) => entry.id === queuedTurnId)) {
      this.#patch({ queue: queue.filter((entry) => entry.id !== queuedTurnId) })
    }
  }

  async #readQueue(): Promise<void> {
    try {
      const { items, canSteer } = await this.connection.request('thread.queue', {
        threadId: this.threadId,
      })
      this.#listQueue(items, canSteer)
    } catch {
      // Queue pushes keep it current from here on.
    }
  }

  #receive(event: DomainEvent, seq: number | undefined): void {
    if (this.#buffer) {
      this.#buffer.push({ seq: seq ?? -1, event })
      return
    }
    if (!this.#apply(event, seq)) return
    if (event.type === 'item.delta') {
      this.#frame ??= setTimeout(() => {
        this.#frame = undefined
        this.#patch({ view: this.#model.view() })
      }, DELTA_FRAME_MS)
      return
    }
    clearTimeout(this.#frame)
    this.#frame = undefined
    this.#patch({ view: this.#model.view() })
  }

  /** Applies one event unless the transcript already holds it. */
  #apply(event: DomainEvent, seq: number | undefined): boolean {
    if (seq !== undefined && seq >= 0) {
      if (seq <= this.#lastSeq) return false
      this.#lastSeq = seq
    }
    this.#model.apply(event)
    return true
  }

  #patch(patch: Partial<ThreadScreenState>): void {
    this.state.set((current) => ({ ...current, ...patch }))
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Open chats stay subscribed while shown, and a few more for quick back-and-forth. */
export class ThreadSessions {
  #sessions = new Map<string, { session: ThreadSession; users: number; lastUsed: number }>()

  constructor(private readonly connection: Connection) {}

  acquire(threadId: string): ThreadSession {
    let entry = this.#sessions.get(threadId)
    if (!entry) {
      entry = { session: new ThreadSession(threadId, this.connection), users: 0, lastUsed: 0 }
      this.#sessions.set(threadId, entry)
    }
    entry.users += 1
    entry.lastUsed = Date.now()
    return entry.session
  }

  peek(threadId: string): ThreadSession | undefined {
    return this.#sessions.get(threadId)?.session
  }

  release(threadId: string): void {
    const entry = this.#sessions.get(threadId)
    if (!entry) return
    entry.users = Math.max(0, entry.users - 1)
    entry.lastUsed = Date.now()
    const idle = [...this.#sessions.entries()]
      .filter(([, candidate]) => candidate.users === 0)
      .sort(([, left], [, right]) => right.lastUsed - left.lastUsed)
    for (const [id, stale] of idle.slice(4)) {
      stale.session.dispose()
      this.#sessions.delete(id)
    }
  }

  clear(): void {
    for (const { session } of this.#sessions.values()) session.dispose()
    this.#sessions.clear()
  }
}
