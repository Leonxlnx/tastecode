import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { readClaudeUsageHistory } from '@harness/adapter-claude-code'
import { readCodexUsageHistory } from '@harness/adapter-codex'
import { readGrokUsageHistory } from '@harness/adapter-grok'
import { readOpenCodeUsageHistory } from '@harness/adapter-opencode'
import type {
  LocalUsageRecord,
  ProviderId,
  Usage,
  UsageHistoryDay,
  UsageHistoryModel,
  UsageHistoryProvider,
  UsageHistoryRange,
  UsageHistoryResult,
  UsageHistoryTotals,
} from '@harness/contracts'
import type { StoredUsageEvent } from './store.js'

const CACHE_VERSION = 7
const PARSE_CONCURRENCY = 8
const AUTO_REFRESH_INTERVAL_MS = 60_000
const HARNESS_USAGE_CACHE_MS = 5_000
const LOCAL_USAGE_PROVIDERS = [
  'codex',
  'claude-code',
  'grok',
  'opencode',
] as const satisfies readonly ProviderId[]
const BACKGROUND_SCAN_FAILURE = 'Usage indexing failed in the background:'

type TokenCounts = LocalUsageRecord['tokens']

export type CachedUsageFile = {
  path: string
  provider: ProviderId
  mtimeMs: number
  size: number
  entries: LocalUsageRecord[]
}

export type UsageCache = {
  version: number
  generatedAt: number
  files: CachedUsageFile[]
  sources: SourceState[]
  warnings: string[]
}

type UsageFile = Omit<CachedUsageFile, 'entries'> & {
  read: (filePath: string) => Promise<LocalUsageRecord[]>
}

export type SourceState = {
  provider: ProviderId
  label: string
  available: boolean
}

type ModelRate = {
  input: number
  cachedInput: number
  output: number
  pricing: 'exact' | 'family'
  longContextMultipliers?: { input: number; output: number }
}

type MutableBucket = {
  totals: UsageHistoryTotals
  sessions: Set<string>
}

export type UsageScanProgress = {
  filesProcessed: number
  filesTotal: number
}

export type UsageScanRequest = {
  cacheFile: string
  codexSessionsRoot: string
  claudeProjectsRoot: string
  grokLogPath: string
  openCodeDataRoot: string
  generatedAt: number
}

export type UsageScanResult = {
  cache: UsageCache
  sources: SourceState[]
  warnings: string[]
}

export type UsageScanRunner = (
  request: UsageScanRequest,
  onProgress: (progress: UsageScanProgress) => void,
  signal: AbortSignal,
) => Promise<UsageScanResult>

type UsageHistoryOptions = {
  cacheFile: string
  codexSessionsRoot?: string
  claudeProjectsRoot?: string
  grokLogPath?: string
  openCodeDataRoot?: string
  harnessUsage?: () => StoredUsageEvent[]
  now?: () => Date
  scanRunner?: UsageScanRunner
}

type AttributedUsageRecord = LocalUsageRecord & { provider: ProviderId }

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
 * later loads only reparse files whose size or mtime changed.
 */
export class UsageHistoryService {
  readonly #cacheFile: string
  readonly #codexSessionsRoot: string
  readonly #claudeProjectsRoot: string
  readonly #grokLogPath: string
  readonly #openCodeDataRoot: string
  readonly #harnessUsage: () => StoredUsageEvent[]
  readonly #now: () => Date
  readonly #scanRunner: UsageScanRunner
  #cache: UsageCache | undefined
  #cacheLoading: Promise<UsageCache> | undefined
  #refreshing: Promise<void> | undefined
  #resetting: Promise<void> | undefined
  #scanAbort: AbortController | undefined
  #disposed = false
  #lastRefreshStartedAt: number | undefined
  #harnessUsageLoadedAt = 0
  #harnessUsageCache: StoredUsageEvent[] | undefined
  #sources: SourceState[] = emptySources()
  #scanWarnings: string[] = []
  #scan: UsageHistoryResult['scan'] = {
    status: 'idle',
    filesProcessed: 0,
    filesTotal: 0,
  }

  constructor(options: UsageHistoryOptions) {
    this.#cacheFile = options.cacheFile
    this.#codexSessionsRoot =
      options.codexSessionsRoot ??
      path.join(process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'), 'sessions')
    this.#claudeProjectsRoot =
      options.claudeProjectsRoot ??
      path.join(process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude'), 'projects')
    this.#grokLogPath =
      options.grokLogPath ??
      path.join(
        process.env['GROK_HOME'] ?? path.join(os.homedir(), '.grok'),
        'logs',
        'unified.jsonl',
      )
    this.#openCodeDataRoot =
      options.openCodeDataRoot ??
      process.env['OPENCODE_DATA_DIR'] ??
      path.join(
        process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'),
        'opencode',
      )
    this.#harnessUsage = options.harnessUsage ?? (() => [])
    this.#now = options.now ?? (() => new Date())
    this.#scanRunner = options.scanRunner ?? runUsageScanWorker
  }

  /** Starts indexing without putting it on the server startup or request path. */
  async startBackgroundRefresh(): Promise<void> {
    await this.#loadCache()
    this.#startRefresh()
  }

  async history(range: UsageHistoryRange, refresh = false): Promise<UsageHistoryResult> {
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
    return this.#aggregate(range)
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
    this.#cacheLoading = Promise.resolve(cache)
    this.#sources = cache.sources
    this.#scanWarnings = []
    this.#scan = { status: 'idle', filesProcessed: 0, filesTotal: 0 }
    this.#lastRefreshStartedAt = undefined
    this.#harnessUsageCache = undefined
    this.#harnessUsageLoadedAt = 0
    this.#startRefresh()
  }

  async #loadCache(): Promise<UsageCache> {
    if (this.#cache) return this.#cache
    if (!this.#cacheLoading) {
      this.#cacheLoading = readUsageCache(this.#cacheFile).then((cache) => {
        this.#cache = cache
        this.#sources = cache.sources
        this.#scanWarnings = cache.warnings
        return cache
      })
    }
    return this.#cacheLoading
  }

  #startRefresh(): void {
    if (this.#refreshing || this.#disposed) return
    this.#lastRefreshStartedAt = this.#now().getTime()
    this.#scan = { status: 'scanning', filesProcessed: 0, filesTotal: 0 }
    const request: UsageScanRequest = {
      cacheFile: this.#cacheFile,
      codexSessionsRoot: this.#codexSessionsRoot,
      claudeProjectsRoot: this.#claudeProjectsRoot,
      grokLogPath: this.#grokLogPath,
      openCodeDataRoot: this.#openCodeDataRoot,
      generatedAt: this.#lastRefreshStartedAt,
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
        this.#cache = result.cache
        this.#sources = result.sources
        this.#scanWarnings = result.warnings
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

  #aggregate(range: UsageHistoryRange): UsageHistoryResult {
    const now = this.#now()
    const endDate = localDateKey(now)
    const localEntries: AttributedUsageRecord[] = (this.#cache?.files ?? []).flatMap((file) =>
      file.entries.map((entry) => ({ ...entry, provider: file.provider })),
    )
    const richProviders = new Set(localEntries.map((entry) => entry.provider))
    const harnessEntries = harnessUsageRecords(
      this.#cachedHarnessUsage(now.getTime()),
      richProviders,
    )
    const allEntries = [...localEntries, ...harnessEntries]
    const earliestDate = allEntries.reduce<string | undefined>(
      (earliest, entry) => (!earliest || entry.date < earliest ? entry.date : earliest),
      undefined,
    )
    const startDate = rangeStartDate(range, endDate, earliestDate)
    const entries = allEntries.filter((entry) => entry.date >= startDate && entry.date <= endDate)

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

    for (const entry of entries) {
      const sessionKey = `${entry.provider}:${entry.sessionId}`
      const priced = priceEntry(entry.model, entry.date, entry.tokens, entry.longContext)
      addEntry(totals, entry.tokens, priced)
      sessions.add(sessionKey)

      const provider = getBucket(providerBuckets, entry.provider)
      addEntry(provider.totals, entry.tokens, priced)
      provider.sessions.add(sessionKey)

      const modelKey = `${entry.provider}:${entry.model}`
      let model = modelBuckets.get(modelKey)
      if (!model) {
        model = {
          ...newBucket(),
          provider: entry.provider,
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
      const providerDay = day.providers.get(entry.provider) ?? {
        tokens: 0,
        estimatedCostUsd: 0,
      }
      providerDay.tokens += processedTokens(entry.tokens)
      providerDay.estimatedCostUsd +=
        entry.tokens.providerReportedCostUsd > 0
          ? entry.tokens.providerReportedCostUsd
          : priced.estimatedCostUsd
      day.providers.set(entry.provider, providerDay)
    }

    const providers: UsageHistoryProvider[] = [...providerBuckets.entries()]
      .map(([provider, bucket]) => ({
        provider,
        sessionCount: bucket.sessions.size,
        totals: bucket.totals,
      }))
      .sort((a, b) => b.totals.estimatedCostUsd - a.totals.estimatedCostUsd)

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

    const sourceProviders = new Set<ProviderId>([
      ...this.#sources.map((source) => source.provider),
      ...allEntries.map((entry) => entry.provider),
    ])
    const sources = [...sourceProviders].map((provider) => {
      const localSource = this.#sources.find((source) => source.provider === provider)
      const sessionCount = new Set(
        allEntries.filter((entry) => entry.provider === provider).map((entry) => entry.sessionId),
      ).size
      return {
        provider,
        available: (localSource?.available ?? false) || sessionCount > 0,
        sessionCount,
      }
    })
    const warnings = [...this.#scanWarnings]
    if (totals.unpricedTokens > 0) {
      warnings.push('Some token records use models without a known public API price.')
    }

    return {
      range,
      startDate,
      endDate,
      generatedAt: this.#cache?.generatedAt ?? 0,
      sessionCount: sessions.size,
      activeDays: daily.filter((day) => day.totals.processedTokens > 0).length,
      totals,
      providers,
      models,
      daily,
      sources,
      scan: { ...this.#scan },
      warnings,
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

/** Performs the expensive archive walk. Production calls this inside a Worker. */
export async function runUsageHistoryScan(
  request: UsageScanRequest,
  onProgress: (progress: UsageScanProgress) => void = () => undefined,
): Promise<UsageScanResult> {
  const previous = await readUsageCache(request.cacheFile)
  const { files, sources } = await discoverUsageSources([
    {
      provider: 'codex',
      label: 'Codex',
      discover: () => discoverJsonlRoot(request.codexSessionsRoot, 'codex', readCodexUsageHistory),
    },
    {
      provider: 'claude-code',
      label: 'Claude Code',
      discover: () =>
        discoverJsonlRoot(request.claudeProjectsRoot, 'claude-code', readClaudeUsageHistory),
    },
    {
      provider: 'grok',
      label: 'Grok',
      discover: () => discoverSingleFile(request.grokLogPath, 'grok', readGrokUsageHistory),
    },
    {
      provider: 'opencode',
      label: 'OpenCode',
      discover: () => discoverOpenCodeDatabases(request.openCodeDataRoot, readOpenCodeUsageHistory),
    },
  ])
  const warnings: string[] = []
  const priorByPath = new Map(previous.files.map((file) => [file.path, file]))
  const nextFiles = new Map<string, CachedUsageFile>()
  const changed: UsageFile[] = []

  for (const file of files) {
    const prior = priorByPath.get(file.path)
    if (
      prior?.provider === file.provider &&
      prior.mtimeMs === file.mtimeMs &&
      prior.size === file.size
    ) {
      nextFiles.set(file.path, prior)
    } else {
      changed.push(file)
    }
  }

  let failedFiles = 0
  let filesProcessed = files.length - changed.length
  const reportProgress = () => onProgress({ filesProcessed, filesTotal: files.length })
  reportProgress()
  await mapWithConcurrency(changed, PARSE_CONCURRENCY, async (file) => {
    try {
      const entries = await file.read(file.path)
      nextFiles.set(file.path, {
        path: file.path,
        provider: file.provider,
        mtimeMs: file.mtimeMs,
        size: file.size,
        entries,
      })
    } catch {
      failedFiles += 1
      const prior = priorByPath.get(file.path)
      if (prior) nextFiles.set(file.path, prior)
    } finally {
      filesProcessed += 1
      if (filesProcessed === files.length || filesProcessed % 25 === 0) reportProgress()
    }
  })

  if (failedFiles > 0) {
    warnings.push(
      `${failedFiles.toLocaleString()} history ${failedFiles === 1 ? 'file could' : 'files could'} not be read.`,
    )
  }

  const cache: UsageCache = {
    version: CACHE_VERSION,
    generatedAt: request.generatedAt,
    files: [...nextFiles.values()],
    sources,
    warnings,
  }
  try {
    await writeCache(request.cacheFile, cache)
  } catch {
    warnings.push('Usage was loaded, but its local scan cache could not be saved.')
    cache.warnings = warnings
  }
  return { cache, sources, warnings }
}

export async function readUsageCache(filePath: string): Promise<UsageCache> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<UsageCache>
    if (value.version === CACHE_VERSION && isCachedUsageFiles(value.files)) {
      const cachedProviders = new Set(value.files.map((file) => file.provider))
      return {
        version: CACHE_VERSION,
        generatedAt: typeof value.generatedAt === 'number' ? value.generatedAt : 0,
        files: value.files,
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
    }
  } catch {
    // A missing or interrupted cache write is equivalent to a cold start.
  }
  return emptyUsageCache()
}

function isCachedUsageFiles(value: unknown): value is CachedUsageFile[] {
  return Array.isArray(value) && value.every(isCachedUsageFile)
}

function isCachedUsageFile(value: unknown): value is CachedUsageFile {
  const file = objectValue(value)
  return Boolean(
    file &&
    typeof file['path'] === 'string' &&
    LOCAL_USAGE_PROVIDERS.some((provider) => provider === file['provider']) &&
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

function runUsageScanWorker(
  request: UsageScanRequest,
  onProgress: (progress: UsageScanProgress) => void,
  signal: AbortSignal,
): Promise<UsageScanResult> {
  return new Promise((resolve, reject) => {
    const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
    const worker = new Worker(
      new URL(`./usage-history-worker.${sourceExtension}`, import.meta.url),
      {
        workerData: request,
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
      if (message.type === 'complete') resolve(message.result)
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

type UsageWorkerMessage =
  | { type: 'progress'; progress: UsageScanProgress }
  | { type: 'complete'; result: UsageScanResult }
  | { type: 'error'; message: string }

function emptySources(): SourceState[] {
  return [
    { provider: 'codex', label: 'Codex', available: false },
    { provider: 'claude-code', label: 'Claude Code', available: false },
    { provider: 'grok', label: 'Grok', available: false },
    { provider: 'cursor', label: 'Cursor', available: false },
    { provider: 'opencode', label: 'OpenCode', available: false },
    { provider: 'antigravity', label: 'Antigravity', available: false },
    { provider: 'acp', label: 'ACP', available: false },
    { provider: 'api', label: 'API', available: false },
  ]
}

function mergeSources(sources: readonly SourceState[]): SourceState[] {
  const merged = new Map(emptySources().map((source) => [source.provider, source]))
  for (const source of sources) {
    const known = merged.get(source.provider)
    if (known) merged.set(source.provider, { ...known, ...source })
  }
  return [...merged.values()]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type UsageSourceDefinition = {
  provider: ProviderId
  label: string
  discover: () => Promise<{ available: boolean; files: UsageFile[] }>
}

async function discoverUsageSources(
  definitions: readonly UsageSourceDefinition[],
): Promise<{ files: UsageFile[]; sources: SourceState[] }> {
  const discovered = await Promise.all(
    definitions.map(async ({ provider, label, discover }) => {
      try {
        return { provider, label, ...(await discover()) }
      } catch {
        return { provider, label, available: false, files: [] }
      }
    }),
  )
  return {
    files: discovered.flatMap((source) => source.files),
    sources: mergeSources(
      discovered.map((source) => ({
        provider: source.provider,
        label: source.label,
        available: source.available,
      })),
    ),
  }
}

async function discoverJsonlRoot(
  root: string,
  provider: ProviderId,
  read: UsageFile['read'],
): Promise<{ available: boolean; files: UsageFile[] }> {
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) return { available: false, files: [] }
  return { available: true, files: await listJsonlFiles(root, provider, read) }
}

async function discoverSingleFile(
  filePath: string,
  provider: ProviderId,
  read: UsageFile['read'],
): Promise<{ available: boolean; files: UsageFile[] }> {
  const file = await usageFile(filePath, provider, read)
  return { available: Boolean(file), files: file ? [file] : [] }
}

async function discoverOpenCodeDatabases(
  root: string,
  read: UsageFile['read'],
): Promise<{ available: boolean; files: UsageFile[] }> {
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) return { available: false, files: [] }
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith('opencode') && entry.name.endsWith('.db'),
      )
      .map((entry) => {
        const filePath = path.join(root, entry.name)
        // SQLite can append only to the WAL for long stretches. Folding the
        // sidecar into the fingerprint catches new messages without reparsing
        // an unchanged database on every refresh.
        return usageFile(filePath, 'opencode', read, [`${filePath}-wal`], true)
      }),
  )
  return { available: true, files: files.filter((file) => file !== undefined) }
}

async function usageFile(
  filePath: string,
  provider: ProviderId,
  read: UsageFile['read'],
  companions: readonly string[] = [],
  allowEmpty = false,
): Promise<UsageFile | undefined> {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile() || (!allowEmpty && fileStat.size === 0)) return undefined
  let mtimeMs = fileStat.mtimeMs
  let size = fileStat.size
  for (const companion of companions) {
    try {
      const companionStat = await stat(companion)
      mtimeMs = Math.max(mtimeMs, companionStat.mtimeMs)
      size += companionStat.size
    } catch {
      // A database without a WAL is the common clean-shutdown state.
    }
  }
  return { path: filePath, provider, mtimeMs, size, read }
}

async function listJsonlFiles(
  root: string,
  provider: ProviderId,
  read: UsageFile['read'],
): Promise<UsageFile[]> {
  const result: UsageFile[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          pending.push(fullPath)
          return
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return
        try {
          const file = await usageFile(fullPath, provider, read)
          if (file) result.push(file)
        } catch {
          // A session can disappear between readdir and stat during cleanup.
        }
      }),
    )
  }
  return result
}

function harnessUsageRecords(
  events: readonly StoredUsageEvent[],
  richerLocalProviders: ReadonlySet<ProviderId>,
): AttributedUsageRecord[] {
  const records: AttributedUsageRecord[] = []
  const previous = new Map<string, TokenCounts>()

  for (const event of events) {
    if (richerLocalProviders.has(event.provider)) continue
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

function priceEntry(
  model: string,
  date: string,
  tokens: TokenCounts,
  longContext: boolean,
): {
  pricing: UsageHistoryModel['pricing']
  estimatedCostUsd: number
  cacheSavingsUsd: number
} {
  const rate = modelRate(model, date)
  if (!rate) return { pricing: 'unpriced', estimatedCostUsd: 0, cacheSavingsUsd: 0 }
  const inputMultiplier = longContext ? (rate.longContextMultipliers?.input ?? 1) : 1
  const outputMultiplier = longContext ? (rate.longContextMultipliers?.output ?? 1) : 1
  const perMillion = 1_000_000
  const estimatedCostUsd =
    (tokens.uncachedInputTokens * rate.input * inputMultiplier +
      tokens.cachedInputTokens * rate.cachedInput * inputMultiplier +
      tokens.cacheWrite5mInputTokens * rate.input * 1.25 * inputMultiplier +
      tokens.cacheWrite1hInputTokens * rate.input * 2 * inputMultiplier +
      tokens.outputTokens * rate.output * outputMultiplier) /
    perMillion
  const cacheSavingsUsd =
    (tokens.cachedInputTokens * Math.max(rate.input - rate.cachedInput, 0) * inputMultiplier) /
    perMillion
  return { pricing: rate.pricing, estimatedCostUsd, cacheSavingsUsd }
}

/**
 * Public API list prices in USD per million tokens, checked 2026-08-08.
 * OpenAI: https://developers.openai.com/api/docs/models
 * Anthropic: https://docs.anthropic.com/en/docs/about-claude/pricing
 * xAI: https://docs.x.ai/developers/pricing
 * Google: https://ai.google.dev/gemini-api/docs/pricing
 */
function modelRate(model: string, date: string): ModelRate | undefined {
  const value = model.toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
  const exact = (
    input: number,
    cachedInput: number,
    output: number,
    longContextMultipliers?: ModelRate['longContextMultipliers'],
  ): ModelRate => ({
    input,
    cachedInput,
    output,
    pricing: 'exact',
    ...(longContextMultipliers ? { longContextMultipliers } : {}),
  })

  if (value.includes('grok-4-5')) return exact(2, 0.3, 6, { input: 2, output: 2 })

  if (value.includes('gemini-3-6-flash')) return exact(1.5, 0.15, 7.5)
  if (value.includes('gemini-3-5-flash-lite')) return exact(0.3, 0.03, 2.5)
  if (value.includes('gemini-3-5-flash')) return exact(1.5, 0.15, 9)
  if (value.includes('gemini-3-1-flash-lite')) return exact(0.25, 0.025, 1.5)
  if (value.includes('gemini-3-1-pro')) {
    return exact(2, 0.2, 12, { input: 2, output: 1.5 })
  }
  if (value.includes('gemini-2-5-flash-lite')) return exact(0.1, 0.01, 0.4)
  if (value.includes('gemini-2-5-flash')) return exact(0.3, 0.03, 2.5)
  if (value.includes('gemini-2-5-pro')) {
    return exact(1.25, 0.125, 10, { input: 2, output: 1.5 })
  }

  const openAiLongContext = { input: 2, output: 1.5 }
  if (value.includes('gpt-5-6-sol') || value === 'gpt-5-6') {
    return exact(5, 0.5, 30, openAiLongContext)
  }
  if (value.includes('gpt-5-6-terra')) return exact(2.5, 0.25, 15, openAiLongContext)
  if (value.includes('gpt-5-6-luna')) return exact(1, 0.1, 6, openAiLongContext)
  if (value.includes('gpt-5-6')) {
    return { ...exact(5, 0.5, 30, openAiLongContext), pricing: 'family' }
  }
  if (value.includes('gpt-5-5')) return exact(5, 0.5, 30)
  if (value.includes('gpt-5-4-mini')) return exact(0.75, 0.075, 4.5)
  if (value.includes('gpt-5-4')) return exact(2.5, 0.25, 15)
  if (value.includes('codex-auto-review')) return exact(1.75, 0.175, 14)
  if (value.includes('gpt-5-3-codex')) return exact(1.75, 0.175, 14)
  if (value.includes('gpt-5-2')) return exact(1.75, 0.175, 14)
  if (value.includes('gpt-5-1')) return exact(1.25, 0.125, 10)
  if (value === 'gpt-5' || value.startsWith('gpt-5-202') || value.includes('gpt-5-codex')) {
    return exact(1.25, 0.125, 10)
  }

  if (value.includes('claude-fable-5')) return exact(10, 1, 50)
  if (value.includes('claude-sonnet-5')) {
    return date <= '2026-08-31' ? exact(2, 0.2, 10) : exact(3, 0.3, 15)
  }
  if (
    value.includes('claude-opus-4-8') ||
    value.includes('claude-opus-4-7') ||
    value.includes('claude-opus-4-6') ||
    value.includes('claude-opus-4-5')
  ) {
    return exact(5, 0.5, 25)
  }
  if (value.includes('claude-sonnet-4')) return exact(3, 0.3, 15)
  if (value.includes('claude-haiku-4-5')) return exact(1, 0.1, 5)
  if (
    value === 'claude-opus-4' ||
    value.includes('claude-opus-4-1') ||
    value.includes('claude-opus-4-2025')
  ) {
    return exact(15, 1.5, 75)
  }
  if (value.includes('claude-sonnet-3')) return exact(3, 0.3, 15)
  if (value.includes('claude-haiku-3-5')) return exact(0.8, 0.08, 4)
  if (value.includes('claude-haiku-3')) return exact(0.25, 0.025, 1.25)

  if (value.includes('claude-fable')) return { ...exact(10, 1, 50), pricing: 'family' }
  return undefined
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
