import type {
  ParamsOf,
  ProviderId,
  ProviderLimitSource,
  ResultOf,
  UsageReadIntent,
} from '@harness/contracts'
import { UsageSummaryController, type UsageSummaryState } from './usage-summary-state.js'

type Target = { provider: ProviderId; threadId?: string | undefined }
type LoadSummary = (params: ParamsOf<'usage.summary'>) => Promise<ResultOf<'usage.summary'>>

type Entry = {
  controller: UsageSummaryController
  unsubscribe: () => void
  /** Asked only while a view shows the limits; pushes still update it. */
  onDemand: boolean
}

/** Combines the existing race-safe single-source owners without merging source truth. */
export class UsageLimitsController {
  readonly #load: LoadSummary
  readonly #coalesceMs: number
  readonly #entries = new Map<ProviderId, Entry>()
  readonly #listeners = new Set<() => void>()
  #active: ProviderId[] = []
  #onDemand: ProviderId[] = []
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
   * `targets` are asked at once and kept current. `onDemand` sources are
   * asked only when a view shows the limits, so a launch does not start a
   * vendor read for every installed provider; once known, their values stay
   * and follow the server's pushes.
   */
  select(targets: Target[], onDemand: readonly ProviderId[] = []): void {
    if (this.#disposed) return
    const unique = targets.filter(
      (target, index) =>
        targets.findIndex((candidate) => candidate.provider === target.provider) === index,
    )
    const active = new Set(unique.map((target) => target.provider))
    const later = onDemand.filter(
      (provider, index) => !active.has(provider) && onDemand.indexOf(provider) === index,
    )
    const kept = new Set([...active, ...later])
    for (const [provider, entry] of this.#entries) {
      if (kept.has(provider)) continue
      entry.unsubscribe()
      entry.controller.dispose()
      this.#entries.delete(provider)
    }
    this.#active = [...active]
    this.#onDemand = later
    for (const target of unique) {
      const entry = this.#entries.get(target.provider)
      if (!entry) {
        this.#add(target.provider, false).controller.select(target)
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
    for (const provider of later) {
      const entry = this.#entries.get(provider)
      if (entry) entry.onDemand = true
      // A source installed while a view is open joins it at once.
      else if (this.#shown > 0) this.#add(provider, true).controller.select({ provider })
    }
    this.#publish()
  }

  refresh(provider?: ProviderId, intent?: UsageReadIntent): void {
    if (provider) {
      const entry = this.#entries.get(provider)
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
      const joined = new Set<ProviderId>()
      for (const provider of this.#onDemand) {
        if (this.#entries.has(provider)) continue
        this.#add(provider, true).controller.select({ provider })
        joined.add(provider)
      }
      if (joined.size > 0) this.#publish()
      queueMicrotask(() => {
        this.#showRefresh = false
        if (this.#shown === 0 || this.#disposed) return
        for (const [provider, entry] of this.#entries) {
          if (!joined.has(provider)) entry.controller.refresh()
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

  changed(provider: ProviderId): void {
    const entry = this.#entries.get(provider)
    if (entry && this.#asks(entry)) entry.controller.changed(provider)
  }

  /**
   * A pushed snapshot replaces that provider's limits without a request. An
   * on-demand source not asked yet takes it too: what the server sends for
   * free is known.
   */
  applySource(source: ProviderLimitSource): void {
    if (this.#disposed) return
    let entry = this.#entries.get(source.provider)
    if (!entry) {
      if (!this.#onDemand.includes(source.provider)) return
      entry = this.#add(source.provider, true)
      entry.controller.select({ provider: source.provider }, false)
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

  #add(provider: ProviderId, onDemand: boolean): Entry {
    const controller = new UsageSummaryController(this.#load, this.#coalesceMs, this.#intent)
    const entry = { controller, unsubscribe: controller.subscribe(() => this.#publish()), onDemand }
    this.#entries.set(provider, entry)
    return entry
  }

  /** On-demand sources are asked only while a view shows them. */
  #asks(entry: Entry): boolean {
    return !entry.onDemand || this.#shown > 0
  }

  #publish(): void {
    this.#snapshot = [...this.#active, ...this.#onDemand].flatMap((provider) => {
      const entry = this.#entries.get(provider)
      if (!entry) return []
      return [entry.controller.snapshot() ?? { status: 'loading', provider }]
    })
    for (const listener of this.#listeners) listener()
  }
}
