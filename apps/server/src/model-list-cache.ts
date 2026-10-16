import { isDeepStrictEqual } from 'node:util'
import type { Model, ProviderId } from '@harness/contracts'

export type ModelListCacheOptions = {
  /** Reads one source's models from its provider; `agent` names a custom or ACP source. */
  list: (provider: ProviderId, agent: string | undefined) => Promise<Model[]>
  /** A refresh changed a list that callers may already hold. */
  onChanged?: ((provider: ProviderId, agent: string | undefined) => void) | undefined
  onLog?: ((line: string) => void) | undefined
  /** How long a list answers later requests without asking the provider again. */
  freshMs?: number | undefined
  /** How long the last good list still answers while it refreshes, or after a refresh failed. */
  maxStaleMs?: number | undefined
  /** How long a failed refresh waits before a request starts the next one in the background. */
  retryMs?: number | undefined
  now?: (() => number) | undefined
}

type Entry = {
  readonly provider: ProviderId
  readonly agent: string | undefined
  value?: Model[] | undefined
  /** When the provider last answered with `value`. */
  listedAt: number
  /** Invalidated: the value still answers, but the next request refreshes it. */
  stale: boolean
  reading?: Promise<Model[]> | undefined
  /** Bumped by every invalidation, so a read that started earlier cannot store its answer. */
  version: number
  failedAt?: number | undefined
}

export const MODEL_LIST_FRESH_MS = 10 * 60_000
export const MODEL_LIST_MAX_STALE_MS = 24 * 60 * 60_000
export const MODEL_LIST_RETRY_MS = 60_000

/**
 * One shared model list per source. Listing starts a vendor process (a Claude
 * SDK session, a Codex app-server, `cursor-agent models`) that can take tens of
 * seconds, so concurrent requests share one read and a recent answer serves
 * later ones. An older answer is returned at once while a background read
 * replaces it; when that read changes the list, `onChanged` tells the clients
 * to ask again. A failed read is never stored: a request without a usable
 * answer reads again, and one that still has an answer keeps it for up to a
 * day, so a slow or failing CLI cannot take away a known list.
 */
export class ModelListCache {
  readonly #options: ModelListCacheOptions
  readonly #entries = new Map<string, Entry>()
  readonly #freshMs: number
  readonly #maxStaleMs: number
  readonly #retryMs: number
  readonly #now: () => number

  constructor(options: ModelListCacheOptions) {
    this.#options = options
    this.#freshMs = duration(options.freshMs, MODEL_LIST_FRESH_MS)
    this.#maxStaleMs = Math.max(
      this.#freshMs,
      duration(options.maxStaleMs, MODEL_LIST_MAX_STALE_MS),
    )
    this.#retryMs = duration(options.retryMs, MODEL_LIST_RETRY_MS)
    this.#now = options.now ?? (() => Date.now())
  }

  list(provider: ProviderId, agent?: string): Promise<Model[]> {
    const entry = this.#entry(provider, agent)
    if (entry.value !== undefined) {
      const now = this.#now()
      const age = now - entry.listedAt
      if (age >= 0 && age < this.#freshMs && !entry.stale) return Promise.resolve(entry.value)
      if (age >= 0 && age < this.#maxStaleMs) {
        this.#refreshInBackground(entry, now)
        return Promise.resolve(entry.value)
      }
    }
    return this.#read(entry)
  }

  /**
   * The provider's lists may be out of date, for example after a sign-in or an
   * update. They still answer, but the next request refreshes them. Without an
   * agent this covers every source of the provider.
   */
  invalidate(provider: ProviderId, agent?: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.provider !== provider || (agent !== undefined && entry.agent !== agent)) continue
      entry.version += 1
      entry.stale = true
      entry.reading = undefined
      entry.failedAt = undefined
    }
  }

  /** Drops every list of a custom or ACP source, whose next request reads afresh. */
  forgetAgent(agent: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.agent !== agent) continue
      entry.version += 1
      this.#entries.delete(key)
    }
  }

  dispose(): void {
    for (const entry of this.#entries.values()) entry.version += 1
    this.#entries.clear()
  }

  #entry(provider: ProviderId, agent: string | undefined): Entry {
    const key = entryKey(provider, agent)
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { provider, agent, listedAt: 0, stale: false, version: 0 }
      this.#entries.set(key, entry)
    }
    return entry
  }

  #refreshInBackground(entry: Entry, now: number): void {
    if (entry.reading) return
    if (
      entry.failedAt !== undefined &&
      now - entry.failedAt >= 0 &&
      now - entry.failedAt < this.#retryMs
    )
      return
    void this.#read(entry).catch((error: unknown) => {
      this.#options.onLog?.(
        `Kept the last ${describe(entry)} model list; refreshing it failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
  }

  #read(entry: Entry): Promise<Model[]> {
    if (entry.reading) return entry.reading
    const { version } = entry
    const previous = entry.value
    const current = () =>
      this.#entries.get(entryKey(entry.provider, entry.agent)) === entry &&
      entry.version === version
    const reading = Promise.resolve()
      .then(() => this.#options.list(entry.provider, entry.agent))
      .then(
        (models) => {
          if (current()) {
            entry.value = models
            entry.listedAt = this.#now()
            entry.stale = false
            entry.failedAt = undefined
            if (previous !== undefined && !isDeepStrictEqual(previous, models)) {
              this.#options.onChanged?.(entry.provider, entry.agent)
            }
          }
          return models
        },
        (error: unknown) => {
          if (current()) entry.failedAt = this.#now()
          throw error
        },
      )
      .finally(() => {
        if (entry.reading === reading) entry.reading = undefined
      })
    entry.reading = reading
    return reading
  }
}

function entryKey(provider: ProviderId, agent: string | undefined): string {
  return agent === undefined ? provider : `${provider}\n${agent}`
}

function describe(entry: Entry): string {
  return entry.agent === undefined ? entry.provider : `${entry.provider} (${entry.agent})`
}

function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}
