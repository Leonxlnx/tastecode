import type { ParamsOf, ProviderId, ResultOf } from '@harness/contracts'
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
      (target, index) => targets.findIndex((candidate) => candidate.provider === target.provider) === index,
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
        const controller = new UsageSummaryController(this.#load, this.#coalesceMs)
        entry = { controller, unsubscribe: controller.subscribe(() => this.#publish()) }
        this.#entries.set(target.provider, entry)
      }
      entry.controller.select(target)
    }
    this.#publish()
  }

  refresh(provider?: ProviderId): void {
    if (provider) this.#entries.get(provider)?.controller.refresh()
    else for (const entry of this.#entries.values()) entry.controller.refresh()
  }

  changed(provider: ProviderId): void {
    this.#entries.get(provider)?.controller.changed(provider)
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
