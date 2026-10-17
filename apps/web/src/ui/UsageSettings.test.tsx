// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  ProviderId,
  ResultOf,
  UsageHistoryRange,
  UsageHistoryTotals,
} from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { ProfileSettings } from './ProfileSettings.js'
import { UsageSettings } from './UsageSettings.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function advance(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

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
    expect(screen.getByRole('columnheader', { name: 'Cache hit rate' })).toBeTruthy()
    expect(screen.getByText('82.6%')).toBeTruthy()
    for (const metric of ['processed', 'cached', 'uncached', 'output', 'savings']) {
      const tooltipId = `usage-metric-${metric}-details`
      const tooltip = document.getElementById(tooltipId)
      expect(
        document.querySelector(`[aria-describedby="${tooltipId}"]`)?.getAttribute('tabindex'),
      ).toBe('0')
      expect(tooltip?.getAttribute('role')).toBe('tooltip')
    }
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
    const result = historyResult('30d')
    const day = result.daily[0]!
    result.daily = [0, 1_230_000, 0].map((tokens, index) => ({
      ...day,
      date: `2026-08-0${index + 6}`,
      providers: [{ provider: 'codex', tokens, estimatedCostUsd: tokens / 100_000 }],
    }))
    const transport = {
      request: vi.fn(async () => result),
    } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await screen.findByText('gpt-5.6-sol')

    fireEvent.click(screen.getByRole('radio', { name: 'Tokens' }))
    expect(screen.getByRole('heading', { name: 'Tokens over time' })).toBeTruthy()
    expect(document.querySelector('.usage-chart canvas')).toBeNull()
    expect(document.querySelector('.usage-chart polyline')).toBeNull()
    expect(document.querySelector('.usage-chart__line')?.getAttribute('d')).toContain(' C ')
    expect(document.querySelector('.usage-chart__area')?.getAttribute('d')).toMatch(/ C .* Z$/)

    fireEvent.click(screen.getByRole('radio', { name: 'Day' }))
    expect(screen.getByRole('columnheader', { name: 'Day' })).toBeTruthy()
    expect(screen.getByText('Aug 8, 2026')).toBeTruthy()
  })

  it('plots each provider independently instead of attributing the stack total to the last one', async () => {
    const result = historyResult('30d')
    const codexTotals = usageTotals({ processedTokens: 100, estimatedCostUsd: 10 })
    const grokTotals = usageTotals({ processedTokens: 20, estimatedCostUsd: 2 })
    result.providers = [
      { provider: 'codex', sessionCount: 1, totals: codexTotals },
      { provider: 'grok', sessionCount: 1, totals: grokTotals },
    ]
    result.daily = [
      {
        date: '2026-08-08',
        sessionCount: 2,
        totals: usageTotals({ processedTokens: 120, estimatedCostUsd: 12 }),
        providers: [
          { provider: 'codex', tokens: 100, estimatedCostUsd: 10 },
          { provider: 'grok', tokens: 20, estimatedCostUsd: 2 },
        ],
      },
    ]
    const transport = { request: vi.fn(async () => result) } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await screen.findByRole('heading', { name: 'Usage' })

    fireEvent.click(screen.getByRole('radio', { name: 'Tokens' }))
    const codexPath = document.querySelector(
      ".usage-chart__series[data-provider='codex'] .usage-chart__line",
    )
    const grokPath = document.querySelector(
      ".usage-chart__series[data-provider='grok'] .usage-chart__line",
    )
    expect(pathStartY(grokPath)).toBeGreaterThan(pathStartY(codexPath))
  })

  it('keeps cached totals visible and checks a background scan again after 2 s', async () => {
    vi.useFakeTimers()
    let call = 0
    const request = vi.fn(async () => {
      const result = historyResult('30d')
      if (call === 0) result.scan = { status: 'scanning', filesProcessed: 10, filesTotal: 100 }
      call += 1
      return result
    })
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.getByText(/Indexing local usage in the background/)).toBeTruthy()
    expect(screen.getByText('$12.34', { selector: '.usage-cost__value' })).toBeTruthy()
    await advance(1_999)
    expect(request).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Indexing local usage in the background/)).toBeNull()
  })

  it('keeps polling a background scan after a transient refresh failure', async () => {
    vi.useFakeTimers()
    let call = 0
    const request = vi.fn(async () => {
      const result = historyResult('30d')
      if (call === 0) {
        result.scan = { status: 'scanning', filesProcessed: 10, filesTotal: 100 }
      } else if (call === 1) {
        call += 1
        throw new Error('Temporary connection failure')
      }
      call += 1
      return result
    })
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.getByText(/Indexing local usage in the background/)).toBeTruthy()
    await advance(2_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Temporary connection failure/)).toBeTruthy()
    await advance(3_000)
    expect(request).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(/Indexing local usage in the background/)).toBeNull()
  })

  it('cancels a pending scan poll when the page unmounts', async () => {
    vi.useFakeTimers()
    const result = historyResult('30d')
    result.scan = { status: 'scanning', filesProcessed: 10, filesTotal: 100 }
    const request = vi.fn(async () => result)
    const transport = { request } as unknown as Transport
    const view = render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.getByText(/Indexing local usage in the background/)).toBeTruthy()
    view.unmount()
    await advance(30_000)

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('shares the all-time history with the profile page', async () => {
    const request = vi.fn(async (_method: string, params: { range: UsageHistoryRange }) =>
      historyResult(params.range),
    )
    const transport = { request } as unknown as Transport
    const view = render(<UsageSettings transport={transport} />)
    await screen.findByText('gpt-5.6-sol')
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    view.unmount()

    render(<ProfileSettings transport={transport} account={undefined} providerName="Codex" />)
    expect(await screen.findByRole('heading', { name: 'Local activity' })).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('labels the cost a partial estimate when over 5% of tokens have no price', async () => {
    const result = historyResult('30d')
    result.totals = usageTotals({
      processedTokens: 1_000_000,
      pricedTokens: 6_000,
      providerReportedTokens: 4_000,
      unpricedTokens: 990_000,
      estimatedCostUsd: 12.34,
    })
    const transport = { request: vi.fn(async () => result) } as unknown as Transport
    const view = render(<UsageSettings transport={transport} />)

    const value = await screen.findByText('$12.34', { selector: '.usage-cost__value' })
    expect(value.classList.contains('usage-cost__value--partial')).toBe(true)
    expect(screen.getByText('Partial estimate · 1.0% of tokens priced')).toBeTruthy()
    expect(screen.queryByText('At current public model rates')).toBeNull()
    view.unmount()

    result.totals = { ...result.totals, pricedTokens: 946_000, unpricedTokens: 50_000 }
    const fullTransport = { request: vi.fn(async () => result) } as unknown as Transport
    render(<UsageSettings transport={fullTransport} />)
    const full = await screen.findByText('$12.34', { selector: '.usage-cost__value' })
    expect(full.classList.contains('usage-cost__value--partial')).toBe(false)
    expect(screen.getByText('At current public model rates')).toBeTruthy()
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
      { id: 'api', label: 'API connection' },
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
    const breakdown = document.getElementById('usage-metric-processed-details')
    for (const provider of providers) {
      expect(screen.getAllByText(provider.label).length).toBeGreaterThan(0)
      expect(breakdown?.textContent).toContain(provider.label)
      expect(
        Array.from(document.querySelectorAll('.source-identity')).some(
          (identity) => identity.getAttribute('title') === provider.label,
        ),
      ).toBe(true)
    }
    expect(breakdown?.textContent).toContain('12.5%')
    expect(breakdown?.querySelectorAll('.source-identity--compact')).toHaveLength(providers.length)
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

function pathStartY(path: Element | null): number {
  const match = /^M [^ ]+ ([^ ]+)/.exec(path?.getAttribute('d') ?? '')
  if (!match?.[1]) throw new Error('chart path has no starting point')
  return Number(match[1])
}
