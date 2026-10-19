import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type ParamsOf,
  type ProviderId,
  type ProviderLimitSource,
  type ResultOf,
  type UsageReadIntent,
} from '@harness/contracts'
import { errorMessage } from './boundary.js'

type Summary = ResultOf<'usage.summary'>
type Target = {
  provider: ProviderId
  /** Absent means the default account. */
  accountId?: AccountId | undefined
  threadId?: string | undefined
}

/** Absent and default both name the CLI's own account. */
export function sameAccount(left: AccountId | undefined, right: AccountId | undefined): boolean {
  return (left ?? DEFAULT_ACCOUNT_ID) === (right ?? DEFAULT_ACCOUNT_ID)
}

/** The account a state or request names; the default account is left out, as on the wire. */
function accountOf(target: Pick<Target, 'accountId'>): { accountId?: AccountId } {
  return target.accountId === undefined || target.accountId === DEFAULT_ACCOUNT_ID
    ? {}
    : { accountId: target.accountId }
}

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

/** `accountId` is present only for an account other than the default one. */
export type UsageSummaryState =
  | ({
      status: 'loading'
      provider: ProviderId
      accountId?: AccountId
      summary?: Summary
    } & Retrying)
  | { status: 'ready'; provider: ProviderId; accountId?: AccountId; summary: Summary }
  | ({
      status: 'error'
      provider: ProviderId
      accountId?: AccountId
      message: string
      summary?: Summary
    } & Retrying)

type LoadSummary = (params: ParamsOf<'usage.summary'>) => Promise<Summary>

const ERROR_MESSAGE_LIMIT = 300
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000]

function messageOf(error: Parameters<typeof errorMessage>[0]): string {
  const message = errorMessage(error, 'Plan limits could not be loaded.')
  return (message || 'Plan limits could not be loaded.').slice(0, ERROR_MESSAGE_LIMIT)
}

function sameSource(left: Target | undefined, right: Target): boolean {
  return left?.provider === right.provider && sameAccount(left.accountId, right.accountId)
}

function sameTarget(left: Target | undefined, right: Target): boolean {
  return sameSource(left, right) && left?.threadId === right.threadId
}

function paramsOf(target: Target, intent: UsageReadIntent): ParamsOf<'usage.summary'> {
  return target.threadId
    ? { threadId: target.threadId, intent }
    : { provider: target.provider, ...accountOf(target), intent }
}

/**
 * Owns the asynchronous account-usage state independently from React.
 *
 * One revision belongs to one provider/account/thread target. That makes
 * stale reads harmless and lets refresh failures retain useful last-known
 * values. Plan limits belong to the account, so they survive a switch between
 * threads on the same account and are cleared only by a switch to another
 * provider or account.
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
    const sameAccountLimits = sameSource(this.#target, target)
    this.#revision += 1
    this.#target = target
    // The next read reports the same account's limits; until it lands, the
    // last ones stay on screen instead of reading as "Checking…" again.
    if (!sameAccountLimits) this.#state = undefined
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
   * Takes a limit snapshot the server pushed for this provider account,
   * without a request. A read in flight still shows as loading until it
   * answers. Another account's snapshot is not this one's.
   */
  applySource(source: ProviderLimitSource): void {
    const target = this.#target
    if (this.#disposed || !target || !sameSource(target, source)) return
    const summary = withLimitSource(this.#state?.summary, source)
    this.#setState({
      status: this.#state?.status === 'loading' ? 'loading' : 'ready',
      provider: target.provider,
      ...accountOf(target),
      summary,
    })
  }

  /** Ignore other sources and collapse a burst into one trailing read. */
  changed(provider: ProviderId, accountId?: AccountId): void {
    const target = this.#target
    if (this.#disposed || !target || !sameSource(target, { provider, accountId })) return
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
      ...accountOf(target),
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
            ...accountOf(target),
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
            ...accountOf(target),
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
