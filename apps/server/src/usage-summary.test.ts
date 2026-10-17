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

describe('usage summary with held limits', () => {
  const held = {
    provider: 'claude-code' as const,
    status: 'ready' as const,
    limits: [{ id: 'five_hour', label: '5-hour', usedPercent: 30 }],
    checkedAt: 1_000,
    origin: 'read' as const,
  }

  it('answers with the held source at once and refreshes it in the background', async () => {
    // A vendor read that never answers must not hold the chat's totals.
    const load = vi.fn(() => new Promise<never>(() => {}))

    await expect(usageSummaryWithLimits(totals, 'claude-code', load, () => held)).resolves.toEqual({
      ...totals,
      limitSource: held,
      limits: held.limits,
    })
    expect(load).toHaveBeenCalledExactlyOnceWith('claude-code')
  })

  it('waits for the first read while nothing is held', async () => {
    const load = vi.fn(async () => held)

    await expect(
      usageSummaryWithLimits(totals, 'claude-code', load, () => undefined),
    ).resolves.toMatchObject({ limitSource: held })
    expect(load).toHaveBeenCalledOnce()
  })

  it('keeps answering when the background refresh fails', async () => {
    const load = vi.fn().mockRejectedValue(new Error('provider request failed'))

    await expect(
      usageSummaryWithLimits(totals, 'claude-code', load, () => held),
    ).resolves.toMatchObject({ limitSource: held })
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
  })

  it('rejects a held source for a different provider', async () => {
    await expect(
      usageSummaryWithLimits(
        totals,
        'codex',
        async () => held,
        () => held,
      ),
    ).rejects.toThrow('Provider limit source did not match the request.')
  })
})
