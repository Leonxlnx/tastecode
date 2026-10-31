import { isDeepStrictEqual } from 'node:util'
import { ModelSchema, ProviderIdSchema, type Model, type ProviderId } from '@harness/contracts'
import { z } from 'zod'

/** Where the last good lists outlive the process. */
export type ModelListSnapshotStore = {
  read(): string | undefined
  write(value: string): void
}

/** How a read stands to the list the cache already holds. */
export type ModelListRead = {
  /**
   * The cache holds a list it keeps when this read fails, so a provider that
   * cannot reach its CLI should fail rather than answer with built-in values.
   */
  refresh: boolean
}

export type ModelListCacheOptions = {
  /** Reads one source's models from its provider; `agent` names a custom or ACP source. */
  list: (provider: ProviderId, agent: string | undefined, read: ModelListRead) => Promise<Model[]>
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
  /** How far apart those reads start, so the listing processes do not all run at once. */
  restoredRefreshStaggerMs?: number | undefined
  /**
   * Names the binary a provider's own lists come from, such as its resolved
   * path and version; undefined when that is not known. A saved list is kept
   * with the binary that listed it: another binary's list is read again at
   * once, and the same binary's list still answers after `maxStaleMs`, up to
   * `maxKeptMs`, while it is read again in the background.
   */
  binary?: ((provider: ProviderId) => Promise<string | undefined>) | undefined
  maxKeptMs?: number | undefined
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
  /** The binary that listed `value`, for a provider's own list. */
  binary?: string | undefined
  /** `binary` is the one installed now, so the list may answer for up to `maxKeptMs`. */
  binaryConfirmed?: boolean | undefined
  /** Restored from the last launch and older than `maxStaleMs`: answers only once confirmed. */
  needsBinary?: boolean | undefined
  /** The comparison of a restored list's binary with the installed one, once per launch. */
  binaryCheck?: Promise<void> | undefined
}

export const MODEL_LIST_FRESH_MS = 10 * 60_000
export const MODEL_LIST_MAX_STALE_MS = 24 * 60 * 60_000
export const MODEL_LIST_RETRY_MS = 60_000
export const MODEL_LIST_RESTORED_REFRESH_DELAY_MS = 20_000
export const MODEL_LIST_RESTORED_REFRESH_STAGGER_MS = 5_000
/** How long a list still answers while the binary that listed it is the one installed. */
export const MODEL_LIST_MAX_KEPT_MS = 30 * 24 * 60 * 60_000
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
  binary: z.string().min(1).max(4_096).optional(),
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
 * lists are kept in `snapshot`, so the next launch answers from them. A saved
 * list is as fresh as its age says: one read minutes before a restart is not
 * read again, and older ones are read again one by one once launch work settled.
 * A provider's own list is saved with the binary that listed it (`binary`): an
 * update to another binary reads it again at once, and while the binary stays
 * the same its list answers past a day, so a launch after a day off does not
 * wait for every listing process.
 */
export class ModelListCache {
  readonly #options: ModelListCacheOptions
  readonly #entries = new Map<string, Entry>()
  readonly #freshMs: number
  readonly #maxStaleMs: number
  readonly #maxKeptMs: number
  readonly #retryMs: number
  readonly #restoredRefreshStaggerMs: number
  readonly #now: () => number
  /** When the next read of a list from the last launch may start. */
  #nextRestoredRefreshAt: number
  #restoredSnapshot = false

  constructor(options: ModelListCacheOptions) {
    this.#options = options
    this.#freshMs = duration(options.freshMs, MODEL_LIST_FRESH_MS)
    this.#maxStaleMs = Math.max(
      this.#freshMs,
      duration(options.maxStaleMs, MODEL_LIST_MAX_STALE_MS),
    )
    this.#maxKeptMs = Math.max(
      this.#maxStaleMs,
      duration(options.maxKeptMs, MODEL_LIST_MAX_KEPT_MS),
    )
    this.#retryMs = duration(options.retryMs, MODEL_LIST_RETRY_MS)
    this.#restoredRefreshStaggerMs = duration(
      options.restoredRefreshStaggerMs,
      MODEL_LIST_RESTORED_REFRESH_STAGGER_MS,
    )
    this.#now = options.now ?? (() => Date.now())
    this.#nextRestoredRefreshAt =
      this.#now() + duration(options.restoredRefreshDelayMs, MODEL_LIST_RESTORED_REFRESH_DELAY_MS)
  }

  list(provider: ProviderId, agent?: string): Promise<Model[]> {
    const entry = this.#entry(provider, agent)
    if (entry.value !== undefined && entry.restored && entry.binary !== undefined) {
      entry.binaryCheck ??= this.#checkBinary(entry)
      // Older than a day, a list answers only for the binary that listed it.
      if (entry.needsBinary) return entry.binaryCheck.then(() => this.list(provider, agent))
    }
    if (entry.value !== undefined) {
      const now = this.#now()
      const age = now - entry.listedAt
      // `listedAt` is when the provider answered, in this launch or the last
      // one, so a list read minutes before a restart is still fresh.
      if (age >= 0 && age < this.#freshMs && !entry.stale) return Promise.resolve(entry.value)
      const keptMs = entry.binaryConfirmed ? this.#maxKeptMs : this.#maxStaleMs
      if (age >= 0 && age < keptMs) {
        this.#refreshInBackground(entry, now)
        return Promise.resolve(entry.value)
      }
    }
    return this.#read(entry)
  }

  /**
   * The list this launch already holds, without asking the provider. Undefined
   * when none was read yet; a caller that must not start a vendor process,
   * such as an agent listing models for a sub-agent, takes that as "unknown".
   */
  peek(provider: ProviderId, agent?: string): readonly Model[] | undefined {
    this.#restore()
    const entry = this.#entries.get(entryKey(provider, agent))
    // A restored list waits for its binary check before it answers.
    if (!entry || entry.value === undefined || entry.needsBinary) return undefined
    return entry.value
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
      // Only a provider's own list names its binary; a custom source keeps the day.
      const binary =
        agent === undefined && this.#options.binary !== undefined ? list.data.binary : undefined
      const age = now - listedAt
      if (age < 0 || age >= (binary === undefined ? this.#maxStaleMs : this.#maxKeptMs)) continue
      this.#entries.set(entryKey(provider, agent), {
        provider,
        agent,
        value: models,
        listedAt,
        stale: false,
        restored: true,
        version: 0,
        ...(binary === undefined ? {} : { binary, needsBinary: age >= this.#maxStaleMs }),
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
              ...(entry.binary === undefined ? {} : { binary: entry.binary }),
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

  /**
   * Compares a restored list's binary with the one installed now. The same one
   * keeps the list for up to `maxKeptMs`. Another one (an update) reads the
   * list again at once; a list older than a day that cannot be confirmed is
   * dropped, so its next request waits for the provider as it did before.
   */
  async #checkBinary(entry: Entry): Promise<void> {
    const { version } = entry
    let installed: string | undefined
    try {
      installed = await this.#options.binary?.(entry.provider)
    } catch {
      installed = undefined
    }
    if (this.#entries.get(entryKey(entry.provider, entry.agent)) !== entry) return
    if (entry.version !== version) return
    const beyondStale = entry.needsBinary === true
    entry.needsBinary = false
    if (installed !== undefined && installed === entry.binary) {
      entry.binaryConfirmed = true
      return
    }
    if (beyondStale) {
      entry.value = undefined
      entry.restored = false
      return
    }
    // Not knowing the binary changes nothing for a list younger than a day.
    if (installed === undefined) return
    this.#options.onLog?.(
      `Reading the ${describe(entry)} model list again: its CLI changed since the last launch.`,
    )
    entry.version += 1
    entry.stale = true
    entry.restored = false
    clearTimeout(entry.refreshTimer)
    entry.refreshTimer = undefined
    entry.reading = undefined
    entry.failedAt = undefined
    this.#refresh(entry)
  }

  #refreshInBackground(entry: Entry, now: number): void {
    if (entry.reading || entry.refreshTimer || this.#failedRecently(entry, now)) return
    if (entry.restored) {
      // Launch work settles first, and each list from the last launch takes
      // its own slot, so their listing processes do not all start at once.
      const at = Math.max(this.#nextRestoredRefreshAt, now)
      this.#nextRestoredRefreshAt = at + this.#restoredRefreshStaggerMs
      if (at > now) {
        entry.refreshTimer = setTimeout(() => {
          entry.refreshTimer = undefined
          if (this.#entries.get(entryKey(entry.provider, entry.agent)) !== entry) return
          if (entry.reading || this.#failedRecently(entry, this.#now())) return
          this.#refresh(entry)
        }, at - now)
        entry.refreshTimer.unref?.()
        return
      }
    }
    this.#refresh(entry)
  }

  #failedRecently(entry: Entry, now: number): boolean {
    return (
      entry.failedAt !== undefined &&
      now - entry.failedAt >= 0 &&
      now - entry.failedAt < this.#retryMs
    )
  }

  #refresh(entry: Entry): void {
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
    // Which binary lists it, read beside the listing so the answer never waits for it.
    const binary =
      entry.agent === undefined && this.#options.binary
        ? Promise.resolve()
            .then(() => this.#options.binary?.(entry.provider))
            .catch(() => undefined)
        : undefined
    const reading = Promise.resolve()
      .then(() =>
        this.#options.list(entry.provider, entry.agent, { refresh: previous !== undefined }),
      )
      .then(
        (models) => {
          if (current()) {
            entry.value = models
            entry.listedAt = this.#now()
            entry.stale = false
            entry.restored = false
            entry.failedAt = undefined
            entry.binary = undefined
            entry.binaryConfirmed = false
            entry.needsBinary = false
            this.#persist()
            void binary?.then((listedBy) => {
              if (!current() || entry.value !== models || listedBy === undefined) return
              entry.binary = listedBy
              entry.binaryConfirmed = true
              this.#persist()
            })
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
