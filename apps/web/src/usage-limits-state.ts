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
}

/** Combines the existing race-safe single-source owners without merging source truth. */
export class UsageLimitsController {
  readonly #load: LoadSummary
  readonly #coalesceMs: number
  readonly #entries = new Map<ProviderId, Entry>()
  readonly #listeners = new Set<() => void>()
  #order: ProviderId[] = []
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

  select(targets: Target[]): void {
    if (this.#disposed) return
    const unique = targets.filter(
      (target, index) =>
        targets.findIndex((candidate) => candidate.provider === target.provider) === index,
    )
    const providers = new Set(unique.map((target) => target.provider))
    for (const [provider, entry] of this.#entries) {
      if (providers.has(provider)) continue
      entry.unsubscribe()
      entry.controller.dispose()
      this.#entries.delete(provider)
    }
    this.#order = unique.map((target) => target.provider)
    for (const target of unique) {
      let entry = this.#entries.get(target.provider)
      if (!entry) {
        const controller = new UsageSummaryController(this.#load, this.#coalesceMs, this.#intent)
        entry = { controller, unsubscribe: controller.subscribe(() => this.#publish()) }
        this.#entries.set(target.provider, entry)
      }
      entry.controller.select(target)
    }
    this.#publish()
  }

  refresh(provider?: ProviderId, intent?: UsageReadIntent): void {
    if (provider) this.#entries.get(provider)?.controller.refresh(intent)
    else for (const entry of this.#entries.values()) entry.controller.refresh(intent)
  }

  /**
   * A view that shows the limits opened. While any is open, requests say so,
   * which lets the server read sources it otherwise reads only on view; the
   * opening itself asks once. Returns the release for when the view closes.
   */
  show(): () => void {
    if (this.#disposed) return () => {}
    this.#shown += 1
    // A view that closes and opens again in the same task, as under
    // StrictMode, asks only once.
    if (this.#shown === 1 && !this.#showRefresh) {
      this.#showRefresh = true
      queueMicrotask(() => {
        this.#showRefresh = false
        if (this.#shown > 0 && !this.#disposed) this.refresh()
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
    this.#entries.get(provider)?.controller.changed(provider)
  }

  /** A pushed snapshot replaces that provider's limits without a request. */
  applySource(source: ProviderLimitSource): void {
    if (this.#disposed) return
    this.#entries.get(source.provider)?.controller.applySource(source)
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

  #publish(): void {
    this.#snapshot = this.#order.map(
      (provider) =>
        this.#entries.get(provider)?.controller.snapshot() ?? { status: 'loading', provider },
    )
    for (const listener of this.#listeners) listener()
  }
}
