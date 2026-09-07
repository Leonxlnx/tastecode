import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderId, UsageHistoryRange } from '@harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { readUsageCache, runUsageHistoryScan, UsageHistoryService } from './usage-history.js'

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
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: claudeRoot,
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
    expect(history.totals.estimatedCostUsd).toBeCloseTo(0.0103625, 8)
    expect(history.totals.cacheSavingsUsd).toBeCloseTo(0.002025, 8)
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
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: claudeRoot,
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
        codexSessionsRoot: codexRoot,
        claudeProjectsRoot: claudeRoot,
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
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: claudeRoot,
      grokLogPath: path.join(root, 'missing-grok.jsonl'),
      openCodeDataRoot: path.join(root, 'missing-opencode'),
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
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: claudeRoot,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })

    const history = await settledHistory(service, '7d')
    expect(history.totals.estimatedCostUsd).toBeCloseTo(3.00451, 8)
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
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: claudeRoot,
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
    expect(history.totals.estimatedCostUsd).toBeCloseTo(0.04155, 8)
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
      'codex',
      'claude-code',
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
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: claudeRoot,
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
      codexSessionsRoot: path.join(root, 'missing-codex'),
      claudeProjectsRoot: path.join(root, 'missing-claude'),
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
    expect(history.totals.estimatedCostUsd).toBeCloseTo(4.01, 8)
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
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: claudeRoot,
      grokLogPath: path.join(root, 'missing-grok.jsonl'),
      openCodeDataRoot: path.join(root, 'missing-opencode'),
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
      codexSessionsRoot: path.join(root, 'missing-codex'),
      claudeProjectsRoot: path.join(root, 'missing-claude'),
      grokLogPath: path.join(root, 'missing-grok.jsonl'),
      openCodeDataRoot: path.join(root, 'missing-opencode'),
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
      expect(cache.version).toBe(7)
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
      version: 7,
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
      version: 7,
      generatedAt: 0,
      files: [],
    })
  })

  it('writes the scan cache with user-only permissions', async () => {
    if (process.platform === 'win32') return
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })
    const cacheFile = path.join(root, 'cache', 'usage.json')

    const service = usageService({
      cacheFile,
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: claudeRoot,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })
    await settledHistory(service, 'all')

    expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(cacheFile)).mode & 0o777).toBe(0o700)
  })

  it('tightens a cache file and directory left readable by an older build', async () => {
    if (process.platform === 'win32') return
    const root = temporaryDirectory()
    const codexRoot = path.join(root, 'codex')
    const claudeRoot = path.join(root, 'claude')
    mkdirSync(codexRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })
    const cacheFile = path.join(root, 'cache', 'usage.json')
    mkdirSync(path.dirname(cacheFile), { recursive: true })
    chmodSync(path.dirname(cacheFile), 0o755)
    writeFileSync(
      cacheFile,
      JSON.stringify({ version: 7, generatedAt: 0, files: [], sources: [], warnings: [] }),
    )
    chmodSync(cacheFile, 0o644)

    const service = usageService({
      cacheFile,
      codexSessionsRoot: codexRoot,
      claudeProjectsRoot: claudeRoot,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    })
    await settledHistory(service, 'all')

    // The atomic rename replaces the loose file with the 0600 temp inode.
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(cacheFile)).mode & 0o777).toBe(0o700)
  })
})

function usageService(
  options: Omit<ConstructorParameters<typeof UsageHistoryService>[0], 'scanRunner'>,
): UsageHistoryService {
  const isolatedRoot = path.dirname(options.cacheFile)
  return new UsageHistoryService({
    grokLogPath: path.join(isolatedRoot, 'missing-grok.jsonl'),
    openCodeDataRoot: path.join(isolatedRoot, 'missing-opencode'),
    ...options,
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
