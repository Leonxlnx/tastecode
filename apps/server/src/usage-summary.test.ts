import { describe, expect, it, vi } from 'vitest'
import type { ResultOf } from '@harness/contracts'
import { usageSummaryWithLimits } from './usage-summary.js'

const totals: Pick<ResultOf<'usage.summary'>, 'session' | 'today'> = {
  session: {
    inputTokens: 1,
    cachedInputTokens: 2,
    outputTokens: 3,
    reasoningTokens: 4,
    totalTokens: 10,
  },
  today: {
    inputTokens: 11,
    cachedInputTokens: 12,
    outputTokens: 13,
    reasoningTokens: 14,
    totalTokens: 50,
  },
}

describe('usage summary limit source', () => {
  it('returns the authoritative source and an exact legacy flatten', async () => {
    const limits = [{ label: 'Weekly', usedPercent: 25 }]

    await expect(
      usageSummaryWithLimits(totals, 'grok', async () => ({
        provider: 'grok',
        status: 'ready',
        limits,
      })),
    ).resolves.toEqual({
      ...totals,
      limitSource: { provider: 'grok', status: 'ready', limits },
      limits,
    })
  })

  it('flattens unavailable to an empty legacy list', async () => {
    await expect(
      usageSummaryWithLimits(totals, 'api', async () => ({
        provider: 'api',
        status: 'unavailable',
      })),
    ).resolves.toEqual({
      ...totals,
      limitSource: { provider: 'api', status: 'unavailable' },
      limits: [],
    })
  })

  it('rejects a source for a different provider', async () => {
    await expect(
      usageSummaryWithLimits(totals, 'codex', async () => ({
        provider: 'grok',
        status: 'unavailable',
      })),
    ).rejects.toThrow('Provider limit source did not match the request.')
  })

  it('propagates a real source failure', async () => {
    const load = vi.fn().mockRejectedValue(new Error('provider request failed'))

    await expect(usageSummaryWithLimits(totals, 'codex', load)).rejects.toThrow(
      'provider request failed',
    )
  })
})
