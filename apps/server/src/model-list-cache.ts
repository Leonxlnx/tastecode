import { isDeepStrictEqual } from 'node:util'
import { ModelSchema, ProviderIdSchema, type Model, type ProviderId } from '@harness/contracts'
import { z } from 'zod'

/** Where the last good lists outlive the process. */
export type ModelListSnapshotStore = {
  read(): string | undefined
  write(value: string): void
}

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
  /** Lists from the last launch answer at once, so the first request does not wait for a CLI. */
  snapshot?: ModelListSnapshotStore | undefined
  /**
   * How long after the cache was created a list from the last launch is read
   * again, so launch-time work is not joined by every listing process.
   */
  restoredRefreshDelayMs?: number | undefined
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
  /** The value came from an earlier launch and has not been read again yet. */
  restored: boolean
  refreshTimer?: ReturnType<typeof setTimeout> | undefined
  reading?: Promise<Model[]> | undefined
  /** Bumped by every invalidation, so a read that started earlier cannot store its answer. */
  version: number
  failedAt?: number | undefined
}

export const MODEL_LIST_FRESH_MS = 10 * 60_000
export const MODEL_LIST_MAX_STALE_MS = 24 * 60 * 60_000
export const MODEL_LIST_RETRY_MS = 60_000
export const MODEL_LIST_RESTORED_REFRESH_DELAY_MS = 20_000
/** Larger lists are kept for this launch only; one would outweigh every other setting. */
export const MAX_PERSISTED_MODELS = 2_000

const SNAPSHOT_VERSION = 1
const SnapshotSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  lists: z.array(z.unknown()).max(1_000),
})
const SnapshotListSchema = z.object({
  provider: ProviderIdSchema,
  agent: z.string().min(1).optional(),
  listedAt: z.number().int().nonnegative(),
  models: z.array(ModelSchema).max(MAX_PERSISTED_MODELS),
})

/**
 * One shared model list per source. Listing starts a vendor process (a Claude
 * SDK session, a Codex app-server, `cursor-agent models`) that can take tens of
 * seconds, so concurrent requests share one read and a recent answer serves
 * later ones. An older answer is returned at once while a background read
 * replaces it; when that read changes the list, `onChanged` tells the clients
 * to ask again. A failed read is never stored: a request without a usable
 * answer reads again, and one that still has an answer keeps it for up to a
 * day, so a slow or failing CLI cannot take away a known list. The last good
 * lists are kept in `snapshot`, so the next launch answers from them while it
 * reads each source once more.
 */
export class ModelListCache {
  readonly #options: ModelListCacheOptions
  readonly #entries = new Map<string, Entry>()
  readonly #freshMs: number
  readonly #maxStaleMs: number
  readonly #retryMs: number
  readonly #restoredRefreshAt: number
  readonly #now: () => number
  #restoredSnapshot = false

  constructor(options: ModelListCacheOptions) {
    this.#options = options
    this.#freshMs = duration(options.freshMs, MODEL_LIST_FRESH_MS)
    this.#maxStaleMs = Math.max(
      this.#freshMs,
      duration(options.maxStaleMs, MODEL_LIST_MAX_STALE_MS),
    )
    this.#retryMs = duration(options.retryMs, MODEL_LIST_RETRY_MS)
    this.#now = options.now ?? (() => Date.now())
    this.#restoredRefreshAt =
      this.#now() + duration(options.restoredRefreshDelayMs, MODEL_LIST_RESTORED_REFRESH_DELAY_MS)
  }

  list(provider: ProviderId, agent?: string): Promise<Model[]> {
    const entry = this.#entry(provider, agent)
    if (entry.value !== undefined) {
      const now = this.#now()
      const age = now - entry.listedAt
      const fresh = !entry.stale && !entry.restored
      if (age >= 0 && age < this.#freshMs && fresh) return Promise.resolve(entry.value)
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
      // Known to be out of date, so it no longer waits for launch work to settle.
      entry.restored = false
      clearTimeout(entry.refreshTimer)
      entry.refreshTimer = undefined
      entry.reading = undefined
      entry.failedAt = undefined
    }
  }

  /** Drops every list of a custom or ACP source, whose next request reads afresh. */
  forgetAgent(agent: string): void {
    this.#restore()
    let forgot = false
    for (const [key, entry] of this.#entries) {
      if (entry.agent !== agent) continue
      entry.version += 1
      clearTimeout(entry.refreshTimer)
      this.#entries.delete(key)
      forgot ||= entry.value !== undefined
    }
    if (forgot) this.#persist()
  }

  dispose(): void {
    for (const entry of this.#entries.values()) {
      entry.version += 1
      clearTimeout(entry.refreshTimer)
    }
    this.#entries.clear()
  }

  #entry(provider: ProviderId, agent: string | undefined): Entry {
    this.#restore()
    const key = entryKey(provider, agent)
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { provider, agent, listedAt: 0, stale: false, restored: false, version: 0 }
      this.#entries.set(key, entry)
    }
    return entry
  }

  /** Reads the snapshot once; a list it cannot read, or one older than a day, is left out. */
  #restore(): void {
    if (this.#restoredSnapshot) return
    this.#restoredSnapshot = true
    let raw: string | undefined
    try {
      raw = this.#options.snapshot?.read()
    } catch (error) {
      this.#options.onLog?.(`Could not read the saved model lists: ${String(error)}`)
      return
    }
    if (!raw) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const snapshot = SnapshotSchema.safeParse(parsed)
    if (!snapshot.success) return
    const now = this.#now()
    for (const candidate of snapshot.data.lists) {
      const list = SnapshotListSchema.safeParse(candidate)
      if (!list.success) continue
      const { provider, agent, listedAt, models } = list.data
      const age = now - listedAt
      if (age < 0 || age >= this.#maxStaleMs) continue
      this.#entries.set(entryKey(provider, agent), {
        provider,
        agent,
        value: models,
        listedAt,
        stale: false,
        restored: true,
        version: 0,
      })
    }
  }

  #persist(): void {
    const store = this.#options.snapshot
    if (!store) return
    const lists = [...this.#entries.values()].flatMap((entry) =>
      entry.value !== undefined && entry.value.length <= MAX_PERSISTED_MODELS
        ? [
            {
              provider: entry.provider,
              ...(entry.agent === undefined ? {} : { agent: entry.agent }),
              listedAt: entry.listedAt,
              models: entry.value,
            },
          ]
        : [],
    )
    try {
      store.write(JSON.stringify({ version: SNAPSHOT_VERSION, lists }))
    } catch (error) {
      this.#options.onLog?.(`Could not save the model lists: ${String(error)}`)
    }
  }

  #refreshInBackground(entry: Entry, now: number): void {
    if (entry.reading || entry.refreshTimer) return
    if (entry.restored && now < this.#restoredRefreshAt) {
      entry.refreshTimer = setTimeout(() => {
        entry.refreshTimer = undefined
        if (this.#entries.get(entryKey(entry.provider, entry.agent)) === entry) {
          this.#refreshInBackground(entry, this.#now())
        }
      }, this.#restoredRefreshAt - now)
      entry.refreshTimer.unref?.()
      return
    }
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
            entry.restored = false
            entry.failedAt = undefined
            this.#persist()
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
