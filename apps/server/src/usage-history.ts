import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { CLAUDE_USAGE_HISTORY } from '@harness/adapter-claude-code'
import { CODEX_USAGE_HISTORY } from '@harness/adapter-codex'
import { GROK_USAGE_HISTORY } from '@harness/adapter-grok'
import { OPENCODE_USAGE_HISTORY } from '@harness/adapter-opencode'
import type { UsageArchiveFile, UsageHistorySource } from '@harness/proc/usage-archive'
import { isUsageCheckpoint, type UsageCheckpoint } from '@harness/proc/usage-log'
import {
  AccountIdSchema,
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type LocalUsageRecord,
  type ProviderId,
  type Usage,
  type UsageHistoryDay,
  type UsageHistoryModel,
  type UsageHistoryProvider,
  type UsageHistoryRange,
  type UsageHistoryResult,
  type UsageHistoryTotals,
} from '@harness/contracts'
import { modelRate, priceEntry, type ModelRate } from './model-prices.js'
import type { StoredUsageEvent } from './store.js'

const CACHE_VERSION = 8
/**
 * Version 7 holds the same parser output as version 8, one record per message
 * instead of compacted. It is migrated in place so upgrading needs no rescan.
 */
const UNCOMPACTED_CACHE_VERSION = 7
/**
 * A saved index up to this size parses on the event loop in about 100 ms. A
 * larger one, such as a per-message version 7 index of 50 MB, parses in the
 * worker so the server keeps answering and streaming meanwhile.
 */
const MAIN_THREAD_CACHE_BYTES = 4 * 1024 * 1024
const PARSE_CONCURRENCY = 8
/**
 * How long after its last change a log keeps its read checkpoint in the saved
 * index. Sessions that grow are recent ones; an older log that grows again is
 * read in full once, which keeps checkpoints of thousands of finished
 * sessions out of the index.
 */
const CHECKPOINT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000
const AUTO_REFRESH_INTERVAL_MS = 60_000
const HARNESS_USAGE_CACHE_MS = 5_000
/** Local provider archives in scan order. Each adapter owns its CLI home and file layout. */
const LOCAL_USAGE_SOURCES: readonly UsageHistorySource<ProviderId, LocalUsageRecord>[] = [
  CLAUDE_USAGE_HISTORY,
  CODEX_USAGE_HISTORY,
  GROK_USAGE_HISTORY,
  OPENCODE_USAGE_HISTORY,
]
/**
 * Every provider the usage page reports, in display order. Providers without
 * a local archive are counted from Harness's own usage events alone.
 */
const REPORTED_PROVIDERS = [
  'claude-code',
  'codex',
  'grok',
  'cursor',
  'opencode',
  'antigravity',
  'acp',
  'api',
] as const satisfies readonly ProviderId[]
const BACKGROUND_SCAN_FAILURE = 'Usage indexing failed in the background:'

type TokenCounts = LocalUsageRecord['tokens']

export type CachedUsageFile = {
  path: string
  provider: ProviderId
  /** The provider account whose folder holds this file; absent for the default account. */
  accountId?: AccountId
  mtimeMs: number
  size: number
  entries: LocalUsageRecord[]
  /** Where the last read of an append-only log stopped, so the next one reads only what follows. */
  checkpoint?: UsageCheckpoint
}

export type UsageCache = {
  version: number
  generatedAt: number
  files: CachedUsageFile[]
  sources: SourceState[]
  warnings: string[]
}

type UsageFile = UsageArchiveFile<LocalUsageRecord> & {
  provider: ProviderId
  accountId?: AccountId
}

export type SourceState = {
  provider: ProviderId
  /** The account whose folder holds this archive; absent for the default account. */
  accountId?: AccountId
  /** The adapter's name for a local archive; event-only providers have none. */
  label?: string
  available: boolean
}

/** Where one local source's archive lives, resolved once on the main thread. */
export type UsageSourceRoot = {
  provider: ProviderId
  /** The account whose folder holds this archive; absent for the default account. */
  accountId?: AccountId
  root: string
}

/** A provider account beyond the default one, whose own CLI folder holds its history. */
export type UsageAccountHome = {
  provider: ProviderId
  accountId: AccountId
  home: string
}

type MutableBucket = {
  totals: UsageHistoryTotals
  sessions: Set<string>
}

export type UsageScanProgress = {
  filesProcessed: number
  filesTotal: number
}

/**
 * Which version of a file the index holds; a file that still matches is not
 * parsed again, and a grown log is read on from its checkpoint.
 */
export type UsageFileFingerprint = Pick<
  CachedUsageFile,
  'path' | 'provider' | 'accountId' | 'mtimeMs' | 'size' | 'checkpoint'
>

export type UsageScanRequest = {
  sources: UsageSourceRoot[]
  indexed: UsageFileFingerprint[]
}

/** A file parsed in a scan. `appended` entries add to the indexed ones instead of replacing them. */
export type ParsedUsageFile = CachedUsageFile & { appended: boolean }

export type UsageScanResult = {
  /** Every archive file that exists now, in discovery order. */
  paths: string[]
  /** The files parsed in this scan. Any other path keeps the entries already indexed for it. */
  files: ParsedUsageFile[]
  sources: SourceState[]
  warnings: string[]
}

export type UsageScanRunner = (
  request: UsageScanRequest,
  onProgress: (progress: UsageScanProgress) => void,
  signal: AbortSignal,
) => Promise<UsageScanResult>

/** A saved index as read back. `current` is false when the file must be saved again as is. */
export type LoadedUsageCache = { cache: UsageCache; current: boolean }

export type UsageCacheLoader = (filePath: string, signal: AbortSignal) => Promise<LoadedUsageCache>

type UsageHistoryOptions = {
  cacheFile: string
  /** Archive locations by provider in place of each adapter's default; tests use fixtures. */
  sourceRoots?: Partial<Record<ProviderId, string>>
  /**
   * The provider accounts beyond the default ones. Asked at the start of every
   * scan, so an account added or removed meanwhile is read or left out then.
   */
  accountHomes?: () => readonly UsageAccountHome[]
  harnessUsage?: () => StoredUsageEvent[]
  now?: () => Date
  scanRunner?: UsageScanRunner
  /** Reads a saved index too large to parse on the event loop; production uses the worker. */
  largeCacheLoader?: UsageCacheLoader
}

type AttributedUsageRecord = LocalUsageRecord & { provider: ProviderId; accountId?: AccountId }

/** One provider account, whose usage a request can ask for alone. */
export type UsageHistoryAccount = { provider: ProviderId; accountId: AccountId }

const accountKey = (provider: ProviderId, accountId: AccountId | undefined) =>
  `${provider}\u0000${accountId ?? DEFAULT_ACCOUNT_ID}`

/** Everything in a usage.history result that is derived from the indexed records. */
type UsageHistoryFigures = Omit<UsageHistoryResult, 'generatedAt' | 'scan' | 'warnings'>

/**
 * One range's figures and the inputs they came from. Each input is replaced,
 * never mutated, so comparing references tells whether the figures still hold.
 */
type AggregateMemo = {
  cache: UsageCache | undefined
  harness: readonly StoredUsageEvent[]
  sources: readonly SourceState[]
  endDate: string
  figures: UsageHistoryFigures
}

const emptyTotals = (): UsageHistoryTotals => ({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  processedTokens: 0,
  estimatedCostUsd: 0,
  cacheSavingsUsd: 0,
  providerReportedCostUsd: 0,
  providerReportedTokens: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
})

/**
 * Builds model-attributed usage from the provider histories already present on
 * the machine. Per-file aggregates are cached under the app data directory;
 * later loads only reparse files whose size or mtime changed, and a grown
 * append-only log only from where its last read stopped.
 */
export class UsageHistoryService {
  readonly #cacheFile: string
  readonly #sourceRoots: UsageSourceRoot[]
  readonly #accountHomes: () => readonly UsageAccountHome[]
  readonly #harnessUsage: () => StoredUsageEvent[]
  readonly #now: () => Date
  readonly #scanRunner: UsageScanRunner
  readonly #largeCacheLoader: UsageCacheLoader
  /** Aborted on dispose, which stops a saved index still being read in the worker. */
  readonly #lifetime = new AbortController()
  #cache: UsageCache | undefined
  /** Whether the cache file holds `#cache`; a scan that changes nothing then skips the write. */
  #cacheSaved = false
  /** When the last completed scan started, or the saved index's time before the first one. */
  #generatedAt = 0
  #cacheLoading: Promise<UsageCache> | undefined
  #refreshing: Promise<void> | undefined
  #resetting: Promise<void> | undefined
  #scanAbort: AbortController | undefined
  #disposed = false
  #lastRefreshStartedAt: number | undefined
  #harnessUsageLoadedAt = 0
  #harnessUsageCache: StoredUsageEvent[] | undefined
  /** Pages poll usage.history every 500 ms while a scan runs; most polls change nothing. */
  readonly #aggregates = new Map<string, AggregateMemo>()
  #sources: SourceState[] = emptySources()
  #scanWarnings: string[] = []
  #scan: UsageHistoryResult['scan'] = {
    status: 'idle',
    filesProcessed: 0,
    filesTotal: 0,
  }

  constructor(options: UsageHistoryOptions) {
    this.#cacheFile = options.cacheFile
    this.#sourceRoots = LOCAL_USAGE_SOURCES.map((source) => ({
      provider: source.provider,
      root: options.sourceRoots?.[source.provider] ?? source.root(),
    }))
    this.#accountHomes = options.accountHomes ?? (() => [])
    this.#harnessUsage = options.harnessUsage ?? (() => [])
    this.#now = options.now ?? (() => new Date())
    this.#scanRunner = options.scanRunner ?? runUsageScanWorker
    this.#largeCacheLoader = options.largeCacheLoader ?? loadUsageCacheInWorker
  }

  /** Starts indexing without putting it on the server startup or request path. */
  async startBackgroundRefresh(): Promise<void> {
    await this.#loadCache()
    this.#startRefresh()
  }

  /** Every account's usage, or with `account` that account's alone. */
  async history(
    range: UsageHistoryRange,
    refresh = false,
    account?: UsageHistoryAccount,
  ): Promise<UsageHistoryResult> {
    await this.#loadCache()
    const now = this.#now().getTime()
    if (refresh) this.#harnessUsageLoadedAt = 0
    if (
      refresh ||
      this.#lastRefreshStartedAt === undefined ||
      now - this.#lastRefreshStartedAt >= AUTO_REFRESH_INTERVAL_MS
    ) {
      this.#startRefresh()
    }
    return this.#aggregate(range, account)
  }

  async waitForRefresh(): Promise<void> {
    await this.#refreshing
  }

  /** Clears only the generated index, then reparses every provider archive. */
  async resetAndRefresh(): Promise<void> {
    if (this.#disposed) throw new Error('Usage history is unavailable after shutdown.')
    if (this.#resetting) return this.#resetting

    const resetting = this.#performReset()
    this.#resetting = resetting
    try {
      await resetting
    } finally {
      if (this.#resetting === resetting) this.#resetting = undefined
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#lifetime.abort()
    this.#scanAbort?.abort()
    this.#scanAbort = undefined
  }

  async #performReset(): Promise<void> {
    await this.#loadCache()
    this.#scanAbort?.abort()
    await this.#refreshing
    await rm(this.#cacheFile, { force: true })

    const cache = emptyUsageCache()
    this.#cache = cache
    this.#cacheSaved = false
    this.#generatedAt = 0
    this.#cacheLoading = Promise.resolve(cache)
    this.#sources = cache.sources
    this.#scanWarnings = []
    this.#scan = { status: 'idle', filesProcessed: 0, filesTotal: 0 }
    this.#lastRefreshStartedAt = undefined
    this.#harnessUsageCache = undefined
    this.#harnessUsageLoadedAt = 0
    this.#aggregates.clear()
    this.#startRefresh()
  }

  async #loadCache(): Promise<UsageCache> {
    if (this.#cache) return this.#cache
    if (!this.#cacheLoading) {
      this.#cacheLoading = loadSavedUsageCache(
        this.#cacheFile,
        this.#largeCacheLoader,
        this.#lifetime.signal,
      ).then(({ cache, current }) => {
        this.#cache = cache
        this.#cacheSaved = current
        this.#generatedAt = cache.generatedAt
        this.#sources = cache.sources
        this.#scanWarnings = cache.warnings
        return cache
      })
    }
    return this.#cacheLoading
  }

  #startRefresh(): void {
    if (this.#refreshing || this.#disposed) return
    const generatedAt = this.#now().getTime()
    this.#lastRefreshStartedAt = generatedAt
    this.#scan = { status: 'scanning', filesProcessed: 0, filesTotal: 0 }
    const base = this.#cache ?? emptyUsageCache()
    // The worker gets fingerprints only; the entries stay here instead of being
    // re-read from disk by the worker and cloned back after every scan.
    const request: UsageScanRequest = {
      sources: this.#roots(),
      indexed: base.files.map((file) => ({
        path: file.path,
        provider: file.provider,
        ...(file.accountId === undefined ? {} : { accountId: file.accountId }),
        mtimeMs: file.mtimeMs,
        size: file.size,
        ...(file.checkpoint && keepsCheckpoint(file, generatedAt)
          ? { checkpoint: file.checkpoint }
          : {}),
      })),
    }
    const abort = new AbortController()
    this.#scanAbort = abort
    this.#refreshing = Promise.resolve()
      .then(() =>
        this.#scanRunner(
          request,
          (progress) => {
            this.#scan = { status: 'scanning', ...progress }
          },
          abort.signal,
        ),
      )
      .then((result) => {
        if (!abort.signal.aborted) return this.#applyScan(base, result, generatedAt)
      })
      .catch((error: unknown) => {
        if (this.#disposed) return
        this.#scanWarnings = [
          ...this.#scanWarnings.filter((warning) => !warning.startsWith(BACKGROUND_SCAN_FAILURE)),
          `${BACKGROUND_SCAN_FAILURE} ${messageOf(error)}`,
        ]
      })
      .finally(() => {
        this.#scan = { ...this.#scan, status: 'idle' }
        if (this.#scanAbort === abort) this.#scanAbort = undefined
        this.#refreshing = undefined
      })
  }

  /** Each provider's own archive, then every other account's archive inside its folder. */
  #roots(): UsageSourceRoot[] {
    let homes: readonly UsageAccountHome[]
    try {
      homes = this.#accountHomes()
    } catch {
      // The default accounts' usage still counts when the account list cannot be read.
      homes = []
    }
    const accountRoots = homes.flatMap(({ provider, accountId, home }) => {
      const source = LOCAL_USAGE_SOURCES.find((candidate) => candidate.provider === provider)
      if (!source || accountId === DEFAULT_ACCOUNT_ID) return []
      return [{ provider, accountId, root: source.root(home) }]
    })
    return [...this.#sourceRoots, ...accountRoots]
  }

  /**
   * Folds a scan into the index. A scan that finds nothing new keeps the same
   * index object, so computed figures stay valid, and does not rewrite the file.
   */
  async #applyScan(base: UsageCache, result: UsageScanResult, generatedAt: number): Promise<void> {
    if (this.#cache !== base) return
    const cache = mergeScan(base, result, generatedAt)
    if (cache !== base) {
      this.#cache = cache
      this.#sources = cache.sources
      this.#cacheSaved = false
    }
    this.#generatedAt = generatedAt
    this.#scanWarnings = cache.warnings
    if (this.#cacheSaved) return
    try {
      await writeCache(this.#cacheFile, {
        ...cache,
        generatedAt,
        files: cache.files.map((file) =>
          file.checkpoint && !keepsCheckpoint(file, generatedAt) ? withoutCheckpoint(file) : file,
        ),
      })
      this.#cacheSaved = true
    } catch {
      this.#scanWarnings = [
        ...cache.warnings,
        'Usage was loaded, but its local scan cache could not be saved.',
      ]
    }
  }

  #aggregate(
    range: UsageHistoryRange,
    account: UsageHistoryAccount | undefined,
  ): UsageHistoryResult {
    const now = this.#now()
    const endDate = localDateKey(now)
    const harness = this.#cachedHarnessUsage(now.getTime())
    const memoKey = account
      ? `${range}\u0000${accountKey(account.provider, account.accountId)}`
      : range
    let memo = this.#aggregates.get(memoKey)
    if (
      !memo ||
      memo.cache !== this.#cache ||
      memo.harness !== harness ||
      memo.sources !== this.#sources ||
      memo.endDate !== endDate
    ) {
      memo = {
        cache: this.#cache,
        harness,
        sources: this.#sources,
        endDate,
        figures: this.#figures(range, endDate, harness, account),
      }
      this.#aggregates.set(memoKey, memo)
    }

    const { figures } = memo
    const warnings = [...this.#scanWarnings]
    if (figures.totals.unpricedTokens > 0) {
      warnings.push('Some token records use models without a known public API price.')
    }
    return {
      range: figures.range,
      startDate: figures.startDate,
      endDate: figures.endDate,
      generatedAt: this.#generatedAt,
      sessionCount: figures.sessionCount,
      activeDays: figures.activeDays,
      totals: figures.totals,
      providers: figures.providers,
      models: figures.models,
      daily: figures.daily,
      sources: figures.sources,
      scan: { ...this.#scan },
      warnings,
    }
  }

  /**
   * A provider's usage on accounts beyond its default one is split into a row
   * per account; with `account`, only that account's usage counts.
   */
  #figures(
    range: UsageHistoryRange,
    endDate: string,
    harness: readonly StoredUsageEvent[],
    account: UsageHistoryAccount | undefined,
  ): UsageHistoryFigures {
    const files = this.#cache?.files ?? []
    const richAccounts = new Set<string>()
    for (const file of files) {
      if (file.entries.length > 0) richAccounts.add(accountKey(file.provider, file.accountId))
    }
    const harnessEntries = harnessUsageRecords(harness, richAccounts)
    const wanted = account && accountKey(account.provider, account.accountId)
    /** Providers with usage on another account than the default one, at any date. */
    const splitProviders = new Set<ProviderId>()
    const accountBuckets = new Map<
      string,
      MutableBucket & { provider: ProviderId; accountId: AccountId }
    >()
    // 'all' starts at the earliest record, so it only needs the end bound.
    const fixedStartDate = range === 'all' ? undefined : rangeStartDate(range, endDate, undefined)
    let earliestDate: string | undefined
    const providerSessions = new Map<ProviderId, Set<string>>()
    /** Rates by model and date; the price table is string matching, so each pair is looked up once. */
    const rates = new Map<string, ModelRate | null>()

    const totals = emptyTotals()
    const sessions = new Set<string>()
    const providerBuckets = new Map<ProviderId, MutableBucket>()
    const modelBuckets = new Map<
      string,
      MutableBucket & { provider: ProviderId; model: string; pricing: UsageHistoryModel['pricing'] }
    >()
    const dayBuckets = new Map<
      string,
      MutableBucket & { providers: Map<ProviderId, { tokens: number; estimatedCostUsd: number }> }
    >()

    const addRecord = (
      providerId: ProviderId,
      accountId: AccountId | undefined,
      entry: LocalUsageRecord,
    ) => {
      const key = accountKey(providerId, accountId)
      if (wanted !== undefined && key !== wanted) return
      if (accountId !== undefined && accountId !== DEFAULT_ACCOUNT_ID) {
        splitProviders.add(providerId)
      }
      if (!earliestDate || entry.date < earliestDate) earliestDate = entry.date
      let knownSessions = providerSessions.get(providerId)
      if (!knownSessions) {
        knownSessions = new Set()
        providerSessions.set(providerId, knownSessions)
      }
      knownSessions.add(entry.sessionId)
      if (entry.date > endDate || (fixedStartDate !== undefined && entry.date < fixedStartDate)) {
        return
      }

      const sessionKey = `${providerId}:${entry.sessionId}`
      const rateKey = `${entry.model}\u0000${entry.date}`
      let rate = rates.get(rateKey)
      if (rate === undefined) {
        rate = modelRate(entry.model, entry.date) ?? null
        rates.set(rateKey, rate)
      }
      const priced = priceEntry(rate, entry.tokens, entry.longContext)
      addEntry(totals, entry.tokens, priced)
      sessions.add(sessionKey)

      const provider = getBucket(providerBuckets, providerId)
      addEntry(provider.totals, entry.tokens, priced)
      provider.sessions.add(sessionKey)
      let accountBucket = accountBuckets.get(key)
      if (!accountBucket) {
        accountBucket = {
          ...newBucket(),
          provider: providerId,
          accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        }
        accountBuckets.set(key, accountBucket)
      }
      addEntry(accountBucket.totals, entry.tokens, priced)
      accountBucket.sessions.add(sessionKey)

      const modelKey = `${providerId}:${entry.model}`
      let model = modelBuckets.get(modelKey)
      if (!model) {
        model = {
          ...newBucket(),
          provider: providerId,
          model: entry.model,
          pricing: priced.pricing,
        }
        modelBuckets.set(modelKey, model)
      }
      addEntry(model.totals, entry.tokens, priced)
      model.sessions.add(sessionKey)
      model.pricing = lessCertainPricing(model.pricing, priced.pricing)

      let day = dayBuckets.get(entry.date)
      if (!day) {
        day = { ...newBucket(), providers: new Map() }
        dayBuckets.set(entry.date, day)
      }
      addEntry(day.totals, entry.tokens, priced)
      day.sessions.add(sessionKey)
      const providerDay = day.providers.get(providerId) ?? {
        tokens: 0,
        estimatedCostUsd: 0,
      }
      providerDay.tokens += processedTokens(entry.tokens)
      providerDay.estimatedCostUsd +=
        entry.tokens.providerReportedCostUsd > 0
          ? entry.tokens.providerReportedCostUsd
          : priced.estimatedCostUsd
      day.providers.set(providerId, providerDay)
    }
    for (const file of files) {
      for (const entry of file.entries) addRecord(file.provider, file.accountId, entry)
    }
    for (const entry of harnessEntries) addRecord(entry.provider, entry.accountId, entry)
    const startDate = fixedStartDate ?? rangeStartDate(range, endDate, earliestDate)

    // An account asked for alone names itself, as does every account of a split provider.
    const byAccount = (provider: ProviderId) =>
      account !== undefined || splitProviders.has(provider)
    const providers: UsageHistoryProvider[] = [
      ...[...providerBuckets]
        .filter(([provider]) => !byAccount(provider))
        .map(([provider, bucket]) => ({
          provider,
          sessionCount: bucket.sessions.size,
          totals: bucket.totals,
        })),
      ...[...accountBuckets.values()]
        .filter((bucket) => byAccount(bucket.provider))
        .map((bucket) => ({
          provider: bucket.provider,
          accountId: bucket.accountId,
          sessionCount: bucket.sessions.size,
          totals: bucket.totals,
        })),
    ].sort((a, b) => b.totals.estimatedCostUsd - a.totals.estimatedCostUsd)

    const models: UsageHistoryModel[] = [...modelBuckets.values()]
      .map((bucket) => ({
        provider: bucket.provider,
        model: bucket.model,
        sessionCount: bucket.sessions.size,
        pricing: bucket.pricing,
        totals: bucket.totals,
      }))
      .sort(
        (a, b) =>
          b.totals.estimatedCostUsd - a.totals.estimatedCostUsd ||
          b.totals.processedTokens - a.totals.processedTokens,
      )

    const daily: UsageHistoryDay[] = dateKeysBetween(startDate, endDate).map((date) => {
      const bucket = dayBuckets.get(date)
      return {
        date,
        sessionCount: bucket?.sessions.size ?? 0,
        totals: bucket?.totals ?? emptyTotals(),
        providers: bucket
          ? [...bucket.providers.entries()]
              .map(([provider, values]) => ({ provider, ...values }))
              .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
          : [],
      }
    })

    const sourceStates =
      wanted === undefined
        ? this.#sources
        : this.#sources.filter((source) => accountKey(source.provider, source.accountId) === wanted)
    const sourceProviders = new Set<ProviderId>([
      ...sourceStates.map((source) => source.provider),
      ...providerSessions.keys(),
    ])
    const sources = [...sourceProviders].map((provider) => {
      // A provider's history is there when any of its accounts' archives is.
      const archived = sourceStates.some(
        (source) => source.provider === provider && source.available,
      )
      const sessionCount = providerSessions.get(provider)?.size ?? 0
      return { provider, available: archived || sessionCount > 0, sessionCount }
    })

    return {
      range,
      startDate,
      endDate,
      sessionCount: sessions.size,
      activeDays: daily.filter((day) => day.totals.processedTokens > 0).length,
      totals,
      providers,
      models,
      daily,
      sources,
    }
  }

  #cachedHarnessUsage(now: number): StoredUsageEvent[] {
    if (!this.#harnessUsageCache || now - this.#harnessUsageLoadedAt >= HARNESS_USAGE_CACHE_MS) {
      this.#harnessUsageCache = this.#harnessUsage()
      this.#harnessUsageLoadedAt = now
    }
    return this.#harnessUsageCache
  }
}

/**
 * Performs the expensive archive walk. Production calls this inside a Worker.
 * It parses only files that differ from the indexed fingerprints and returns
 * just those, so neither side copies the whole index.
 */
export async function runUsageHistoryScan(
  request: UsageScanRequest,
  onProgress: (progress: UsageScanProgress) => void = () => undefined,
): Promise<UsageScanResult> {
  const { files, sources } = await discoverUsageSources(request.sources)
  const indexed = new Map(request.indexed.map((file) => [file.path, file]))
  const changed = files.filter((file) => {
    const prior = indexed.get(file.path)
    return !(
      prior?.provider === file.provider &&
      prior.accountId === file.accountId &&
      prior.mtimeMs === file.mtimeMs &&
      prior.size === file.size
    )
  })

  const parsed: ParsedUsageFile[] = []
  let failedFiles = 0
  let filesProcessed = files.length - changed.length
  const reportProgress = () => onProgress({ filesProcessed, filesTotal: files.length })
  reportProgress()
  await mapWithConcurrency(changed, PARSE_CONCURRENCY, async (file) => {
    try {
      parsed.push(await parseUsageFile(file, indexed.get(file.path)))
    } catch {
      // The indexed entries, if any, stay until the file can be read again.
      failedFiles += 1
    } finally {
      filesProcessed += 1
      if (filesProcessed === files.length || filesProcessed % 25 === 0) reportProgress()
    }
  })

  const warnings =
    failedFiles > 0
      ? [
          `${failedFiles.toLocaleString()} history ${failedFiles === 1 ? 'file could' : 'files could'} not be read.`,
        ]
      : []
  return { paths: files.map((file) => file.path), files: parsed, sources, warnings }
}

/** Reads a log on from the checkpoint the index holds for it, or a whole file otherwise. */
async function parseUsageFile(
  file: UsageFile,
  prior: UsageFileFingerprint | undefined,
): Promise<ParsedUsageFile> {
  const fingerprint = {
    path: file.path,
    provider: file.provider,
    ...(file.accountId === undefined ? {} : { accountId: file.accountId }),
    mtimeMs: file.mtimeMs,
    size: file.size,
  }
  if (!file.readFrom) {
    return {
      ...fingerprint,
      entries: compactUsageRecords(await file.read(file.path)),
      appended: false,
    }
  }
  // A file that now belongs to another account is read again in full.
  const checkpoint =
    prior?.provider === file.provider && prior.accountId === file.accountId
      ? prior.checkpoint
      : undefined
  const read = await file.readFrom(file.path, checkpoint)
  return {
    ...fingerprint,
    entries: compactUsageRecords(read.entries),
    appended: read.appended,
    ...(read.checkpoint ? { checkpoint: read.checkpoint } : {}),
  }
}

/**
 * Builds the next index from a scan, in discovery order. Returns `base` itself
 * when the scan changed no file, source or warning.
 */
function mergeScan(base: UsageCache, result: UsageScanResult, generatedAt: number): UsageCache {
  const indexed = new Map(base.files.map((file) => [file.path, file]))
  const parsed = new Map(result.files.map((file) => [file.path, file]))
  const files: CachedUsageFile[] = []
  for (const filePath of new Set(result.paths)) {
    const update = parsed.get(filePath)
    const file = update
      ? indexedFile(update, indexed.get(filePath), generatedAt)
      : indexed.get(filePath)
    if (file) files.push(file)
  }
  const unchanged =
    files.length === base.files.length &&
    files.every((file, index) => file === base.files[index]) &&
    JSON.stringify(result.sources) === JSON.stringify(base.sources) &&
    JSON.stringify(result.warnings) === JSON.stringify(base.warnings)
  if (unchanged) return base
  return {
    version: CACHE_VERSION,
    generatedAt,
    files,
    sources: result.sources,
    warnings: result.warnings,
  }
}

/**
 * The index entry for a parsed file. Appended entries are added to the ones
 * already indexed; if those are gone, the file is left out and read in full
 * by the next scan.
 */
function indexedFile(
  update: ParsedUsageFile,
  prior: CachedUsageFile | undefined,
  now: number,
): CachedUsageFile | undefined {
  const { appended, checkpoint, ...file } = update
  if (appended) {
    if (!prior) return undefined
    file.entries = compactUsageRecords([...prior.entries, ...file.entries])
  }
  return checkpoint && keepsCheckpoint(file, now) ? { ...file, checkpoint } : file
}

function keepsCheckpoint(file: Pick<CachedUsageFile, 'mtimeMs'>, now: number): boolean {
  return now - file.mtimeMs <= CHECKPOINT_RETENTION_MS
}

function withoutCheckpoint(file: CachedUsageFile): CachedUsageFile {
  const { checkpoint: _checkpoint, ...rest } = file
  return rest
}

/** A damaged checkpoint costs one full read of its file, not the whole index. */
function withValidCheckpoint(file: CachedUsageFile): CachedUsageFile {
  return file.checkpoint === undefined || isUsageCheckpoint(file.checkpoint)
    ? file
    : withoutCheckpoint(file)
}

export async function readUsageCache(filePath: string): Promise<UsageCache> {
  return (await loadUsageCache(filePath)).cache
}

/**
 * Reads the saved index on the event loop when it is small, otherwise with the
 * large-index loader. If that loader fails, the index is still read here: a
 * slow read beats discarding it and reparsing every archive.
 */
async function loadSavedUsageCache(
  filePath: string,
  loadLarge: UsageCacheLoader,
  signal: AbortSignal,
): Promise<LoadedUsageCache> {
  const size = await stat(filePath).then(
    (stats) => stats.size,
    () => 0,
  )
  if (size <= MAIN_THREAD_CACHE_BYTES) return loadUsageCache(filePath)
  try {
    return await loadLarge(filePath, signal)
  } catch {
    // Stopped by dispose: nothing reads the index any more, and an empty index
    // marked as saved can never overwrite the file.
    if (signal.aborted) return { cache: emptyUsageCache(), current: true }
    return loadUsageCache(filePath)
  }
}

/** Reads the saved index on the calling thread; a missing or damaged file reads as empty. */
export async function loadUsageCache(filePath: string): Promise<LoadedUsageCache> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<UsageCache>
    const uncompacted = value.version === UNCOMPACTED_CACHE_VERSION
    if ((value.version === CACHE_VERSION || uncompacted) && isCachedUsageFiles(value.files)) {
      const cachedProviders = new Set(value.files.map((file) => file.provider))
      const cache: UsageCache = {
        version: CACHE_VERSION,
        generatedAt: typeof value.generatedAt === 'number' ? value.generatedAt : 0,
        files: uncompacted
          ? value.files.map((file) => ({ ...file, entries: compactUsageRecords(file.entries) }))
          : value.files.map(withValidCheckpoint),
        sources: Array.isArray(value.sources)
          ? mergeSources(value.sources)
          : emptySources().map((source) => ({
              ...source,
              available: cachedProviders.has(source.provider),
            })),
        warnings: Array.isArray(value.warnings)
          ? value.warnings.filter((warning): warning is string => typeof warning === 'string')
          : [],
      }
      return { cache, current: !uncompacted }
    }
  } catch {
    // A missing or interrupted cache write is equivalent to a cold start.
  }
  return { cache: emptyUsageCache(), current: false }
}

/**
 * Merges the records of one file that no usage figure can tell apart: same day,
 * model, session and long-context flag, and either all or none carrying a
 * provider-reported cost. Pricing and every total are linear in the token
 * counts, so a merged record adds up to exactly what its members did. Claude
 * Code logs one record per message, which made the cache grow by megabytes a
 * day; this keeps one record per session, model and day.
 */
export function compactUsageRecords(entries: readonly LocalUsageRecord[]): LocalUsageRecord[] {
  const merged = new Map<string, LocalUsageRecord>()
  for (const entry of entries) {
    const key = [
      entry.date,
      entry.model,
      entry.sessionId,
      entry.longContext,
      entry.tokens.providerReportedCostUsd > 0,
    ].join('\u0000')
    const prior = merged.get(key)
    merged.set(
      key,
      prior ? { ...prior, tokens: addTokenCounts(prior.tokens, entry.tokens) } : entry,
    )
  }
  return [...merged.values()]
}

/**
 * Sums two records' counts without changing what the aggregation reads. A
 * provider total present on only one side is completed from the other side's
 * parts, which is the value the aggregation would have derived for it.
 */
function addTokenCounts(left: TokenCounts, right: TokenCounts): TokenCounts {
  const tokens: TokenCounts = {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWrite5mInputTokens: left.cacheWrite5mInputTokens + right.cacheWrite5mInputTokens,
    cacheWrite1hInputTokens: left.cacheWrite1hInputTokens + right.cacheWrite1hInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    providerReportedCostUsd: left.providerReportedCostUsd + right.providerReportedCostUsd,
  }
  if (left.observedInputTokens !== undefined || right.observedInputTokens !== undefined) {
    tokens.observedInputTokens = observedInputTokens(left) + observedInputTokens(right)
  }
  if (left.processedTokens !== undefined || right.processedTokens !== undefined) {
    tokens.processedTokens = processedTokens(left) + processedTokens(right)
  }
  return tokens
}

function observedInputTokens(tokens: TokenCounts): number {
  return (
    tokens.observedInputTokens ??
    tokens.uncachedInputTokens +
      tokens.cachedInputTokens +
      tokens.cacheWrite5mInputTokens +
      tokens.cacheWrite1hInputTokens
  )
}

function isCachedUsageFiles(value: unknown): value is CachedUsageFile[] {
  return Array.isArray(value) && value.every(isCachedUsageFile)
}

function isCachedUsageFile(value: unknown): value is CachedUsageFile {
  const file = objectValue(value)
  return Boolean(
    file &&
    typeof file['path'] === 'string' &&
    LOCAL_USAGE_SOURCES.some((source) => source.provider === file['provider']) &&
    (file['accountId'] === undefined || AccountIdSchema.safeParse(file['accountId']).success) &&
    nonNegativeNumber(file['mtimeMs']) &&
    nonNegativeNumber(file['size']) &&
    Array.isArray(file['entries']) &&
    file['entries'].every(isLocalUsageRecord),
  )
}

function isLocalUsageRecord(value: unknown): value is LocalUsageRecord {
  const entry = objectValue(value)
  const tokens = objectValue(entry?.['tokens'])
  if (
    !entry ||
    !tokens ||
    typeof entry['date'] !== 'string' ||
    typeof entry['model'] !== 'string' ||
    typeof entry['sessionId'] !== 'string' ||
    typeof entry['longContext'] !== 'boolean'
  ) {
    return false
  }
  const requiredCounts = [
    'uncachedInputTokens',
    'cachedInputTokens',
    'cacheWrite5mInputTokens',
    'cacheWrite1hInputTokens',
    'outputTokens',
    'reasoningTokens',
    'providerReportedCostUsd',
  ] as const
  if (!requiredCounts.every((field) => nonNegativeNumber(tokens[field]))) return false
  return ['observedInputTokens', 'processedTokens'].every(
    (field) => tokens[field] === undefined || nonNegativeNumber(tokens[field]),
  )
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function emptyUsageCache(): UsageCache {
  return {
    version: CACHE_VERSION,
    generatedAt: 0,
    files: [],
    sources: emptySources(),
    warnings: [],
  }
}

/** One job for the usage worker: index changed archive files, or read a saved index. */
export type UsageWorkerJob =
  { kind: 'scan'; request: UsageScanRequest } | { kind: 'load'; cacheFile: string }

export type UsageWorkerMessage =
  | { type: 'progress'; progress: UsageScanProgress }
  | { type: 'complete'; result: UsageScanResult | LoadedUsageCache }
  | { type: 'error'; message: string }

function runUsageScanWorker(
  request: UsageScanRequest,
  onProgress: (progress: UsageScanProgress) => void,
  signal: AbortSignal,
): Promise<UsageScanResult> {
  return runUsageWorker({ kind: 'scan', request }, signal, onProgress)
}

/** Parses, validates and compacts the saved index off the event loop; only the result is cloned back. */
function loadUsageCacheInWorker(cacheFile: string, signal: AbortSignal): Promise<LoadedUsageCache> {
  return runUsageWorker({ kind: 'load', cacheFile }, signal)
}

function runUsageWorker<Result>(
  job: UsageWorkerJob,
  signal: AbortSignal,
  onProgress: (progress: UsageScanProgress) => void = () => undefined,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
    const worker = new Worker(
      new URL(`./usage-history-worker.${sourceExtension}`, import.meta.url),
      {
        workerData: job,
        name: 'harness-usage-index',
        execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      },
    )
    let settled = false
    const settle = () => {
      settled = true
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      if (settled) return
      settle()
      void worker.terminate().then(
        () => reject(new Error('Usage indexing was stopped.')),
        (error: unknown) => reject(error),
      )
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.on('message', (message: UsageWorkerMessage) => {
      if (settled) return
      if (message.type === 'progress') {
        onProgress(message.progress)
        return
      }
      settle()
      if (message.type === 'complete') resolve(message.result as Result)
      else reject(new Error(message.message))
    })
    worker.on('error', (error) => {
      if (settled) return
      settle()
      reject(error)
    })
    worker.on('exit', (code) => {
      if (settled) return
      settle()
      reject(new Error(`Usage index worker exited with code ${code}`))
    })
    if (signal.aborted) abort()
  })
}

function emptySources(): SourceState[] {
  return REPORTED_PROVIDERS.map((provider) => {
    const local = LOCAL_USAGE_SOURCES.find((source) => source.provider === provider)
    return { provider, ...(local ? { label: local.label } : {}), available: false }
  })
}

const sourceKey = (source: Pick<SourceState, 'provider' | 'accountId'>) =>
  `${source.provider}\u0000${source.accountId ?? DEFAULT_ACCOUNT_ID}`

/** Every reported provider's default source, then each other account's, by provider and account. */
function mergeSources(sources: readonly SourceState[]): SourceState[] {
  const merged = new Map(emptySources().map((source) => [sourceKey(source), source]))
  for (const source of sources) {
    if (source.accountId !== undefined && !AccountIdSchema.safeParse(source.accountId).success) {
      continue
    }
    // Another account's archive is one more archive of a provider already listed.
    const listed = merged.get(sourceKey({ provider: source.provider }))
    if (listed) merged.set(sourceKey(source), { ...listed, ...source })
  }
  return [...merged.values()]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function discoverUsageSources(
  roots: readonly UsageSourceRoot[],
): Promise<{ files: UsageFile[]; sources: SourceState[] }> {
  const discovered = await Promise.all(
    roots.flatMap((root) => {
      const source = LOCAL_USAGE_SOURCES.find((candidate) => candidate.provider === root.provider)
      return source ? [discoverSource(source, root)] : []
    }),
  )
  // A file two archives share, as in one folder inside another, counts once:
  // for the first archive, the default account's before any other.
  const seen = new Set<string>()
  const files = discovered
    .flatMap((source) => source.files)
    .filter((file) => {
      const key = process.platform === 'linux' ? file.path : file.path.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  return {
    files,
    sources: mergeSources(discovered.map(({ files: _files, ...source }) => source)),
  }
}

async function discoverSource(
  source: UsageHistorySource<ProviderId, LocalUsageRecord>,
  { root, accountId }: UsageSourceRoot,
): Promise<SourceState & { label: string; files: UsageFile[] }> {
  const { provider, label } = source
  const account = accountId === undefined ? {} : { accountId }
  try {
    const archive = await source.discover(root)
    return {
      provider,
      ...account,
      label,
      available: archive.available,
      files: archive.files.map((file) => ({ ...file, provider, ...account })),
    }
  } catch {
    return { provider, ...account, label, available: false, files: [] }
  }
}

/**
 * Usage from TasteCode's own events, for each provider account without
 * records of its own in the local archives, which count more.
 */
function harnessUsageRecords(
  events: readonly StoredUsageEvent[],
  richerLocalAccounts: ReadonlySet<string>,
): AttributedUsageRecord[] {
  const records: AttributedUsageRecord[] = []
  const previous = new Map<string, TokenCounts>()

  for (const event of events) {
    if (richerLocalAccounts.has(accountKey(event.provider, event.accountId))) continue
    const sessionKey = `${event.provider}:${event.threadId}`
    const current = usageTokenCounts(event.usage)
    const tokens = event.usage.cumulative
      ? subtractTokenCounts(current, previous.get(sessionKey))
      : current
    if (event.usage.cumulative) previous.set(sessionKey, current)
    if (processedTokens(tokens) <= 0 && tokens.providerReportedCostUsd <= 0) continue

    const inputForThreshold =
      event.usage.inputIncludesCached === false
        ? event.usage.inputTokens + event.usage.cachedInputTokens
        : event.usage.inputTokens
    const model = event.usage.model ?? 'Unknown model'
    records.push({
      provider: event.provider,
      ...(event.accountId === undefined ? {} : { accountId: event.accountId }),
      date: localDateKey(new Date(event.at)),
      model,
      sessionId: event.threadId,
      longContext: inputForThreshold > longContextThreshold(model),
      tokens,
    })
  }
  return records
}

function longContextThreshold(model: string): number {
  const value = model.toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
  return value.includes('grok-4-5') || /gemini-(?:3-1|2-5)-pro/.test(value) ? 200_000 : 272_000
}

function usageTokenCounts(usage: Usage): TokenCounts {
  const input = Math.max(usage.inputTokens, 0)
  const cached = Math.max(usage.cachedInputTokens, 0)
  return {
    uncachedInputTokens: usage.inputIncludesCached === false ? input : Math.max(input - cached, 0),
    cachedInputTokens: cached,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    outputTokens: Math.max(usage.outputTokens, 0),
    reasoningTokens: Math.max(usage.reasoningTokens, 0),
    providerReportedCostUsd: Math.max(usage.costUsd ?? 0, 0),
  }
}

function subtractTokenCounts(current: TokenCounts, prior: TokenCounts | undefined): TokenCounts {
  const delta = (value: number, previous: number) => (value >= previous ? value - previous : value)
  return {
    uncachedInputTokens: delta(current.uncachedInputTokens, prior?.uncachedInputTokens ?? 0),
    cachedInputTokens: delta(current.cachedInputTokens, prior?.cachedInputTokens ?? 0),
    cacheWrite5mInputTokens: delta(
      current.cacheWrite5mInputTokens,
      prior?.cacheWrite5mInputTokens ?? 0,
    ),
    cacheWrite1hInputTokens: delta(
      current.cacheWrite1hInputTokens,
      prior?.cacheWrite1hInputTokens ?? 0,
    ),
    outputTokens: delta(current.outputTokens, prior?.outputTokens ?? 0),
    reasoningTokens: delta(current.reasoningTokens, prior?.reasoningTokens ?? 0),
    providerReportedCostUsd: delta(
      current.providerReportedCostUsd,
      prior?.providerReportedCostUsd ?? 0,
    ),
  }
}

function addEntry(
  totals: UsageHistoryTotals,
  tokens: TokenCounts,
  priced: ReturnType<typeof priceEntry>,
): void {
  const processed = processedTokens(tokens)
  const cacheWriteInputTokens = tokens.cacheWrite5mInputTokens + tokens.cacheWrite1hInputTokens
  totals.uncachedInputTokens +=
    tokens.observedInputTokens === undefined
      ? tokens.uncachedInputTokens
      : tokens.observedInputTokens - tokens.cachedInputTokens - cacheWriteInputTokens
  totals.cachedInputTokens += tokens.cachedInputTokens
  totals.cacheWriteInputTokens += cacheWriteInputTokens
  totals.outputTokens += tokens.outputTokens
  totals.reasoningTokens += tokens.reasoningTokens
  totals.processedTokens += processed
  totals.estimatedCostUsd +=
    tokens.providerReportedCostUsd > 0 ? tokens.providerReportedCostUsd : priced.estimatedCostUsd
  totals.cacheSavingsUsd += priced.cacheSavingsUsd
  totals.providerReportedCostUsd += tokens.providerReportedCostUsd
  if (tokens.providerReportedCostUsd > 0) {
    totals.providerReportedTokens += processed
  } else if (priced.pricing === 'unpriced') {
    totals.unpricedTokens += processed
  } else {
    totals.pricedTokens += processed
  }
}

function processedTokens(tokens: TokenCounts): number {
  return (
    tokens.processedTokens ??
    (tokens.observedInputTokens ??
      tokens.uncachedInputTokens +
        tokens.cachedInputTokens +
        tokens.cacheWrite5mInputTokens +
        tokens.cacheWrite1hInputTokens) + tokens.outputTokens
  )
}

function getBucket(buckets: Map<ProviderId, MutableBucket>, provider: ProviderId): MutableBucket {
  let bucket = buckets.get(provider)
  if (!bucket) {
    bucket = newBucket()
    buckets.set(provider, bucket)
  }
  return bucket
}

function newBucket(): MutableBucket {
  return { totals: emptyTotals(), sessions: new Set() }
}

function lessCertainPricing(
  left: UsageHistoryModel['pricing'],
  right: UsageHistoryModel['pricing'],
): UsageHistoryModel['pricing'] {
  const rank = { exact: 0, family: 1, unpriced: 2 } as const
  return rank[right] > rank[left] ? right : left
}

function rangeStartDate(
  range: UsageHistoryRange,
  endDate: string,
  earliestDate: string | undefined,
): string {
  if (range === 'all') return earliestDate && earliestDate <= endDate ? earliestDate : endDate
  const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[range]
  return shiftDate(endDate, -(days - 1))
}

function dateKeysBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) dates.push(date)
  return dates
}

function shiftDate(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number)
  const value = new Date(year, month - 1, day)
  value.setDate(value.getDate() + days)
  return localDateKey(value)
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const current = values[index]
        index += 1
        if (current !== undefined) await callback(current)
      }
    }),
  )
}

async function writeCache(filePath: string, cache: UsageCache): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(cache), 'utf8')
  await rename(temporary, filePath)
}
