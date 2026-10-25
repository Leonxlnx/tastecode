import type {
  ApprovalRequest,
  DomainEvent,
  Item,
  ThreadInboxStatus,
  UserInputRequest,
} from '@harness/contracts'
import type { Attention } from './sidebar-order.js'
import { emptyThread, type ThreadState } from './thread-state.js'
import { reduceEventLog } from './thread-store.js'

/**
 * What a chat in the Needs you band waits on, so its row can say it and the
 * sidebar peek can answer it (design lab prototype, sidebar direction A).
 *
 * Built from the same provider-neutral events the transcript reduces, so every
 * engine reads the same: an approval request, a question set, or a failure.
 * Nothing here runs per streamed delta. A chat is looked at once each time its
 * band status changes, and only while it is one of the band's first rows.
 */
export type NeedsYouAsk =
  | {
      kind: 'approval'
      request: ApprovalRequest
      /** Further approvals the same chat waits on; the chat itself shows them all. */
      more: number
      model?: string | undefined
    }
  | {
      kind: 'question'
      request: UserInputRequest
      more: number
      model?: string | undefined
    }
  | {
      kind: 'failure'
      /** The error the chat reported, when it reported one. */
      message?: string | undefined
      /** The newest command of the failed turn that exited non-zero. */
      command?: FailedCommand | undefined
      model?: string | undefined
    }
  /**
   * The chat no longer holds the request the band row was for. `reply` is set
   * when the answer went from this peek ("Allowed once"); absent, someone
   * answered it elsewhere.
   */
  | { kind: 'answered'; reply?: string | undefined }

export type FailedCommand = { command: string; exitCode: number; tail: string[] }

export type NeedsYouAskState =
  | { status: 'loading' }
  | { status: 'ready'; ask: NeedsYouAsk }
  | { status: 'error'; message: string }

/** One band row the asks are kept for. `since` changes whenever its status does. */
export type NeedsYouAskTarget = { id: string; attention: Attention; since: number }

export type NeedsYouAskSource = {
  /** The renderer's own state of a chat it has heard from, if it still keeps one. */
  live(threadId: string): ThreadState | undefined
  /** The newest whole turn of a chat's history, with the requests it still holds open. */
  readNewest(threadId: string): Promise<ReadonlyArray<{ seq?: number; event: DomainEvent }>>
}

/** The band shows at most five rows before "+N more"; no more are ever read. */
export const MAX_ASK_TARGETS = 5
/** Chats whose ask is remembered from their own event; the oldest goes first. */
const MAX_CAPTURED = 32
const TAIL_LINES = 3

type Entry = { key: string; state: NeedsYouAskState; read: number }

/**
 * A small cache of asks for the band's chats, read through `useSyncExternalStore`.
 * The open chat never reaches it: the band leaves the open chat out, and its own
 * store already holds whatever it asks.
 */
export class NeedsYouAsks {
  #entries = new Map<string, Entry>()
  /** What a chat asked when its own event put it in the band, kept past the renderer's cache of it. */
  #captured = new Map<string, { attention: Attention; ask: NeedsYouAsk }>()
  #listeners = new Set<() => void>()
  #reads = 0

  constructor(private readonly source: NeedsYouAskSource) {}

  /**
   * Called with a chat's state when one of its events changes what it waits
   * for (never per delta). The renderer drops inactive chats' transcripts
   * soon after, so the ask is taken while the state still holds it.
   */
  capture(threadId: string, state: ThreadState, attention: Attention | undefined): void {
    const ask = attention ? askFromState(state, attention) : undefined
    if (
      !attention ||
      !ask ||
      ask.kind === 'answered' ||
      (ask.kind === 'failure' && !ask.message && !ask.command)
    ) {
      this.#captured.delete(threadId)
      return
    }
    this.#captured.delete(threadId)
    this.#captured.set(threadId, { attention, ask })
    if (this.#captured.size > MAX_CAPTURED) {
      const oldest = this.#captured.keys().next().value
      if (oldest !== undefined) this.#captured.delete(oldest)
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get = (threadId: string): NeedsYouAskState | undefined => this.#entries.get(threadId)?.state

  /**
   * Keeps an ask for each target and forgets every other chat. A target is
   * looked at again only when its attention or the time it changed moved.
   */
  sync(targets: readonly NeedsYouAskTarget[]): void {
    const kept = new Set<string>()
    let changed = false
    // The band's first rows, plus a folded one the peek was moved to.
    for (const target of targets.slice(0, MAX_ASK_TARGETS + 1)) {
      kept.add(target.id)
      if (this.#entries.get(target.id)?.key === targetKey(target)) continue
      void this.#load(target, { fresh: false, quiet: false })
      changed = true
    }
    // Deleting the entry being visited is safe while iterating a Map.
    for (const id of this.#entries.keys()) {
      if (kept.has(id)) continue
      this.#entries.delete(id)
      changed = true
    }
    if (changed) this.#emit()
  }

  /**
   * Reads the chat's newest page again, for "Try again" and for the check made
   * right before an answer is sent: a request answered elsewhere must not get
   * a second answer that the agent would silently drop. `quiet` keeps the row
   * as it is while the check runs.
   */
  async refresh(target: NeedsYouAskTarget, quiet = false): Promise<NeedsYouAskState> {
    const pending = this.#load(target, { fresh: true, quiet })
    this.#emit()
    return (await pending) ?? this.#entries.get(target.id)?.state ?? { status: 'loading' }
  }

  /** Records an answer sent from the peek, so the row stops offering it. */
  settle(threadId: string, reply: string): void {
    const entry = this.#entries.get(threadId)
    if (!entry) return
    this.#entries.set(threadId, {
      ...entry,
      read: ++this.#reads,
      state: { status: 'ready', ask: { kind: 'answered', reply } },
    })
    this.#emit()
  }

  #load(
    target: NeedsYouAskTarget,
    options: { fresh: boolean; quiet: boolean },
  ): Promise<NeedsYouAskState> | undefined {
    const key = targetKey(target)
    const read = ++this.#reads
    const known = options.fresh ? undefined : this.#known(target)
    // A failure is never read from the server: reading a chat's history marks
    // it read there, which is exactly what takes a failure out of the band.
    if (target.attention === 'failed') {
      const previous = this.#entries.get(target.id)
      const state: NeedsYouAskState =
        options.fresh && previous?.state.status === 'ready'
          ? previous.state
          : { status: 'ready', ask: known ?? { kind: 'failure' } }
      this.#entries.set(target.id, { key, read, state })
      return undefined
    }
    // Live state counts only when it holds the request. A chat the renderer
    // heard from only in part says nothing about what it does not hold.
    if (known && known.kind !== 'answered') {
      this.#entries.set(target.id, { key, read, state: { status: 'ready', ask: known } })
      return undefined
    }
    const previous = this.#entries.get(target.id)
    this.#entries.set(target.id, {
      key,
      read,
      state: options.quiet && previous ? previous.state : { status: 'loading' },
    })
    return this.source.readNewest(target.id).then(
      (events) =>
        this.#settleRead(target.id, read, {
          status: 'ready',
          ask: askFromState(reduceEventLog(emptyThread, events), target.attention),
        }),
      (error: unknown) =>
        this.#settleRead(target.id, read, {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
    )
  }

  /** The renderer's own state when it holds the request, else what the chat's event left. */
  #known(target: NeedsYouAskTarget): NeedsYouAsk | undefined {
    const live = this.source.live(target.id)
    const fromLive = live ? askFromState(live, target.attention) : undefined
    if (fromLive && fromLive.kind !== 'answered') {
      if (fromLive.kind !== 'failure' || fromLive.message || fromLive.command) return fromLive
    }
    const captured = this.#captured.get(target.id)
    return captured?.attention === target.attention ? captured.ask : fromLive
  }

  #settleRead(threadId: string, read: number, state: NeedsYouAskState): NeedsYouAskState {
    const entry = this.#entries.get(threadId)
    // A newer status or a newer read owns the row now; the caller still learns
    // what this read found.
    if (!entry || entry.read !== read) return state
    this.#entries.set(threadId, { ...entry, state })
    this.#emit()
    return state
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

function targetKey(target: NeedsYouAskTarget): string {
  return `${target.attention}:${target.since}`
}

/**
 * The ask a chat's state holds for the reason it is in the band. Approvals and
 * questions are the open requests (oldest first, as the chat lists them); a
 * request with no open entry left was answered somewhere else.
 */
export function askFromState(state: ThreadState, attention: Attention): NeedsYouAsk {
  const model = state.usage?.model
  if (attention === 'approval') {
    const [request, ...rest] = state.approvals
    return request ? { kind: 'approval', request, more: rest.length, model } : { kind: 'answered' }
  }
  if (attention === 'input') {
    const [request, ...rest] = state.userInputs
    return request ? { kind: 'question', request, more: rest.length, model } : { kind: 'answered' }
  }
  return {
    kind: 'failure',
    message: state.error?.message,
    command: lastFailedCommand(state.items),
    model,
  }
}

/** The newest command of the last turn that exited with an error, if any. */
function lastFailedCommand(items: readonly Item[]): FailedCommand | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.type === 'message' && item.role === 'user') return undefined
    if (item.type !== 'command' || !item.command) continue
    if (item.exitCode === undefined || item.exitCode === 0) continue
    return { command: item.command, exitCode: item.exitCode, tail: lastLines(item.text) }
  }
  return undefined
}

function lastLines(text: string | undefined): string[] {
  if (!text) return []
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  return lines.slice(-TAIL_LINES)
}

/** The second line of a band row: a verb, then what it is about. */
export type AskLine = { verb: string; object?: string | undefined; code?: boolean }

export function askLine(state: NeedsYouAskState | undefined, attention: Attention): AskLine {
  if (state?.status === 'ready') {
    const { ask } = state
    switch (ask.kind) {
      case 'approval':
        return approvalLine(ask.request)
      case 'question': {
        const question = ask.request.questions[0]
        return { verb: 'Answer', object: question?.question ?? question?.header }
      }
      case 'failure':
        if (ask.command) return { verb: 'Failed', object: ask.command.command, code: true }
        return { verb: 'Failed', object: firstLine(ask.message) }
      case 'answered':
        return { verb: ask.reply ?? 'Already answered' }
    }
  }
  if (state?.status === 'loading') return { verb: 'Reading…' }
  switch (attention) {
    case 'approval':
      return { verb: 'Waiting for approval' }
    case 'input':
      return { verb: 'Waiting for an answer' }
    case 'failed':
      return { verb: 'Failed' }
  }
}

function approvalLine(request: ApprovalRequest): AskLine {
  switch (request.kind) {
    case 'command':
      return request.command
        ? { verb: 'Approve', object: firstLine(request.command), code: true }
        : { verb: 'Approve a command' }
    case 'file_change':
      return request.path
        ? { verb: 'Approve edit', object: request.path, code: true }
        : { verb: 'Approve a file change' }
    case 'permissions':
      return { verb: 'Approve extra access' }
  }
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split(/\r?\n/).find((part) => part.trim() !== '')
  return line?.trim()
}

/**
 * A request is only open inside a running turn. A chat this window never
 * loaded does not know that its turn runs, so a request answered from the
 * peek (or in another window) would read as idle, and its row would show a
 * time where the spinner belongs. It is working until its turn says it ended.
 */
export function statusAfterRequest(
  previous: ThreadInboxStatus,
  next: ThreadInboxStatus,
  event: DomainEvent,
): ThreadInboxStatus {
  const answered = event.type === 'approval.resolved' || event.type === 'user_input.resolved'
  return answered && next === 'idle' && (previous === 'approval' || previous === 'input')
    ? 'working'
    : next
}

/** The peek answers only what it can show in full and answer safely. */
export function questionAnswerable(request: UserInputRequest): boolean {
  return request.questions.every((question) => !question.secret && !question.multiSelect)
}
