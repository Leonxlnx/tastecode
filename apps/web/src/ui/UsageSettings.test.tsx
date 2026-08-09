// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  ProviderId,
  ResultOf,
  UsageHistoryRange,
  UsageHistoryTotals,
} from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { UsageSettings } from './UsageSettings.js'

afterEach(cleanup)

describe('usage settings', () => {
  it('loads local history, changes period, and explicitly requests a rescan', async () => {
    const request = vi.fn(
      async (_method: string, params: { range: UsageHistoryRange; refresh?: boolean }) =>
        historyResult(params.range),
    )
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)

    expect(screen.getByText('Loading cached usage')).toBeTruthy()
    await screen.findByText('$12.34', { selector: '.usage-cost__value' })
    expect(screen.getAllByText('1.23M').length).toBeGreaterThan(0)
    expect(screen.getByText('gpt-5.6-sol')).toBeTruthy()
    expect(request).toHaveBeenNthCalledWith(1, 'usage.history', { range: '30d' })

    fireEvent.click(screen.getByRole('radio', { name: '7 days' }))
    await waitFor(() => {
      expect(request).toHaveBeenNthCalledWith(2, 'usage.history', { range: '7d' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Check for new usage' }))
    await waitFor(() => {
      expect(request).toHaveBeenNthCalledWith(3, 'usage.history', {
        range: '7d',
        refresh: true,
      })
    })
  })

  it('switches the graph and table to their alternate views', async () => {
    const transport = {
      request: vi.fn(async () => historyResult('30d')),
    } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await screen.findByText('gpt-5.6-sol')

    fireEvent.click(screen.getByRole('radio', { name: 'Tokens' }))
    expect(screen.getByRole('heading', { name: 'Tokens over time' })).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Day' }))
    expect(screen.getByRole('columnheader', { name: 'Day' })).toBeTruthy()
    expect(screen.getByText('Aug 8, 2026')).toBeTruthy()
  })

  it('keeps cached totals visible and updates when background indexing finishes', async () => {
    let call = 0
    const request = vi.fn(async () => {
      const result = historyResult('30d')
      if (call === 0) result.scan = { status: 'scanning', filesProcessed: 10, filesTotal: 100 }
      call += 1
      return result
    })
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)

    expect(await screen.findByText(/Indexing local usage in the background/)).toBeTruthy()
    expect(screen.getByText('$12.34', { selector: '.usage-cost__value' })).toBeTruthy()
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2), { timeout: 1_500 })
    await waitFor(() => {
      expect(screen.queryByText(/Indexing local usage in the background/)).toBeNull()
    })
  })

  it('uses the product names for every provider', async () => {
    const providers: Array<{ id: ProviderId; label: string }> = [
      { id: 'codex', label: 'Codex' },
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'grok', label: 'Grok' },
      { id: 'cursor', label: 'Cursor' },
      { id: 'opencode', label: 'OpenCode' },
      { id: 'antigravity', label: 'Antigravity' },
      { id: 'acp', label: 'ACP' },
      { id: 'api', label: 'API' },
    ]
    const result = historyResult('30d')
    result.providers = providers.map((provider) => ({
      provider: provider.id,
      sessionCount: 1,
      totals: usageTotals({ processedTokens: 1 }),
    }))
    const transport = { request: vi.fn(async () => result) } as unknown as Transport
    render(<UsageSettings transport={transport} />)

    await screen.findByRole('heading', { name: 'Usage' })
    for (const provider of providers) {
      expect(screen.getAllByText(provider.label).length).toBeGreaterThan(0)
    }
  })
})

function historyResult(range: UsageHistoryRange): ResultOf<'usage.history'> {
  const totals = usageTotals({
    uncachedInputTokens: 200_000,
    cachedInputTokens: 1_000_000,
    cacheWriteInputTokens: 10_000,
    outputTokens: 20_000,
    reasoningTokens: 5_000,
    processedTokens: 1_230_000,
    estimatedCostUsd: 12.34,
    cacheSavingsUsd: 4.56,
    pricedTokens: 1_230_000,
  })
  return {
    range,
    startDate: '2026-07-10',
    endDate: '2026-08-08',
    generatedAt: 1,
    sessionCount: 4,
    activeDays: 1,
    totals,
    providers: [{ provider: 'codex', sessionCount: 4, totals }],
    models: [
      {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        sessionCount: 4,
        pricing: 'exact',
        totals,
      },
    ],
    daily: [
      {
        date: '2026-08-08',
        sessionCount: 4,
        totals,
        providers: [
          {
            provider: 'codex',
            tokens: totals.processedTokens,
            estimatedCostUsd: totals.estimatedCostUsd,
          },
        ],
      },
    ],
    sources: [{ provider: 'codex', available: true, sessionCount: 4 }],
    scan: { status: 'idle', filesProcessed: 4, filesTotal: 4 },
    warnings: [],
  }
}

function usageTotals(values: Partial<UsageHistoryTotals>): UsageHistoryTotals {
  return {
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
    ...values,
  }
}
