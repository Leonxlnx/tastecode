import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type ParamsOf,
  type ProviderId,
  type ProviderLimitSource,
  type ResultOf,
  type UsageReadIntent,
} from '@harness/contracts'
import { UsageSummaryController, type UsageSummaryState } from './usage-summary-state.js'

/** One provider account's limits. Absent `accountId` means the default account. */
export type LimitTarget = { provider: ProviderId; accountId?: AccountId | undefined }
type Target = LimitTarget & { threadId?: string | undefined }
type LoadSummary = (params: ParamsOf<'usage.summary'>) => Promise<ResultOf<'usage.summary'>>

type Entry = {
  controller: UsageSummaryController
  unsubscribe: () => void
  /** Asked only while a view shows the limits; pushes still update it. */
  onDemand: boolean
}

/**
 * Plan limits belong to an account, so each provider account is its own
 * source. The default account keeps the provider's own key.
 */
export function limitKey(provider: ProviderId, accountId?: AccountId): string {
  return accountId === undefined || accountId === DEFAULT_ACCOUNT_ID
    ? provider
    : `${provider}/${accountId}`
}

/** The provider account a `limitKey` names; the default account has no `accountId`. */
export function limitTargetOf(key: string): LimitTarget {
  const slash = key.indexOf('/')
  return slash < 0
    ? { provider: key as ProviderId }
    : { provider: key.slice(0, slash) as ProviderId, accountId: key.slice(slash + 1) }
}

const keyOf = (target: LimitTarget): string => limitKey(target.provider, target.accountId)

/** Combines the existing race-safe single-source owners without merging source truth. */
export class UsageLimitsController {
  readonly #load: LoadSummary
  readonly #coalesceMs: number
  readonly #entries = new Map<string, Entry>()
  readonly #listeners = new Set<() => void>()
  #active: LimitTarget[] = []
  #onDemand: LimitTarget[] = []
  #snapshot: UsageSummaryState[] = []
  #disposed = false
  /** Views that show the limits now, such as the account popup or the Usage page. */
  #shown = 0
  #showRefresh = false
  readonly #intent = (): UsageReadIntent => (this.#shown > 0 ? 'visible' : 'background')

  constructor(load: LoadSummary, coalesceMs = 100) {
    this.#load = load
    this.#coalesceMs = coalesceMs
  }

  snapshot(): UsageSummaryState[] {
    return this.#snapshot
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * `targets` are asked at once and kept current. `onDemand` sources (a
   * provider's default account, or a named account) are asked only when a
   * view shows the limits, so a launch does not start a vendor read for every
   * installed provider or account; once known, their values stay and follow
   * the server's pushes.
   */
  select(targets: Target[], onDemand: ReadonlyArray<ProviderId | LimitTarget> = []): void {
    if (this.#disposed) return
    const unique = targets.filter(
      (target, index) =>
        targets.findIndex((candidate) => keyOf(candidate) === keyOf(target)) === index,
    )
    const active = new Set(unique.map(keyOf))
    const later: LimitTarget[] = []
    for (const each of onDemand) {
      const target = typeof each === 'string' ? { provider: each } : each
      const key = keyOf(target)
      if (active.has(key) || later.some((candidate) => keyOf(candidate) === key)) continue
      later.push(target)
    }
    const kept = new Set([...active, ...later.map(keyOf)])
    for (const [key, entry] of this.#entries) {
      if (kept.has(key)) continue
      entry.unsubscribe()
      entry.controller.dispose()
      this.#entries.delete(key)
    }
    this.#active = unique.map((target) => ({
      provider: target.provider,
      accountId: target.accountId,
    }))
    this.#onDemand = later
    for (const target of unique) {
      const entry = this.#entries.get(keyOf(target))
      if (!entry) {
        this.#add(target, false).controller.select(target)
        continue
      }
      const promoted = entry.onDemand
      entry.onDemand = false
      entry.controller.select(target)
      // Its values came from an open view or a push; as the active source it
      // catches up once, unless a request is already running.
      if (promoted && entry.controller.snapshot()?.status !== 'loading') {
        entry.controller.refresh()
      }
    }
    for (const target of later) {
      const entry = this.#entries.get(keyOf(target))
      if (entry) entry.onDemand = true
      // A source installed while a view is open joins it at once.
      else if (this.#shown > 0) this.#add(target, true).controller.select(target)
    }
    this.#publish()
  }

  /** Without a provider, every source a request may ask now. */
  refresh(provider?: ProviderId, intent?: UsageReadIntent, accountId?: AccountId): void {
    if (provider) {
      const entry = this.#entries.get(limitKey(provider, accountId))
      if (entry && this.#asks(entry)) entry.controller.refresh(intent)
      return
    }
    for (const entry of this.#entries.values()) {
      if (this.#asks(entry)) entry.controller.refresh(intent)
    }
  }

  /**
   * A view that shows the limits opened. While any is open, requests say so,
   * which lets the server read sources it otherwise reads only on view; the
   * opening itself asks once, on-demand sources included. Returns the
   * release for when the view closes.
   */
  show(): () => void {
    if (this.#disposed) return () => {}
    this.#shown += 1
    // A view that closes and opens again in the same task, as under
    // StrictMode, asks only once.
    if (this.#shown === 1 && !this.#showRefresh) {
      this.#showRefresh = true
      // Sources not asked yet start now, so the view lists them as checking
      // from its first paint instead of popping them in later.
      const joined = new Set<string>()
      for (const target of this.#onDemand) {
        const key = keyOf(target)
        if (this.#entries.has(key)) continue
        this.#add(target, true).controller.select(target)
        joined.add(key)
      }
      if (joined.size > 0) this.#publish()
      queueMicrotask(() => {
        this.#showRefresh = false
        if (this.#shown === 0 || this.#disposed) return
        for (const [key, entry] of this.#entries) {
          if (!joined.has(key)) entry.controller.refresh()
        }
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.#shown -= 1
    }
  }

  changed(provider: ProviderId, accountId?: AccountId): void {
    const entry = this.#entries.get(limitKey(provider, accountId))
    if (entry && this.#asks(entry)) entry.controller.changed(provider, accountId)
  }

  /**
   * A pushed snapshot replaces that provider account's limits without a
   * request; it never touches another account's. An on-demand source not
   * asked yet takes it too: what the server sends for free is known.
   */
  applySource(source: ProviderLimitSource): void {
    if (this.#disposed) return
    const key = limitKey(source.provider, source.accountId)
    let entry = this.#entries.get(key)
    if (!entry) {
      const target = this.#onDemand.find((candidate) => keyOf(candidate) === key)
      if (!target) return
      entry = this.#add(target, true)
      entry.controller.select(target, false)
    }
    entry.controller.applySource(source)
  }

  dispose(): void {
    this.#disposed = true
    for (const entry of this.#entries.values()) {
      entry.unsubscribe()
      entry.controller.dispose()
    }
    this.#entries.clear()
    this.#listeners.clear()
  }

  #add(target: LimitTarget, onDemand: boolean): Entry {
    const controller = new UsageSummaryController(this.#load, this.#coalesceMs, this.#intent)
    const entry = { controller, unsubscribe: controller.subscribe(() => this.#publish()), onDemand }
    this.#entries.set(keyOf(target), entry)
    return entry
  }

  /** On-demand sources are asked only while a view shows them. */
  #asks(entry: Entry): boolean {
    return !entry.onDemand || this.#shown > 0
  }

  #publish(): void {
    this.#snapshot = [...this.#active, ...this.#onDemand].flatMap((target) => {
      const entry = this.#entries.get(keyOf(target))
      if (!entry) return []
      return [entry.controller.snapshot() ?? loadingState(target)]
    })
    for (const listener of this.#listeners) listener()
  }
}

function loadingState(target: LimitTarget): UsageSummaryState {
  return target.accountId === undefined || target.accountId === DEFAULT_ACCOUNT_ID
    ? { status: 'loading', provider: target.provider }
    : { status: 'loading', provider: target.provider, accountId: target.accountId }
}
