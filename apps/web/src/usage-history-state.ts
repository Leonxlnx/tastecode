import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ParamsOf, ResultOf, UsageHistoryRange, UsageHistoryTotals } from '@harness/contracts'
import { IndeterminateRequestError, type Transport } from './transport.js'

type History = ResultOf<'usage.history'>
type LoadHistory = (params: ParamsOf<'usage.history'>) => Promise<History>

export type UsageHistoryState = {
  /** The last result for this range. A later failure or refresh keeps it. */
  data: History | undefined
  /** A read of this range is running or about to start. */
  loading: boolean
  /** Why the last read failed; cleared when the next one starts. */
  error: string | undefined
}

/** Whether the page can be seen, so polling stops while it cannot. */
export type PageVisibility = {
  hidden(): boolean
  subscribe(listener: () => void): () => void
}

export type UsageHistoryOptions = {
  /** First wait between reads while the server is still indexing. */
  pollMs?: number
  /** Longest wait a long scan backs off to. */
  maxPollMs?: number
  /** A result younger than this is shown again without asking the server. */
  freshMs?: number
  visibility?: PageVisibility
  now?: () => number
}

type Entry = {
  state: UsageHistoryState
  watchers: number
  /** The read whose answer this entry is waiting for. */
  request: number | undefined
  loadedAt: number
  timer: ReturnType<typeof setTimeout> | undefined
  /** Reads of a running scan so far; each one waits a little longer. */
  polls: number
  /** A read came due while the page was hidden. */
  due: boolean
  /** An unconfirmed failure is retried once before it is shown. */
  retried: boolean
  /** A rescan asked for while another read was running. */
  pendingRefresh: boolean
}

const POLL_MS = 2_000
const MAX_POLL_MS = 10_000
const FRESH_MS = 5_000
const BACKOFF = 1.5

const INITIAL: UsageHistoryState = Object.freeze({
  data: undefined,
  loading: true,
  error: undefined,
})

const documentVisibility: PageVisibility = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  subscribe: (listener) => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

/**
 * One owner of the local usage history for every page that shows it.
 *
 * Results are kept per range, so Usage and Profile, or a range picked again,
 * paint from the last answer at once. While the server is still indexing, the
 * pages that watch a range poll it every 2 s, backing off to 10 s, and not at
 * all while the window is hidden or nothing watches.
 */
export class UsageHistoryController {
  readonly #load: LoadHistory
  readonly #pollMs: number
  readonly #maxPollMs: number
  readonly #freshMs: number
  readonly #visibility: PageVisibility
  readonly #now: () => number
  readonly #entries = new Map<UsageHistoryRange, Entry>()
  readonly #listeners = new Set<() => void>()
  #watchers = 0
  #stopVisibility: (() => void) | undefined
  #nextRequest = 0
  #disposed = false

  constructor(load: LoadHistory, options: UsageHistoryOptions = {}) {
    this.#load = load
    this.#pollMs = options.pollMs ?? POLL_MS
    this.#maxPollMs = options.maxPollMs ?? MAX_POLL_MS
    this.#freshMs = options.freshMs ?? FRESH_MS
    this.#visibility = options.visibility ?? documentVisibility
    this.#now = options.now ?? Date.now
  }

  snapshot(range: UsageHistoryRange): UsageHistoryState {
    return this.#entries.get(range)?.state ?? INITIAL
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** A page shows `range` until the returned release is called. */
  watch(range: UsageHistoryRange): () => void {
    if (this.#disposed) return () => {}
    const entry = this.#entry(range)
    entry.watchers += 1
    this.#watchers += 1
    this.#stopVisibility ??= this.#visibility.subscribe(() => this.#visibilityChanged())
    if (entry.request === undefined && entry.timer === undefined && this.#needsRead(entry)) {
      this.#read(range, false)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      entry.watchers -= 1
      this.#watchers -= 1
      if (entry.watchers === 0) {
        this.#clearTimer(entry)
        entry.due = false
      }
      if (this.#watchers === 0) {
        this.#stopVisibility?.()
        this.#stopVisibility = undefined
      }
    }
  }

  /** Asks the server to look for new local usage, after any read already running. */
  refresh(range: UsageHistoryRange): void {
    if (this.#disposed) return
    const entry = this.#entry(range)
    entry.polls = 0
    if (entry.request !== undefined) {
      entry.pendingRefresh = true
      return
    }
    this.#read(range, true)
  }

  dispose(): void {
    this.#disposed = true
    for (const entry of this.#entries.values()) {
      this.#clearTimer(entry)
      entry.request = undefined
    }
    this.#stopVisibility?.()
    this.#stopVisibility = undefined
    this.#listeners.clear()
  }

  #needsRead(entry: Entry): boolean {
    const { data, error, loading } = entry.state
    return (
      entry.due ||
      // A quiet retry was waiting when the last page left.
      loading ||
      !data ||
      error !== undefined ||
      data.scan.status === 'scanning' ||
      this.#now() - entry.loadedAt >= this.#freshMs
    )
  }

  #read(range: UsageHistoryRange, refresh: boolean): void {
    const entry = this.#entry(range)
    this.#clearTimer(entry)
    entry.due = false
    entry.pendingRefresh = false
    const request = ++this.#nextRequest
    entry.request = request
    this.#set(entry, { data: entry.state.data, loading: true, error: undefined })
    let answer: Promise<History>
    try {
      answer = this.#load({ range, ...(refresh ? { refresh: true } : {}) })
    } catch (error) {
      answer = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    void answer.then(
      (data) => {
        if (this.#disposed || entry.request !== request) return
        entry.request = undefined
        entry.loadedAt = this.#now()
        entry.retried = false
        this.#set(entry, { data, loading: false, error: undefined })
        if (entry.pendingRefresh) {
          this.#read(range, true)
        } else if (data.scan.status === 'scanning') {
          this.#schedulePoll(range, entry)
        } else {
          entry.polls = 0
        }
      },
      (error: unknown) => {
        if (this.#disposed || entry.request !== request) return
        entry.request = undefined
        if (entry.pendingRefresh) {
          this.#read(range, true)
          return
        }
        // A dropped connection may have answered after all: retry once, quietly.
        if (error instanceof IndeterminateRequestError && !entry.retried && entry.watchers > 0) {
          entry.retried = true
          this.#schedule(range, entry, this.#pollMs)
          return
        }
        entry.retried = false
        const data = entry.state.data
        this.#set(entry, {
          data,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
        // A failed read does not stop following a scan that is still running.
        if (data?.scan.status === 'scanning') this.#schedulePoll(range, entry)
      },
    )
  }

  #schedulePoll(range: UsageHistoryRange, entry: Entry): void {
    const delay = Math.min(this.#pollMs * BACKOFF ** entry.polls, this.#maxPollMs)
    entry.polls += 1
    this.#schedule(range, entry, delay)
  }

  #schedule(range: UsageHistoryRange, entry: Entry, delay: number): void {
    this.#clearTimer(entry)
    if (this.#disposed || entry.watchers === 0) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (this.#disposed || entry.watchers === 0) return
      if (this.#visibility.hidden()) {
        entry.due = true
        return
      }
      this.#read(range, false)
    }, delay)
  }

  #visibilityChanged(): void {
    if (this.#disposed || this.#visibility.hidden()) return
    for (const [range, entry] of this.#entries) {
      if (entry.due && entry.watchers > 0 && entry.request === undefined) this.#read(range, false)
    }
  }

  #entry(range: UsageHistoryRange): Entry {
    let entry = this.#entries.get(range)
    if (!entry) {
      entry = {
        state: INITIAL,
        watchers: 0,
        request: undefined,
        loadedAt: 0,
        timer: undefined,
        polls: 0,
        due: false,
        retried: false,
        pendingRefresh: false,
      }
      this.#entries.set(range, entry)
    }
    return entry
  }

  #set(entry: Entry, state: UsageHistoryState): void {
    const current = entry.state
    if (
      current.data === state.data &&
      current.loading === state.loading &&
      current.error === state.error
    ) {
      return
    }
    entry.state = state
    for (const listener of this.#listeners) listener()
  }

  #clearTimer(entry: Entry): void {
    clearTimeout(entry.timer)
    entry.timer = undefined
  }
}

const controllers = new WeakMap<Transport, UsageHistoryController>()

/** The history owner shared by every page on this connection. */
export function usageHistoryController(transport: Transport): UsageHistoryController {
  let controller = controllers.get(transport)
  if (!controller) {
    controller = new UsageHistoryController((params) => transport.request('usage.history', params))
    controllers.set(transport, controller)
  }
  return controller
}

/**
 * The history for `range`. While a range with no answer yet loads, the last
 * range this page showed stays up instead of a blank loading state.
 */
export function useUsageHistory(transport: Transport, range: UsageHistoryRange) {
  const controller = usageHistoryController(transport)
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  )
  const read = useCallback(() => controller.snapshot(range), [controller, range])
  const state = useSyncExternalStore(subscribe, read, read)
  useEffect(() => controller.watch(range), [controller, range])
  const refresh = useCallback(() => controller.refresh(range), [controller, range])

  const shown = useRef<History | undefined>(undefined)
  useEffect(() => {
    if (state.data) shown.current = state.data
  }, [state.data])
  const data = state.data ?? (state.loading ? shown.current : undefined)
  return { data, loading: state.loading, error: state.error, refresh }
}

/** Share of input read from a provider's cache, counting cache writes as input. */
export function cacheHitRate(totals: UsageHistoryTotals): number | undefined {
  const input = totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheWriteInputTokens
  return input > 0 ? totals.cachedInputTokens / input : undefined
}
