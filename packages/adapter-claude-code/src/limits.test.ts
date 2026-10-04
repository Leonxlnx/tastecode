import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeLimitSource, mapClaudeUsage } from './limits.js'
import type { ClaudeUsageQueryFactory } from './sdk-runtime.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Claude Code subscription limits', () => {
  it('maps every reported window and reset time', () => {
    expect(
      mapClaudeUsage({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42.5, resets_at: '2026-08-22T10:00:00Z' },
          seven_day: { utilization: 80, resets_at: '2026-08-25T00:00:00Z' },
          seven_day_sonnet: { utilization: 0, resets_at: null },
          seven_day_opus: null,
          seven_day_oauth_apps: { utilization: null, resets_at: null },
          model_scoped: [
            { display_name: 'fable', utilization: 55, resets_at: '2026-08-26T00:00:00Z' },
          ],
          extra_usage: { is_enabled: true, utilization: 12 },
        },
      }),
    ).toEqual({
      status: 'ready',
      limits: [
        { label: 'Session', usedPercent: 42.5, resetsAt: Date.parse('2026-08-22T10:00:00Z') },
        { label: 'Weekly', usedPercent: 80, resetsAt: Date.parse('2026-08-25T00:00:00Z') },
        { label: 'Sonnet weekly', usedPercent: 0 },
        { label: 'Fable weekly', usedPercent: 55, resetsAt: Date.parse('2026-08-26T00:00:00Z') },
        { label: 'Extra usage', usedPercent: 12 },
      ],
    })
  })

  it('clamps invalid percentages and deduplicates model windows', () => {
    expect(
      mapClaudeUsage({
        rate_limits_available: true,
        rate_limits: {
          seven_day_sonnet: { utilization: 130, resets_at: null },
          model_scoped: [
            { display_name: 'Sonnet', utilization: 20, resets_at: null },
            { display_name: ' ', utilization: 30, resets_at: null },
          ],
        },
      }),
    ).toEqual({
      status: 'ready',
      limits: [{ label: 'Sonnet weekly', usedPercent: 100 }],
    })
  })

  it('keeps non-subscription sessions unavailable', () => {
    expect(mapClaudeUsage({ rate_limits_available: false, rate_limits: null })).toEqual({
      status: 'unavailable',
    })
    expect(mapClaudeUsage({ rate_limits_available: true, rate_limits: null })).toEqual({
      status: 'unavailable',
    })
  })

  it('rejects malformed experimental responses', () => {
    expect(() => mapClaudeUsage({ rate_limits_available: true, rate_limits: 'changed' })).toThrow(
      'Claude usage response was invalid.',
    )
    expect(() =>
      mapClaudeUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 20, resets_at: 'not-a-date' } },
      }),
    ).toThrow('Claude usage response was invalid.')
  })

  it('reads usage through a short-lived SDK query and closes it', async () => {
    const close = vi.fn()
    const usage = vi.fn().mockResolvedValue({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 25, resets_at: null } },
    } as SDKControlGetUsageResponse)
    const createQuery = vi.fn<ClaudeUsageQueryFactory>(() => ({
      close,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
    }))

    await expect(claudeLimitSource({ createQuery })).resolves.toEqual({
      status: 'ready',
      limits: [{ label: 'Session', usedPercent: 25 }],
    })
    expect(usage).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    const input = createQuery.mock.calls[0]?.[0]
    expect(input?.options).toMatchObject({
      pathToClaudeCodeExecutable: 'claude',
      persistSession: false,
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
    })
    expect(input?.options.abortController?.signal.aborted).toBe(true)
  })

  it('closes a failed query and reports a stable error', async () => {
    const close = vi.fn()
    const createQuery = vi.fn<ClaudeUsageQueryFactory>(() => ({
      close,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi
        .fn()
        .mockRejectedValue(new Error('private detail')),
    }))

    await expect(claudeLimitSource({ createQuery })).rejects.toThrow('Claude usage request failed.')
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps provider-owned credentials and private OAuth APIs out of production sources', async () => {
    const sourceDir = dirname(fileURLToPath(import.meta.url))
    const names = (await readdir(sourceDir)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )
    const productionSource = (
      await Promise.all(names.map((name) => readFile(join(sourceDir, name), 'utf8')))
    ).join('\n')
    const forbidden = [
      '.creden' + 'tials.json',
      '/api/oauth/' + 'usage',
      '/v1/oauth/' + 'token',
      'refresh_' + 'token',
      'client_' + 'id',
      'claude-code/' + '2.',
    ]

    for (const marker of forbidden) expect(productionSource).not.toContain(marker)
  })
})
