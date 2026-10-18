import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderId } from '@harness/contracts'
import { afterAll, bench, describe } from 'vitest'
import { type CachedUsageFile, loadUsageCache, UsageHistoryService } from './usage-history.js'

const OPTIONS = { iterations: 10, time: 0, warmupIterations: 2, warmupTime: 0 }
const FILES = 3_000
const PROVIDERS: ProviderId[] = ['claude-code', 'codex', 'claude-code', 'grok']
const MODELS = [
  'claude-opus-5-5',
  'claude-haiku-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-8',
  'claude-fable-5',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-5.6-sol',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'grok-4.6',
  'grok-4.5',
  'gemini-3.1-pro',
  'private-model',
]
const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-usage-bench-'))

/**
 * One session per archive file, each with records on different days and
 * models, so no two records of a file share a compaction key. 57 records per
 * file is about the 167K per-message records of a heavy user before
 * compaction; 1 to 2 per file is the same history compacted.
 */
function writeIndex(name: string, recordsPerFile: (file: number) => number): string {
  const end = new Date('2026-10-16T12:00:00').getTime()
  const files: CachedUsageFile[] = Array.from({ length: FILES }, (_, file) => ({
    path: path.join(directory, `session-${file}.jsonl`),
    provider: PROVIDERS[file % PROVIDERS.length] ?? 'codex',
    mtimeMs: 1,
    size: 1,
    entries: Array.from({ length: recordsPerFile(file) }, (_, record) => {
      const date = new Date(end - ((file + record) % 365) * 86_400_000)
      return {
        date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        model: MODELS[record % MODELS.length] ?? 'private-model',
        sessionId: `session-${file}`,
        longContext: record % 11 === 0,
        tokens: {
          uncachedInputTokens: 1_200 + record,
          cachedInputTokens: 48_000 + file,
          cacheWrite5mInputTokens: record % 3 === 0 ? 900 : 0,
          cacheWrite1hInputTokens: record % 5 === 0 ? 400 : 0,
          outputTokens: 700 + record,
          reasoningTokens: 120,
          providerReportedCostUsd: file % 41 === 0 ? 0.03 : 0,
        },
      }
    }),
  }))
  const cacheFile = path.join(directory, `${name}.json`)
  writeFileSync(
    cacheFile,
    JSON.stringify({ version: 8, generatedAt: end, files, sources: [], warnings: [] }),
  )
  return cacheFile
}

/** A service over a saved index, with a clock the benchmarks move to expire reused figures. */
async function indexedService(cacheFile: string) {
  let now = new Date('2026-10-16T12:00:00').getTime()
  const service = new UsageHistoryService({
    cacheFile,
    now: () => new Date(now),
    harnessUsage: () => [],
    scanRunner: async (request) => ({
      paths: request.indexed.map((file) => file.path),
      files: [],
      sources: [],
      warnings: [],
    }),
    largeCacheLoader: (filePath) => loadUsageCache(filePath),
  })
  await service.history('30d')
  await service.waitForRefresh()
  return {
    service,
    /** Past the Harness event cache, so the next call computes every figure again. */
    expire: () => {
      now += 5_000
    },
  }
}

const perMessage = await indexedService(writeIndex('per-message', () => 57))
const compacted = await indexedService(writeIndex('compacted', (file) => 1 + (file % 2)))

afterAll(() => {
  perMessage.service.dispose()
  compacted.service.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('usage.history over 3,000 archive files', () => {
  bench(
    'computes 30 days from 171,000 per-message records',
    async () => {
      perMessage.expire()
      await perMessage.service.history('30d')
    },
    OPTIONS,
  )
  bench(
    'computes all time from 171,000 per-message records',
    async () => {
      perMessage.expire()
      await perMessage.service.history('all')
    },
    OPTIONS,
  )
  bench(
    'computes 30 days from 4,500 compacted records',
    async () => {
      compacted.expire()
      await compacted.service.history('30d')
    },
    OPTIONS,
  )
  bench(
    'reuses 30 days while nothing changed',
    async () => {
      await perMessage.service.history('30d')
    },
    OPTIONS,
  )
})
