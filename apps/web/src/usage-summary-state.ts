import type { ParamsOf, ProviderId, ResultOf } from '@harness/contracts'
import { errorMessage } from './boundary.js'

type Summary = ResultOf<'usage.summary'>
type Target = { provider: ProviderId; threadId?: string | undefined }

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

function paramsOf(target: Target): ParamsOf<'usage.summary'> {
  return target.threadId ? { threadId: target.threadId } : { provider: target.provider }
}

/**
 * Owns the asynchronous account-usage state independently from React.
 *
 * One revision belongs to one provider/thread target. That makes stale reads
 * harmless and lets same-target refresh failures retain useful last-known
 * values without carrying them across a provider or session switch.
 */
export class UsageSummaryController {
  readonly #load: LoadSummary
  readonly #coalesceMs: number
  readonly #retryDelaysMs: readonly number[]
  readonly #listeners = new Set<() => void>()
  #target: Target | undefined
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

  constructor(load: LoadSummary, coalesceMs = 100, retryDelaysMs = RETRY_DELAYS_MS) {
    this.#load = load
    this.#coalesceMs = coalesceMs
    this.#retryDelaysMs = retryDelaysMs
  }

  snapshot(): UsageSummaryState | undefined {
    return this.#state
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  select(target: Target): void {
    if (this.#disposed || sameTarget(this.#target, target)) return
    this.#revision += 1
    this.#target = target
    this.#state = undefined
    this.#dirty = false
    this.#failures = 0
    this.#clearTimer()
    this.#start(this.#revision)
  }

  /** Manual retry, reconnect, and ordinary polling all use the same guarded path. */
  refresh(): void {
    if (this.#disposed || !this.#target) return
    if (this.#request?.revision === this.#revision) {
      this.#dirty = true
      return
    }
    this.#dirty = false
    this.#clearTimer()
    this.#start(this.#revision)
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
    void Promise.resolve()
      .then(() => this.#load(paramsOf(target)))
      .then(
        (next) => {
          if (!this.#isCurrent(request)) return
          this.#request = undefined
          this.#failures = 0
          this.#setState({ status: 'ready', provider: target.provider, summary: next })
          this.#flushAfterRequest(revision)
        },
        (error) => {
          if (!this.#isCurrent(request)) return
          this.#request = undefined
          const message = messageOf(error)
          this.#setState({
            status: 'error',
            provider: target.provider,
            message,
            ...(summary ? { summary } : {}),
            ...this.#failed(revision, message, summary),
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
