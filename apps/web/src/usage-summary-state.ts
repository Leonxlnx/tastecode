import type {
  ParamsOf,
  ProviderId,
  ProviderLimitSource,
  ResultOf,
  UsageReadIntent,
} from '@harness/contracts'
import { errorMessage } from './boundary.js'

type Summary = ResultOf<'usage.summary'>
type Target = { provider: ProviderId; threadId?: string | undefined }

/** Token totals for a summary that so far holds only pushed limits. */
const NO_TOKENS: Summary['session'] = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
}

function withLimitSource(summary: Summary | undefined, source: ProviderLimitSource): Summary {
  return {
    session: summary?.session ?? NO_TOKENS,
    today: summary?.today ?? NO_TOKENS,
    limits: source.status === 'ready' ? source.limits : [],
    limitSource: source,
  }
}

/**
 * An answer that left the server before a pushed snapshot arrived can land
 * after it; it keeps the newer pushed limits and brings only its totals.
 */
function newerLimits(current: Summary | undefined, next: Summary): Summary {
  const held = current?.limitSource
  const answered = next.limitSource
  if (held?.status !== 'ready' || answered?.status !== 'ready') return next
  if ((held.checkedAt ?? 0) <= (answered.checkedAt ?? 0)) return next
  return withLimitSource(next, held)
}

/** An automatic retry after a failed read that left no values to show. */
export type UsageRetry = { attempt: number; of: number; message: string }

/**
 * `retry` is set while those retries run. `gaveUp` is set once they all failed;
 * later reads stay silent and a success brings the source back.
 */
type Retrying = { retry?: UsageRetry; gaveUp?: true }

export type UsageSummaryState =
  | ({ status: 'loading'; provider: ProviderId; summary?: Summary } & Retrying)
  | { status: 'ready'; provider: ProviderId; summary: Summary }
  | ({ status: 'error'; provider: ProviderId; message: string; summary?: Summary } & Retrying)

type LoadSummary = (params: ParamsOf<'usage.summary'>) => Promise<Summary>

const ERROR_MESSAGE_LIMIT = 300
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000]

function messageOf(error: Parameters<typeof errorMessage>[0]): string {
  const message = errorMessage(error, 'Plan limits could not be loaded.')
  return (message || 'Plan limits could not be loaded.').slice(0, ERROR_MESSAGE_LIMIT)
}

function sameTarget(left: Target | undefined, right: Target): boolean {
  return left?.provider === right.provider && left.threadId === right.threadId
}

function paramsOf(target: Target, intent: UsageReadIntent): ParamsOf<'usage.summary'> {
  return target.threadId
    ? { threadId: target.threadId, intent }
    : { provider: target.provider, intent }
}

/**
 * Owns the asynchronous account-usage state independently from React.
 *
 * One revision belongs to one provider/thread target. That makes stale reads
 * harmless and lets refresh failures retain useful last-known values. Plan
 * limits belong to the account, so they survive a switch between threads of
 * the same provider and are cleared only by a provider switch.
 */
export class UsageSummaryController {
  readonly #load: LoadSummary
  readonly #coalesceMs: number
  /** Why the next request is made unless a caller names a reason; see UsageReadIntent. */
  readonly #intent: () => UsageReadIntent
  readonly #retryDelaysMs: readonly number[]
  readonly #listeners = new Set<() => void>()
  #target: Target | undefined
  /** A reason a caller gave that the next request has not carried yet. */
  #requestedIntent: UsageReadIntent | undefined
  #state: UsageSummaryState | undefined
  #revision = 0
  #request: { revision: number; id: number } | undefined
  #nextRequestId = 0
  #dirty = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  /** Failed reads in a row that had no values to fall back on. */
  #failures = 0
  #disposed = false

  constructor(
    load: LoadSummary,
    coalesceMs = 100,
    intent: () => UsageReadIntent = () => 'visible',
    retryDelaysMs = RETRY_DELAYS_MS,
  ) {
    this.#load = load
    this.#coalesceMs = coalesceMs
    this.#intent = intent
    this.#retryDelaysMs = retryDelaysMs
  }

  snapshot(): UsageSummaryState | undefined {
    return this.#state
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** `ask: false` only holds the target, for values pushed without a request. */
  select(target: Target, ask = true): void {
    if (this.#disposed || sameTarget(this.#target, target)) return
    const sameProvider = this.#target?.provider === target.provider
    this.#revision += 1
    this.#target = target
    // The next read reports the same account's limits; until it lands, the
    // last ones stay on screen instead of reading as "Checking…" again.
    if (!sameProvider) this.#state = undefined
    this.#dirty = false
    this.#requestedIntent = undefined
    this.#failures = 0
    this.#clearTimer()
    if (ask) this.#start(this.#revision)
  }

  /** Manual retry, reconnect, and ordinary polling all use the same guarded path. */
  refresh(intent?: UsageReadIntent): void {
    if (this.#disposed || !this.#target) return
    // A retry is the strongest reason and survives a later, weaker one.
    if (intent && this.#requestedIntent !== 'retry') this.#requestedIntent = intent
    if (this.#request?.revision === this.#revision) {
      this.#dirty = true
      return
    }
    this.#dirty = false
    this.#clearTimer()
    this.#start(this.#revision)
  }

  /**
   * Takes a limit snapshot the server pushed for this provider, without a
   * request. A read in flight still shows as loading until it answers.
   */
  applySource(source: ProviderLimitSource): void {
    const target = this.#target
    if (this.#disposed || source.provider !== target?.provider) return
    const summary = withLimitSource(this.#state?.summary, source)
    this.#setState({
      status: this.#state?.status === 'loading' ? 'loading' : 'ready',
      provider: target.provider,
      summary,
    })
  }

  /** Ignore inactive providers and collapse a burst into one trailing read. */
  changed(provider: ProviderId): void {
    if (this.#disposed || provider !== this.#target?.provider) return
    this.#dirty = true
    this.#scheduleTrailing(this.#revision)
  }

  dispose(): void {
    this.#disposed = true
    this.#revision += 1
    this.#dirty = false
    this.#clearTimer()
    this.#clearRetryTimer()
    this.#listeners.clear()
  }

  #retrying(): Retrying {
    const state = this.#state
    if (state?.status === 'ready' || !state) return {}
    return {
      ...(state.retry ? { retry: state.retry } : {}),
      ...(state.gaveUp ? { gaveUp: state.gaveUp } : {}),
    }
  }

  /** A failed read with nothing to show retries a few times, then gives up quietly. */
  #failed(revision: number, message: string, summary: Summary | undefined): Retrying {
    if (summary && summary.limits.length > 0) return {}
    this.#failures += 1
    const delay = this.#retryDelaysMs[this.#failures - 1]
    if (delay === undefined) return { gaveUp: true }
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      if (revision === this.#revision) this.refresh()
    }, delay)
    return { retry: { attempt: this.#failures, of: this.#retryDelaysMs.length, message } }
  }

  #start(revision: number): void {
    const target = this.#target
    if (this.#disposed || revision !== this.#revision || !target) return
    const summary = this.#state?.summary
    this.#clearRetryTimer()
    this.#setState({
      status: 'loading',
      provider: target.provider,
      ...(summary ? { summary } : {}),
      ...this.#retrying(),
    })
    const request = { revision, id: ++this.#nextRequestId }
    this.#request = request
    const intent = this.#requestedIntent ?? this.#intent()
    this.#requestedIntent = undefined
    void Promise.resolve()
      .then(() => this.#load(paramsOf(target, intent)))
      .then(
        (next) => {
          if (!this.#isCurrent(request)) return
          this.#request = undefined
          this.#failures = 0
          this.#setState({
            status: 'ready',
            provider: target.provider,
            summary: newerLimits(this.#state?.summary, next),
          })
          this.#flushAfterRequest(revision)
        },
        (error) => {
          if (!this.#isCurrent(request)) return
          this.#request = undefined
          // Values pushed while the request ran are the newest known ones.
          const held = this.#state?.summary
          const message = messageOf(error)
          this.#setState({
            status: 'error',
            provider: target.provider,
            message,
            ...(held ? { summary: held } : {}),
            ...this.#failed(revision, message, held),
          })
          this.#flushAfterRequest(revision)
        },
      )
  }

  #flushAfterRequest(revision: number): void {
    if (this.#dirty && this.#timer === undefined) this.#flushTrailing(revision)
  }

  #scheduleTrailing(revision: number): void {
    this.#clearTimer()
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#flushTrailing(revision)
    }, this.#coalesceMs)
  }

  #flushTrailing(revision: number): void {
    if (this.#disposed || revision !== this.#revision || !this.#dirty) return
    if (this.#request?.revision === revision) return
    this.#dirty = false
    this.#start(revision)
  }

  #isCurrent(request: { revision: number; id: number }): boolean {
    return !this.#disposed && this.#request === request && request.revision === this.#revision
  }

  #setState(state: UsageSummaryState): void {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }

  #clearTimer(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #clearRetryTimer(): void {
    clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
  }
}
