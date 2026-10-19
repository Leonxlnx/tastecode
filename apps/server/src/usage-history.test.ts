import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readClaudeUsageHistory } from '@harness/adapter-claude-code'
import type { ProviderId, UsageHistoryRange, UsageHistoryResult } from '@harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { StoredUsageEvent } from './store.js'
import {
  type CachedUsageFile,
  loadUsageCache,
  readUsageCache,
  runUsageHistoryScan,
  type UsageCacheLoader,
  UsageHistoryService,
} from './usage-history.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('local usage history', () => {
  it('deduplicates provider records, attributes model switches, and prices cache traffic', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })

    writeJsonLines(path.join(codexRoot, 'session.jsonl'), [
      {
        timestamp: '2026-08-08T09:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-session' },
      },
      {
        timestamp: '2026-08-08T09:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-terra' },
      },
      codexTokenRecord('2026-08-08T09:01:00.000Z', {
        input_tokens: 1_000,
        cached_input_tokens: 400,
        cache_write_input_tokens: 100,
        output_tokens: 100,
        reasoning_output_tokens: 40,
      }),
      codexTokenRecord('2026-08-08T09:02:00.000Z', {
        input_tokens: 1_800,
        cached_input_tokens: 700,
        cache_write_input_tokens: 100,
        output_tokens: 250,
        reasoning_output_tokens: 70,
      }),
      {
        timestamp: '2026-08-08T09:02:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-luna' },
      },
      codexTokenRecord('2026-08-08T09:03:00.000Z', {
        input_tokens: 2_200,
        cached_input_tokens: 700,
        cache_write_input_tokens: 100,
        output_tokens: 350,
        reasoning_output_tokens: 70,
      }),
    ])

    const duplicateClaudeMessage = claudeAssistantRecord({
      id: 'claude-message',
      model: 'claude-fable-5',
      sessionId: 'claude-session',
      input: 100,
      cached: 50,
      cacheWrite: 20,
      cacheWrite5m: 10,
      cacheWrite1h: 10,
      output: 25,
    })
    writeJsonLines(path.join(claudeRoot, 'session.jsonl'), [
      duplicateClaudeMessage,
      { ...duplicateClaudeMessage, uuid: 'duplicate-snapshot' },
      claudeAssistantRecord({
        id: 'unknown-message',
        model: 'private-model',
        sessionId: 'claude-session',
        input: 10,
        output: 5,
      }),
    ])

    const service = usageService({
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: { codex: codexRoot, 'claude-code': claudeRoot },
      harnessUsage: () => [
        {
          threadId: 'codex-session',
          provider: 'codex',
          at: new Date('2026-08-08T11:00:00.000Z').getTime(),
          usage: {
            inputTokens: 9_000_000,
            cachedInputTokens: 0,
            outputTokens: 1_000_000,
            reasoningTokens: 0,
            totalTokens: 10_000_000,
          },
        },
      ],
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })
    const history = await settledHistory(service, '7d')

    expect(history.sessionCount).toBe(2)
    expect(history.activeDays).toBe(1)
    expect(history.totals).toMatchObject({
      uncachedInputTokens: 1_510,
      cachedInputTokens: 750,
      cacheWriteInputTokens: 120,
      outputTokens: 380,
      reasoningTokens: 70,
      processedTokens: 2_760,
      pricedTokens: 2_745,
      unpricedTokens: 15,
    })
    expect(history.totals.estimatedCostUsd).toBeCloseTo(0.008215, 8)
    expect(history.totals.cacheSavingsUsd).toBeCloseTo(0.00171, 8)
    expect(history.providers.map((provider) => provider.provider)).toEqual(['codex', 'claude-code'])
    expect(history.models.map((model) => [model.model, model.pricing])).toEqual([
      ['gpt-5.6-terra', 'exact'],
      ['claude-fable-5', 'exact'],
      ['gpt-5.6-luna', 'exact'],
      ['private-model', 'unpriced'],
    ])
    expect(history.daily).toHaveLength(7)
    expect(history.daily.at(-1)?.totals.processedTokens).toBe(2_760)
    expect(history.warnings).toContain(
      'Some token records use models without a known public API price.',
    )
  })

  it('counts the first cumulative snapshot and reparses a session after it grows', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })
    const codexFile = path.join(codexRoot, 'session.jsonl')
    const records = [
      {
        timestamp: '2026-08-08T09:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'session' },
      },
      codexTokenRecord('2026-08-08T09:00:00.500Z', {
        input_tokens: 1_000,
        output_tokens: 100,
      }),
      {
        timestamp: '2026-08-08T09:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-luna' },
      },
      codexTokenRecord('2026-08-08T09:01:00.000Z', {
        input_tokens: 1_100,
        output_tokens: 110,
      }),
    ]
    writeJsonLines(codexFile, records)
    const options = {
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: { codex: codexRoot, 'claude-code': claudeRoot },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    }
    const service = usageService(options)

    expect((await settledHistory(service, 'all')).totals.processedTokens).toBe(1_210)
    records.push(
      codexTokenRecord('2026-08-08T09:02:00.000Z', {
        input_tokens: 1_250,
        output_tokens: 125,
      }),
    )
    writeJsonLines(codexFile, records)
    expect((await settledHistory(service, 'all', true)).totals.processedTokens).toBe(1_375)

    const restarted = usageService(options)
    expect((await restarted.history('all')).totals.processedTokens).toBe(1_375)
    await restarted.waitForRefresh()
  })

  it('preserves reported input totals when a cache delta exceeds its input delta', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })
    writeJsonLines(path.join(codexRoot, 'session.jsonl'), [
      {
        timestamp: '2026-08-08T09:00:00.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol' },
      },
      codexTokenRecord('2026-08-08T09:01:00.000Z', {
        input_tokens: 1_000,
        cached_input_tokens: 100,
        output_tokens: 100,
        total_tokens: 1_100,
      }),
      codexTokenRecord('2026-08-08T09:02:00.000Z', {
        input_tokens: 1_100,
        cached_input_tokens: 300,
        output_tokens: 110,
        total_tokens: 1_210,
      }),
    ])

    const history = await settledHistory(
      usageService({
        cacheFile: path.join(root, 'cache', 'usage.json'),
        sourceRoots: { codex: codexRoot, 'claude-code': claudeRoot },
        now: () => new Date('2026-08-08T12:00:00.000Z'),
      }),
      'all',
    )

    expect(history.totals).toMatchObject({
      uncachedInputTokens: 800,
      cachedInputTokens: 300,
      outputTokens: 110,
      processedTokens: 1_210,
    })
  })

  it('clears the generated index and starts a true cold background rescan', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    const cacheFile = path.join(root, 'cache', 'usage.json')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })
    writeJsonLines(path.join(codexRoot, 'session.jsonl'), [
      {
        timestamp: '2026-08-08T09:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'session' },
      },
      {
        timestamp: '2026-08-08T09:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-luna' },
      },
      codexTokenRecord('2026-08-08T09:01:00.000Z', {
        input_tokens: 1_000,
        output_tokens: 100,
      }),
    ])
    const secondScan = Promise.withResolvers<void>()
    let scans = 0
    const service = new UsageHistoryService({
      cacheFile,
      sourceRoots: {
        codex: codexRoot,
        'claude-code': claudeRoot,
        grok: path.join(root, 'missing-grok.jsonl'),
        opencode: path.join(root, 'missing-opencode'),
      },
      scanRunner: async (request, onProgress) => {
        scans += 1
        if (scans === 2) await secondScan.promise
        return runUsageHistoryScan(request, onProgress)
      },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })

    expect((await settledHistory(service, 'all')).totals.processedTokens).toBe(1_100)
    expect((await readUsageCache(cacheFile)).generatedAt).toBeGreaterThan(0)

    await service.resetAndRefresh()
    const resetting = await service.history('all')
    expect(resetting.scan.status).toBe('scanning')
    expect(resetting.totals.processedTokens).toBe(0)
    expect((await readUsageCache(cacheFile)).generatedAt).toBe(0)

    secondScan.resolve()
    await service.waitForRefresh()
    expect((await service.history('all')).totals.processedTokens).toBe(1_100)
    expect(scans).toBe(2)
  })

  it('applies GPT-5.6 long-context rates to requests above 272K input tokens', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })
    writeJsonLines(path.join(codexRoot, 'long-context.jsonl'), [
      {
        timestamp: '2026-08-08T09:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'long-context-session' },
      },
      {
        timestamp: '2026-08-08T09:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol' },
      },
      codexTokenRecord('2026-08-08T09:01:00.000Z', {
        input_tokens: 300_001,
        output_tokens: 100,
      }),
    ])
    const service = usageService({
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: { codex: codexRoot, 'claude-code': claudeRoot },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })

    const history = await settledHistory(service, '7d')
    expect(history.totals.estimatedCostUsd).toBeCloseTo(2.403008, 8)
  })

  it('falls back to persisted Harness events for every provider without rich local history', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })
    const at = new Date('2026-08-08T10:00:00.000Z').getTime()
    const service = usageService({
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: { codex: codexRoot, 'claude-code': claudeRoot },
      harnessUsage: () => [
        {
          threadId: 'api-session',
          provider: 'api',
          at,
          usage: {
            inputTokens: 1_000,
            cachedInputTokens: 500,
            outputTokens: 100,
            reasoningTokens: 0,
            totalTokens: 1_100,
            model: 'gpt-5.6-luna',
            inputIncludesCached: true,
          },
        },
        {
          threadId: 'opencode-session',
          provider: 'opencode',
          at,
          usage: {
            inputTokens: 100,
            cachedInputTokens: 10,
            outputTokens: 20,
            reasoningTokens: 0,
            totalTokens: 120,
            model: 'private-model',
            costUsd: 0.04,
            inputIncludesCached: false,
          },
        },
        {
          threadId: 'codex-session',
          provider: 'codex',
          at,
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            outputTokens: 10,
            reasoningTokens: 0,
            totalTokens: 110,
            model: 'gpt-5.6-luna',
            cumulative: true,
            inputIncludesCached: true,
          },
        },
        {
          threadId: 'codex-session',
          provider: 'codex',
          at: at + 1,
          usage: {
            inputTokens: 250,
            cachedInputTokens: 0,
            outputTokens: 25,
            reasoningTokens: 0,
            totalTokens: 275,
            model: 'gpt-5.6-luna',
            cumulative: true,
            inputIncludesCached: true,
          },
        },
      ],
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })

    const history = await settledHistory(service, '7d')
    expect(history.sessionCount).toBe(3)
    expect(history.totals).toMatchObject({
      uncachedInputTokens: 850,
      cachedInputTokens: 510,
      outputTokens: 145,
      processedTokens: 1_505,
      providerReportedTokens: 130,
      pricedTokens: 1_375,
      unpricedTokens: 0,
    })
    expect(history.totals.estimatedCostUsd).toBeCloseTo(0.04031, 8)
    expect(history.providers.map((provider) => provider.provider)).toEqual([
      'opencode',
      'api',
      'codex',
    ])
  })

  it('aggregates persisted usage from every Harness provider', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })
    const providers: ProviderId[] = [
      'claude-code',
      'codex',
      'grok',
      'cursor',
      'opencode',
      'antigravity',
      'acp',
      'api',
    ]
    const at = new Date('2026-08-08T10:00:00.000Z').getTime()
    const service = usageService({
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: { codex: codexRoot, 'claude-code': claudeRoot },
      harnessUsage: () =>
        providers.map((provider) => ({
          threadId: `${provider}-session`,
          provider,
          at,
          usage: {
            inputTokens: 100,
            cachedInputTokens: 20,
            outputTokens: 10,
            reasoningTokens: 2,
            totalTokens: 130,
            model: `${provider}-model`,
            costUsd: 0.01,
            inputIncludesCached: false,
          },
        })),
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })

    const history = await settledHistory(service, '7d')
    expect(history.sessionCount).toBe(8)
    expect(new Set(history.providers.map((provider) => provider.provider))).toEqual(
      new Set(providers),
    )
    expect(history.sources.map((source) => source.provider)).toEqual(providers)
    expect(history.totals).toMatchObject({
      processedTokens: 1_040,
      providerReportedTokens: 1_040,
      unpricedTokens: 0,
    })
    expect(history.totals.estimatedCostUsd).toBeCloseTo(0.08, 8)
  })

  it('prices public Grok and Gemini models with cache and long-context rates', async () => {
    const root = temporaryDirectory()
    const at = new Date('2026-08-08T10:00:00.000Z').getTime()
    const service = usageService({
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: {
        codex: path.join(root, 'missing-codex'),
        'claude-code': path.join(root, 'missing-claude'),
      },
      harnessUsage: () => [
        {
          threadId: 'antigravity-session',
          provider: 'antigravity',
          at,
          usage: {
            inputTokens: 1_000_000,
            cachedInputTokens: 200_000,
            outputTokens: 100_000,
            reasoningTokens: 20_000,
            totalTokens: 1_100_000,
            model: 'gemini-3.6-flash-high',
            inputIncludesCached: true,
          },
        },
        {
          threadId: 'grok-session',
          provider: 'grok',
          at,
          usage: {
            inputTokens: 250_000,
            cachedInputTokens: 50_000,
            outputTokens: 100_000,
            reasoningTokens: 10_000,
            totalTokens: 350_000,
            model: 'grok-4.5',
            inputIncludesCached: true,
          },
        },
      ],
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })

    const history = await settledHistory(service, '7d')
    expect(history.totals.estimatedCostUsd).toBeCloseTo(3.02, 8)
    expect(history.models.every((model) => model.pricing === 'exact')).toBe(true)
  })

  it('returns immediately while a cold archive index continues in the background', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })
    const gate = Promise.withResolvers<void>()
    const service = new UsageHistoryService({
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: {
        codex: codexRoot,
        'claude-code': claudeRoot,
        grok: path.join(root, 'missing-grok.jsonl'),
        opencode: path.join(root, 'missing-opencode'),
      },
      scanRunner: async (request, onProgress) => {
        await gate.promise
        return runUsageHistoryScan(request, onProgress)
      },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })

    const started = performance.now()
    const initial = await service.history('30d')
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(initial.scan).toEqual({ status: 'scanning', filesProcessed: 0, filesTotal: 0 })
    expect(initial.totals.processedTokens).toBe(0)

    gate.resolve()
    await service.waitForRefresh()
    expect((await service.history('30d')).scan.status).toBe('idle')
  })

  it('backs off after a cold background scan fails', async () => {
    const root = temporaryDirectory()
    let scans = 0
    let now = new Date('2026-08-08T12:00:00.000Z').getTime()
    const service = new UsageHistoryService({
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: {
        codex: path.join(root, 'missing-codex'),
        'claude-code': path.join(root, 'missing-claude'),
        grok: path.join(root, 'missing-grok.jsonl'),
        opencode: path.join(root, 'missing-opencode'),
      },
      scanRunner: async () => {
        scans += 1
        throw new Error('Synthetic worker failure')
      },
      now: () => new Date(now),
    })

    expect((await service.history('30d')).scan.status).toBe('scanning')
    await service.waitForRefresh()
    const failed = await service.history('30d')
    await service.waitForRefresh()
    expect(failed.scan.status).toBe('idle')
    expect(scans).toBe(1)
    expect(failed.warnings).toEqual([
      'Usage indexing failed in the background: Synthetic worker failure',
    ])

    now += 60_000
    expect((await service.history('30d')).scan.status).toBe('scanning')
    await service.waitForRefresh()
    const retried = await service.history('30d')
    expect(scans).toBe(2)
    expect(retried.warnings).toEqual([
      'Usage indexing failed in the background: Synthetic worker failure',
    ])
  })

  it.each([2, 3])(
    'invalidates the blocking-scanner v%s cache after parser changes',
    async (version) => {
      const root = temporaryDirectory()
      const cacheFile = path.join(root, 'usage.json')
      writeFileSync(
        cacheFile,
        JSON.stringify({
          version,
          generatedAt: 123,
          files: [
            {
              path: path.join(root, 'session.jsonl'),
              provider: 'codex',
              mtimeMs: 1,
              size: 1,
              entries: [],
            },
          ],
        }),
      )

      const cache = await readUsageCache(cacheFile)
      expect(cache.version).toBe(8)
      expect(cache.generatedAt).toBe(0)
      expect(cache.files).toEqual([])
    },
  )

  it('invalidates v6 entries produced before copied subagent history was excluded', async () => {
    const root = temporaryDirectory()
    const cacheFile = path.join(root, 'usage.json')
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 6,
        generatedAt: 123,
        files: [
          {
            path: path.join(root, 'session.jsonl'),
            provider: 'codex',
            mtimeMs: 1,
            size: 400_000_000,
            entries: [
              {
                date: '2026-08-09',
                model: 'gpt-5.6-sol',
                sessionId: 'captured-subagent-shape',
                longContext: true,
                tokens: {
                  observedInputTokens: 1_987_113_817,
                  uncachedInputTokens: 1_987_113_817,
                  cachedInputTokens: 0,
                  cacheWrite5mInputTokens: 0,
                  cacheWrite1hInputTokens: 0,
                  outputTokens: 3_608_371,
                  reasoningTokens: 0,
                  processedTokens: 1_990_722_188,
                  providerReportedCostUsd: 0,
                },
              },
            ],
          },
        ],
        sources: [],
        warnings: [],
      }),
    )

    expect(await readUsageCache(cacheFile)).toMatchObject({
      version: 8,
      generatedAt: 0,
      files: [],
    })
  })

  it('treats a structurally invalid cache as a cold start', async () => {
    const root = temporaryDirectory()
    const cacheFile = path.join(root, 'usage.json')
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 7,
        generatedAt: 123,
        files: [
          {
            path: path.join(root, 'session.jsonl'),
            provider: 'codex',
            mtimeMs: 1,
            size: 1,
          },
        ],
        sources: [],
        warnings: [],
      }),
    )

    const cache = await readUsageCache(cacheFile)
    expect(cache.generatedAt).toBe(0)
    expect(cache.files).toEqual([])
  })

  it('invalidates caches from before the copied subagent boundary fix', async () => {
    const root = temporaryDirectory()
    const cacheFile = path.join(root, 'usage.json')
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 5,
        generatedAt: 123,
        files: [],
        sources: [],
        warnings: [],
      }),
    )

    expect(await readUsageCache(cacheFile)).toMatchObject({
      version: 8,
      generatedAt: 0,
      files: [],
    })
  })

  it('compacts per-message records without changing any reported figure', async () => {
    const root = temporaryDirectory()
    const files = uncompactedFixtureFiles(root)
    const rawFile = path.join(root, 'raw.json')
    const legacyFile = path.join(root, 'legacy.json')
    writeFileSync(rawFile, JSON.stringify(cacheFixture(8, files)))
    writeFileSync(legacyFile, JSON.stringify(cacheFixture(7, files)))

    const migrated = await readUsageCache(legacyFile)
    expect(migrated.version).toBe(8)
    expect(migrated.generatedAt).toBe(123)
    expect(migrated.files.map((file) => file.entries.length)).toEqual([4, 1, 3])

    for (const range of ['all', '7d'] as const) {
      const raw = await cachedHistory(rawFile, range)
      const compacted = await cachedHistory(legacyFile, range)
      expect(rounded(compacted)).toEqual(rounded(raw))
    }
    const raw = await cachedHistory(rawFile, 'all')
    expect(raw.sessionCount).toBe(5)
    expect(
      Object.fromEntries(
        raw.models.map((model) => [`${model.provider}:${model.model}`, model.sessionCount]),
      ),
    ).toEqual({
      'claude-code:claude-sonnet-4-5': 2,
      'codex:gpt-5.6-sol': 1,
      'opencode:gpt-5.6-sol': 1,
      'opencode:private-model': 1,
    })
    expect(raw.daily.map((day) => day.sessionCount)).toEqual([1, 0, 0, 0, 0, 0, 0, 5])
    expect(raw.totals.providerReportedTokens).toBe(60)
  })

  it('reuses computed figures until the index or the Harness events change', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    mkdirSync(codexRoot, { recursive: true })
    writeJsonLines(path.join(codexRoot, 'session.jsonl'), [
      { timestamp: '2026-08-08T09:00:00.000Z', type: 'session_meta', payload: { id: 'session' } },
      {
        timestamp: '2026-08-08T09:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-luna' },
      },
      codexTokenRecord('2026-08-08T09:01:00.000Z', { input_tokens: 1_000, output_tokens: 100 }),
    ])
    let harnessReads = 0
    let now = new Date('2026-08-08T12:00:00.000Z').getTime()
    const service = usageService({
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: { codex: codexRoot, 'claude-code': path.join(root, 'missing-claude') },
      harnessUsage: () => {
        harnessReads += 1
        return []
      },
      now: () => new Date(now),
    })

    const first = await settledHistory(service, '30d')
    expect(first.totals.processedTokens).toBe(1_100)
    const repeated = await service.history('30d')
    expect(repeated.totals).toBe(first.totals)
    expect(repeated.daily).toBe(first.daily)
    expect(repeated.scan).not.toBe(first.scan)
    expect(harnessReads).toBe(1)

    now += 5_000
    const reloaded = await service.history('30d')
    expect(harnessReads).toBe(2)
    expect(reloaded.totals).not.toBe(first.totals)
    expect(reloaded.totals).toEqual(first.totals)
  })

  it('counts every archived session in sources, not only the selected range', async () => {
    const root = temporaryDirectory()
    const cacheFile = path.join(root, 'usage.json')
    const entry = (sessionId: string, date: string) => ({
      date,
      model: 'claude-sonnet-4-5',
      sessionId,
      longContext: false,
      tokens: {
        uncachedInputTokens: 100,
        cachedInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
        providerReportedCostUsd: 0,
      },
    })
    writeFileSync(
      cacheFile,
      JSON.stringify(
        cacheFixture(8, [
          {
            path: path.join(root, 'claude.jsonl'),
            provider: 'claude-code',
            mtimeMs: 1,
            size: 1,
            entries: [entry('older', '2026-07-01'), entry('recent', '2026-08-08')],
          },
        ]),
      ),
    )

    const history = await cachedHistory(cacheFile, '7d')
    expect(history.sessionCount).toBe(1)
    expect(history.sources.find((source) => source.provider === 'claude-code')).toEqual({
      provider: 'claude-code',
      available: true,
      sessionCount: 2,
    })
    expect(history.sources.find((source) => source.provider === 'codex')?.sessionCount).toBe(0)
  })

  it('migrates a per-message v7 cache in place without reparsing any file', async () => {
    const root = temporaryDirectory()
    const claudeRoot = path.join(root, 'claude')
    const cacheFile = path.join(root, 'cache', 'usage.json')
    mkdirSync(claudeRoot, { recursive: true })
    writeJsonLines(
      path.join(claudeRoot, 'session.jsonl'),
      ['first', 'second', 'third'].map((id) =>
        claudeAssistantRecord({
          id,
          model: 'claude-sonnet-4-5',
          sessionId: 'claude-session',
          input: 100,
          cached: 40,
          output: 10,
        }),
      ),
    )
    const progress: { filesProcessed: number; filesTotal: number }[] = []
    const service = () =>
      new UsageHistoryService({
        cacheFile,
        sourceRoots: {
          'claude-code': claudeRoot,
          codex: path.join(root, 'missing-codex'),
          grok: path.join(root, 'missing-grok.jsonl'),
          opencode: path.join(root, 'missing-opencode'),
        },
        scanRunner: (request, onProgress) =>
          runUsageHistoryScan(request, (update) => {
            progress.push(update)
            onProgress(update)
          }),
        now: () => new Date('2026-08-08T12:00:00.000Z'),
      })
    const scanned = await settledHistory(service(), 'all')
    const compacted = (await readUsageCache(cacheFile)).files
    expect(compacted[0]?.entries).toHaveLength(1)

    const perMessage = await readClaudeUsageHistory(path.join(claudeRoot, 'session.jsonl'))
    expect(perMessage).toHaveLength(3)
    const saved = JSON.parse(readFileSync(cacheFile, 'utf8')) as { files: CachedUsageFile[] }
    writeFileSync(
      cacheFile,
      JSON.stringify({
        ...saved,
        version: 7,
        files: saved.files.map((file) => ({ ...file, entries: perMessage })),
      }),
    )

    progress.length = 0
    const migrated = await settledHistory(service(), 'all')
    expect(progress[0]).toEqual({ filesProcessed: 1, filesTotal: 1 })
    expect(migrated.totals).toEqual(scanned.totals)
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ version: 8 })
    expect((await readUsageCache(cacheFile)).files).toEqual(compacted)
  })

  it('saves the index only when a scan changes it', async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const cacheFile = path.join(root, 'cache', 'usage.json')
    const codexFile = path.join(codexRoot, 'session.jsonl')
    mkdirSync(codexRoot, { recursive: true })
    const records: unknown[] = [
      { timestamp: '2026-08-08T09:00:00.000Z', type: 'session_meta', payload: { id: 'session' } },
      {
        timestamp: '2026-08-08T09:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-luna' },
      },
      codexTokenRecord('2026-08-08T09:01:00.000Z', { input_tokens: 1_000, output_tokens: 100 }),
    ]
    writeJsonLines(codexFile, records)
    const noEvents: never[] = []
    let now = new Date('2026-08-08T12:00:00.000Z').getTime()
    const service = usageService({
      cacheFile,
      sourceRoots: { codex: codexRoot, 'claude-code': path.join(root, 'missing-claude') },
      harnessUsage: () => noEvents,
      now: () => new Date(now),
    })

    const first = await settledHistory(service, 'all')
    expect(first.generatedAt).toBe(now)
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ version: 8 })

    writeFileSync(cacheFile, 'left alone')
    now += 60_000
    const unchanged = await settledHistory(service, 'all')
    expect(readFileSync(cacheFile, 'utf8')).toBe('left alone')
    expect(unchanged.totals).toBe(first.totals)
    expect(unchanged.generatedAt).toBe(now)

    records.push(
      codexTokenRecord('2026-08-08T09:02:00.000Z', { input_tokens: 1_250, output_tokens: 125 }),
    )
    writeJsonLines(codexFile, records)
    const grown = await settledHistory(service, 'all', true)
    expect(grown.totals.processedTokens).toBe(1_375)
    const saved = await readUsageCache(cacheFile)
    expect(saved.generatedAt).toBe(now)
    expect(saved.files.map((file) => file.size)).toEqual([statSync(codexFile).size])
  })

  it('adds a grown transcript to its indexed records without counting a message twice', async () => {
    const root = temporaryDirectory()
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(claudeRoot, { recursive: true })
    const transcript = path.join(claudeRoot, 'session.jsonl')
    const message = (id: string, output: number) =>
      claudeAssistantRecord({
        id,
        model: 'claude-sonnet-4-5',
        sessionId: 'claude-session',
        input: 100,
        cached: 1_000,
        output,
      })
    writeJsonLines(transcript, [message('first', 10), message('second', 5)])
    const options = {
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: { 'claude-code': claudeRoot, codex: path.join(root, 'missing-codex') },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    }
    const service = usageService(options)
    await settledHistory(service, 'all')

    // The second message's next content block repeats its usage, now with more output.
    appendFileSync(transcript, `${JSON.stringify(message('second', 25))}\n`)
    appendFileSync(transcript, `${JSON.stringify(message('third', 1))}\n`)
    const grown = await settledHistory(service, 'all', true)
    expect(grown.totals).toMatchObject({ outputTokens: 36, processedTokens: 3_336 })
    const indexed = (await readUsageCache(options.cacheFile)).files
    expect(indexed[0]?.entries).toHaveLength(1)

    rmSync(options.cacheFile)
    const rebuilt = await settledHistory(usageService(options), 'all')
    expect(rounded(grown.totals)).toEqual(rounded(rebuilt.totals))
  })

  it('reads a grown rollout on from where the last scan stopped, also after a restart', async () => {
    const fixture = grownRolloutFixture()
    const options = {
      cacheFile: fixture.cacheFile,
      sourceRoots: { codex: fixture.codexRoot, 'claude-code': fixture.missingClaude },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    }
    const service = usageService(options)
    expect((await settledHistory(service, 'all')).totals.processedTokens).toBe(1_100)
    const saved = (await readUsageCache(fixture.cacheFile)).files[0]
    expect(saved?.checkpoint?.position.offset).toBe(statSync(fixture.rollout).size)

    // Bytes between the first and the last few KiB are trusted, not reread:
    // after this edit only a full read would see 2,000 input tokens.
    fixture.editMiddle()
    fixture.append({ input_tokens: 1_250, output_tokens: 125 })
    expect((await settledHistory(service, 'all', true)).totals.processedTokens).toBe(1_375)

    fixture.append({ input_tokens: 1_300, output_tokens: 130 })
    const restarted = usageService(options)
    expect((await settledHistory(restarted, 'all')).totals.processedTokens).toBe(1_430)
    expect((await readUsageCache(fixture.cacheFile)).files[0]?.checkpoint?.position.offset).toBe(
      statSync(fixture.rollout).size,
    )
  })

  it('reads a rewritten rollout and one past its checkpoint retention in full', async () => {
    const rewritten = grownRolloutFixture()
    const options = {
      cacheFile: rewritten.cacheFile,
      sourceRoots: { codex: rewritten.codexRoot, 'claude-code': rewritten.missingClaude },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    }
    const service = usageService(options)
    await settledHistory(service, 'all')
    rewritten.editMiddle()
    rewritten.editHead()
    rewritten.append({ input_tokens: 1_250, output_tokens: 125 })
    // Read in full: 2,000 + 100, then the drop to 1,250 + 125 counts as a rollback.
    expect((await settledHistory(service, 'all', true)).totals.processedTokens).toBe(3_475)

    const stale = grownRolloutFixture()
    const lastChange = new Date('2026-08-05T12:00:00.000Z')
    utimesSync(stale.rollout, lastChange, lastChange)
    const staleService = usageService({
      ...options,
      cacheFile: stale.cacheFile,
      sourceRoots: { codex: stale.codexRoot, 'claude-code': stale.missingClaude },
    })
    await settledHistory(staleService, 'all')
    expect((await readUsageCache(stale.cacheFile)).files[0]).not.toHaveProperty('checkpoint')
    stale.editMiddle()
    stale.append({ input_tokens: 1_250, output_tokens: 125 })
    expect((await settledHistory(staleService, 'all', true)).totals.processedTokens).toBe(3_475)
  })

  it('drops a damaged checkpoint without discarding the indexed file', async () => {
    const fixture = grownRolloutFixture()
    const options = {
      cacheFile: fixture.cacheFile,
      sourceRoots: { codex: fixture.codexRoot, 'claude-code': fixture.missingClaude },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    }
    await settledHistory(usageService(options), 'all')
    const saved = JSON.parse(readFileSync(fixture.cacheFile, 'utf8')) as {
      files: (CachedUsageFile & { checkpoint: unknown })[]
    }
    for (const file of saved.files) file.checkpoint = { position: 'damaged' }
    writeFileSync(fixture.cacheFile, JSON.stringify(saved))

    const cache = await readUsageCache(fixture.cacheFile)
    expect(cache.files).toHaveLength(1)
    expect(cache.files[0]).not.toHaveProperty('checkpoint')
    expect(cache.files[0]?.entries).toEqual(saved.files[0]?.entries)
  })

  it('reads a large saved index with the large-index loader and falls back when it fails', async () => {
    const root = temporaryDirectory()
    const smallFile = path.join(root, 'small.json')
    const largeFile = path.join(root, 'large.json')
    writeFileSync(smallFile, JSON.stringify(cacheFixture(7, uncompactedFixtureFiles(root))))
    const perMessage = Array.from({ length: 20_000 }, () => ({
      date: '2026-08-08',
      model: 'claude-sonnet-4-5',
      sessionId: 'claude',
      longContext: false,
      tokens: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        providerReportedCostUsd: 0,
      },
    }))
    const largeIndex = JSON.stringify(
      cacheFixture(7, [
        {
          path: path.join(root, 'claude.jsonl'),
          provider: 'claude-code',
          mtimeMs: 1,
          size: 1,
          entries: perMessage,
        },
      ]),
    )
    writeFileSync(largeFile, largeIndex)
    expect(statSync(largeFile).size).toBeGreaterThan(4 * 1024 * 1024)
    const loaded: string[] = []
    const loader: UsageCacheLoader = async (filePath) => {
      loaded.push(filePath)
      return loadUsageCache(filePath)
    }

    expect((await cachedHistory(smallFile, 'all', loader)).sessionCount).toBe(5)
    expect(loaded).toEqual([])

    const large = await cachedHistory(largeFile, 'all', loader)
    expect(loaded).toEqual([largeFile])
    expect(large.totals.processedTokens).toBe(40_000)
    // The migrated index is saved compacted, so the next start reads it on the event loop.
    expect(statSync(largeFile).size).toBeLessThan(4 * 1024 * 1024)
    expect((await readUsageCache(largeFile)).files[0]?.entries).toHaveLength(1)

    writeFileSync(largeFile, largeIndex)
    let failedLoads = 0
    const fellBack = await cachedHistory(largeFile, 'all', async () => {
      failedLoads += 1
      throw new Error('worker failed')
    })
    expect(failedLoads).toBe(1)
    expect(fellBack.totals).toEqual(large.totals)

    writeFileSync(largeFile, largeIndex)
    const stopped = new UsageHistoryService({
      cacheFile: largeFile,
      largeCacheLoader: (_filePath, signal) =>
        new Promise((_resolve, reject) => {
          const stop = () => reject(new Error('stopped'))
          if (signal.aborted) stop()
          else signal.addEventListener('abort', stop)
        }),
      scanRunner: () => Promise.reject(new Error('no scan after dispose')),
    })
    const pending = stopped.history('all')
    stopped.dispose()
    expect((await pending).totals.processedTokens).toBe(0)
    expect(readFileSync(largeFile, 'utf8')).toBe(largeIndex)
  })
})

describe('usage history of provider accounts', () => {
  it("reads every account's own folder beside the default one", async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex', 'sessions')
    const workCodex = path.join(root, 'accounts', 'codex', 'work')
    const workClaude = path.join(root, 'accounts', 'claude-code', 'work')
    const cacheFile = path.join(root, 'cache', 'usage.json')
    writeCodexRollout(path.join(codexRoot, 'own.jsonl'), 'own-session', 1_000)
    writeCodexRollout(path.join(workCodex, 'sessions', 'work.jsonl'), 'work-session', 2_000)
    mkdirSync(path.join(workClaude, 'projects', 'app'), { recursive: true })
    writeJsonLines(path.join(workClaude, 'projects', 'app', 'session.jsonl'), [
      claudeAssistantRecord({
        id: 'message',
        model: 'claude-sonnet-4-5',
        sessionId: 'claude-work',
        input: 300,
        output: 30,
      }),
    ])
    let homes = [
      { provider: 'codex' as const, accountId: 'work', home: workCodex },
      { provider: 'claude-code' as const, accountId: 'work', home: workClaude },
      // A provider without a local archive has nothing to read there.
      { provider: 'cursor' as const, accountId: 'work', home: path.join(root, 'cursor') },
    ]
    let now = new Date('2026-08-08T12:00:00.000Z').getTime()
    const service = usageService({
      cacheFile,
      sourceRoots: { codex: codexRoot, 'claude-code': path.join(root, 'missing-claude') },
      accountHomes: () => homes,
      now: () => new Date(now),
    })

    const history = await settledHistory(service, '7d')
    expect(history.totals.processedTokens).toBe(1_100 + 2_200 + 330)
    expect(history.sessionCount).toBe(3)
    expect(history.sources.find((source) => source.provider === 'claude-code')).toEqual({
      provider: 'claude-code',
      available: true,
      sessionCount: 1,
    })
    const saved = await readUsageCache(cacheFile)
    expect(
      saved.files.map((file) => [path.basename(file.path), file.provider, file.accountId]),
    ).toEqual(
      expect.arrayContaining([
        ['own.jsonl', 'codex', undefined],
        ['work.jsonl', 'codex', 'work'],
        ['session.jsonl', 'claude-code', 'work'],
      ]),
    )
    expect(saved.sources).toEqual(
      expect.arrayContaining([
        { provider: 'codex', label: expect.any(String), available: true },
        { provider: 'codex', accountId: 'work', label: expect.any(String), available: true },
      ]),
    )

    // A removed account's folder stays on disk but is no longer read.
    homes = []
    now += 60_000
    const removed = await settledHistory(service, '7d', true)
    expect(removed.totals.processedTokens).toBe(1_100)
    expect((await readUsageCache(cacheFile)).files.map((file) => file.accountId)).toEqual([
      undefined,
    ])
  })

  it('counts a file that two folders share once, for the default account', async () => {
    const root = temporaryDirectory()
    const home = path.join(root, 'codex')
    writeCodexRollout(path.join(home, 'sessions', 'own.jsonl'), 'own-session', 1_000)
    const cacheFile = path.join(root, 'cache', 'usage.json')
    const service = usageService({
      cacheFile,
      sourceRoots: {
        codex: path.join(home, 'sessions'),
        'claude-code': path.join(root, 'missing-claude'),
      },
      accountHomes: () => [{ provider: 'codex', accountId: 'twice', home }],
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })

    expect((await settledHistory(service, '7d')).totals.processedTokens).toBe(1_100)
    expect((await readUsageCache(cacheFile)).files.map((file) => file.accountId)).toEqual([
      undefined,
    ])
  })

  it("splits a provider's usage by account and answers one account alone", async () => {
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex', 'sessions')
    const workCodex = path.join(root, 'accounts', 'codex', 'work')
    writeCodexRollout(path.join(codexRoot, 'own.jsonl'), 'own-session', 1_000)
    writeCodexRollout(path.join(workCodex, 'sessions', 'work.jsonl'), 'work-session', 2_000)
    const usage = (inputTokens: number) => ({
      inputTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: inputTokens,
    })
    const at = new Date('2026-08-08T11:00:00.000Z').getTime()
    let homes: { provider: 'codex'; accountId: string; home: string }[] = []
    let events: StoredUsageEvent[] = [
      { threadId: 'api-chat', provider: 'api', at, usage: usage(500) },
    ]
    let now = new Date('2026-08-08T12:00:00.000Z').getTime()
    const service = usageService({
      cacheFile: path.join(root, 'cache', 'usage.json'),
      sourceRoots: { codex: codexRoot, 'claude-code': path.join(root, 'missing-claude') },
      accountHomes: () => homes,
      harnessUsage: () => events,
      now: () => new Date(now),
    })
    const rows = (history: UsageHistoryResult) =>
      history.providers.map((row) => [row.provider, row.accountId, row.totals.processedTokens])

    // Usage on the default account alone keeps one row per provider, as before accounts.
    expect(rows(await settledHistory(service, '7d'))).toEqual([
      ['codex', undefined, 1_100],
      ['api', undefined, 500],
    ])

    homes = [{ provider: 'codex', accountId: 'work', home: workCodex }]
    events = [
      ...events,
      // Work's own archive has its records, so its events would count them twice.
      { threadId: 'work-chat', provider: 'codex', accountId: 'work', at, usage: usage(9_000) },
      // An account without records of its own counts its chats' events.
      { threadId: 'client-chat', provider: 'codex', accountId: 'client', at, usage: usage(700) },
    ]
    now += 60_000
    const all = await settledHistory(service, '7d', true)
    expect(rows(all).sort()).toEqual(
      [
        ['codex', 'work', 2_200],
        ['codex', 'default', 1_100],
        ['codex', 'client', 700],
        ['api', undefined, 500],
      ].sort(),
    )
    expect(all.totals.processedTokens).toBe(2_200 + 1_100 + 700 + 500)

    const work = await service.history('7d', false, { provider: 'codex', accountId: 'work' })
    expect(rows(work)).toEqual([['codex', 'work', 2_200]])
    expect(work.totals.processedTokens).toBe(2_200)
    expect(work.sessionCount).toBe(1)
    expect(work.models.map((model) => [model.provider, model.totals.processedTokens])).toEqual([
      ['codex', 2_200],
    ])
    expect(work.daily.at(-1)?.providers).toEqual([
      { provider: 'codex', tokens: 2_200, estimatedCostUsd: expect.any(Number) },
    ])
    expect(work.sources).toEqual([{ provider: 'codex', available: true, sessionCount: 1 }])
    // The same question is answered from the figures already computed.
    expect(
      (await service.history('7d', false, { provider: 'codex', accountId: 'work' })).totals,
    ).toBe(work.totals)

    const own = await service.history('7d', false, { provider: 'codex', accountId: 'default' })
    expect(rows(own)).toEqual([['codex', 'default', 1_100]])
    const api = await service.history('7d', false, { provider: 'api', accountId: 'default' })
    expect(rows(api)).toEqual([['api', 'default', 500]])
    expect(api.sources).toEqual([{ provider: 'api', available: true, sessionCount: 1 }])
  })

  it("keeps each file's account in the saved index and refuses a malformed one", async () => {
    const root = temporaryDirectory()
    const cacheFile = path.join(root, 'usage.json')
    const file = (accountId: unknown) => ({
      path: path.join(root, 'work.jsonl'),
      provider: 'codex',
      accountId,
      mtimeMs: 1,
      size: 1,
      entries: [],
    })
    writeFileSync(cacheFile, JSON.stringify(cacheFixture(8, [file('work') as CachedUsageFile])))
    expect((await loadUsageCache(cacheFile)).cache.files.map((each) => each.accountId)).toEqual([
      'work',
    ])

    writeFileSync(cacheFile, JSON.stringify(cacheFixture(8, [file('Work') as CachedUsageFile])))
    expect((await loadUsageCache(cacheFile)).cache.files).toEqual([])
  })
})

/** A Codex rollout of one session whose token count reaches `input` in, a tenth of it out. */
function writeCodexRollout(filePath: string, sessionId: string, input: number): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeJsonLines(filePath, [
    { timestamp: '2026-08-08T09:00:00.000Z', type: 'session_meta', payload: { id: sessionId } },
    {
      timestamp: '2026-08-08T09:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna' },
    },
    codexTokenRecord('2026-08-08T09:01:00.000Z', {
      input_tokens: input,
      output_tokens: input / 10,
    }),
  ])
}

function uncompactedFixtureFiles(root: string) {
  const tokens = (values: Partial<CachedUsageFile['entries'][number]['tokens']>) => ({
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    providerReportedCostUsd: 0,
    ...values,
  })
  const record = (
    sessionId: string,
    model: string,
    date: string,
    values: Partial<CachedUsageFile['entries'][number]['tokens']>,
    longContext = false,
  ) => ({ date, model, sessionId, longContext, tokens: tokens(values) })
  return [
    {
      path: path.join(root, 'claude.jsonl'),
      provider: 'claude-code',
      mtimeMs: 1,
      size: 1,
      entries: [
        record('claude', 'claude-sonnet-4-5', '2026-08-08', { uncachedInputTokens: 100 }),
        record('claude', 'claude-sonnet-4-5', '2026-08-08', {
          uncachedInputTokens: 50,
          cachedInputTokens: 400,
          cacheWrite5mInputTokens: 20,
          cacheWrite1hInputTokens: 10,
          outputTokens: 30,
        }),
        record('claude', 'claude-sonnet-4-5', '2026-08-08', { uncachedInputTokens: 300_000 }, true),
        record('claude', 'claude-sonnet-4-5', '2026-08-01', { outputTokens: 7 }),
        record('claude-2', 'claude-sonnet-4-5', '2026-08-08', { uncachedInputTokens: 11 }),
      ],
    },
    {
      path: path.join(root, 'codex.jsonl'),
      provider: 'codex',
      mtimeMs: 1,
      size: 1,
      entries: [
        record('codex', 'gpt-5.6-sol', '2026-08-08', {
          observedInputTokens: 900,
          uncachedInputTokens: 600,
          cachedInputTokens: 500,
          outputTokens: 40,
          reasoningTokens: 12,
          processedTokens: 950,
        }),
        record('codex', 'gpt-5.6-sol', '2026-08-08', {
          uncachedInputTokens: 70,
          cachedInputTokens: 30,
          outputTokens: 5,
        }),
      ],
    },
    {
      path: path.join(root, 'opencode.db'),
      provider: 'opencode',
      mtimeMs: 1,
      size: 1,
      entries: [
        record('opencode', 'gpt-5.6-sol', '2026-08-08', {
          uncachedInputTokens: 40,
          outputTokens: 20,
          providerReportedCostUsd: 0.5,
        }),
        record('opencode', 'gpt-5.6-sol', '2026-08-08', { uncachedInputTokens: 1_000 }),
        record('other-opencode', 'private-model', '2026-08-08', { outputTokens: 9 }),
      ],
    },
  ] satisfies CachedUsageFile[]
}

function cacheFixture(version: number, files: CachedUsageFile[]) {
  return { version, generatedAt: 123, files, sources: [], warnings: [] }
}

async function cachedHistory(
  cacheFile: string,
  range: UsageHistoryRange,
  largeCacheLoader?: UsageCacheLoader,
) {
  const cache = await readUsageCache(cacheFile)
  const service = new UsageHistoryService({
    cacheFile,
    scanRunner: async (request) => ({
      paths: request.indexed.map((file) => file.path),
      files: [],
      sources: cache.sources,
      warnings: cache.warnings,
    }),
    now: () => new Date('2026-08-08T12:00:00.000Z'),
    ...(largeCacheLoader ? { largeCacheLoader } : {}),
  })
  await service.history(range)
  await service.waitForRefresh()
  return service.history(range)
}

function rounded(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'number' ? Number(item.toPrecision(12)) : item,
    ),
  )
}

function usageService(
  options: Omit<ConstructorParameters<typeof UsageHistoryService>[0], 'scanRunner'>,
): UsageHistoryService {
  const isolatedRoot = path.dirname(options.cacheFile)
  return new UsageHistoryService({
    ...options,
    sourceRoots: {
      grok: path.join(isolatedRoot, 'missing-grok.jsonl'),
      opencode: path.join(isolatedRoot, 'missing-opencode'),
      ...options.sourceRoots,
    },
    scanRunner: runUsageHistoryScan,
  })
}

async function settledHistory(
  service: UsageHistoryService,
  range: UsageHistoryRange,
  refresh = false,
) {
  await service.history(range, refresh)
  await service.waitForRefresh()
  return service.history(range)
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-usage-'))
  temporaryDirectories.push(directory)
  return directory
}

function writeJsonLines(filePath: string, records: unknown[]): void {
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}

/**
 * A Codex rollout over 8 KiB with its only token count in the middle, away from
 * the bytes a checkpoint hashes, so a test can tell a resumed read from a full one.
 */
function grownRolloutFixture() {
  const root = temporaryDirectory()
  const codexRoot = path.join(root, 'codex')
  mkdirSync(codexRoot, { recursive: true })
  const rollout = path.join(codexRoot, 'session.jsonl')
  const filler = Array.from({ length: 40 }, (_value, index) => ({
    timestamp: '2026-08-08T09:00:30.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: `${'x'.repeat(200)} ${index}` },
  }))
  writeJsonLines(rollout, [
    { timestamp: '2026-08-08T09:00:00.000Z', type: 'session_meta', payload: { id: 'session' } },
    {
      timestamp: '2026-08-08T09:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna' },
    },
    ...filler,
    codexTokenRecord('2026-08-08T09:01:00.000Z', { input_tokens: 1_000, output_tokens: 100 }),
    ...filler,
  ])
  const replace = (from: string, to: string) => {
    const content = readFileSync(rollout, 'utf8')
    expect(content).toContain(from)
    writeFileSync(rollout, content.replace(from, to))
  }
  return {
    rollout,
    codexRoot,
    cacheFile: path.join(root, 'cache', 'usage.json'),
    missingClaude: path.join(root, 'missing-claude'),
    /** Same length, so only the token count changes. */
    editMiddle: () => replace('"input_tokens":1000', '"input_tokens":2000'),
    editHead: () => replace('"id":"session"', '"id":"rewrit"'),
    append: (total: Record<string, number>) =>
      appendFileSync(
        rollout,
        `${JSON.stringify(codexTokenRecord('2026-08-08T09:02:00.000Z', total))}\n`,
      ),
  }
}

function codexTokenRecord(timestamp: string, total: Record<string, number>) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: total },
    },
  }
}

function claudeAssistantRecord(options: {
  id: string
  model: string
  sessionId: string
  input: number
  cached?: number
  cacheWrite?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
  output: number
}) {
  return {
    type: 'assistant',
    uuid: `${options.id}-snapshot`,
    timestamp: '2026-08-08T10:00:00.000Z',
    sessionId: options.sessionId,
    message: {
      id: options.id,
      model: options.model,
      usage: {
        input_tokens: options.input,
        cache_read_input_tokens: options.cached ?? 0,
        cache_creation_input_tokens: options.cacheWrite ?? 0,
        output_tokens: options.output,
        cache_creation: {
          ephemeral_5m_input_tokens: options.cacheWrite5m ?? 0,
          ephemeral_1h_input_tokens: options.cacheWrite1h ?? 0,
        },
      },
    },
  }
}
