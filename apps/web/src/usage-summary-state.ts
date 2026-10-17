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

export type UsageSummaryState =
  | { status: 'loading'; provider: ProviderId; summary?: Summary }
  | { status: 'ready'; provider: ProviderId; summary: Summary }
  | { status: 'error'; provider: ProviderId; message: string; summary?: Summary }

type LoadSummary = (params: ParamsOf<'usage.summary'>) => Promise<Summary>

const ERROR_MESSAGE_LIMIT = 300

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
  #disposed = false

  constructor(
    load: LoadSummary,
    coalesceMs = 100,
    intent: () => UsageReadIntent = () => 'visible',
  ) {
    this.#load = load
    this.#coalesceMs = coalesceMs
    this.#intent = intent
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
    this.#listeners.clear()
  }

  #start(revision: number): void {
    const target = this.#target
    if (this.#disposed || revision !== this.#revision || !target) return
    const summary = this.#state?.summary
    this.#setState({
      status: 'loading',
      provider: target.provider,
      ...(summary ? { summary } : {}),
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
          this.#setState({
            status: 'error',
            provider: target.provider,
            message: messageOf(error),
            ...(held ? { summary: held } : {}),
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
}
