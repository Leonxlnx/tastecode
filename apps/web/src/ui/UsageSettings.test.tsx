// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  ProviderLimit,
  ProviderLimitSource,
  ResultOf,
  UsageHistoryRange,
} from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../test-transport.js'
import type { Transport } from '../transport.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import { UsageSettings } from './UsageSettings.js'
import { historyResult, usageTotals } from './usage/usage-history.fixture.js'
import type { PlanLimitsSource } from './usage/usage-sheets.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function advance(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

const NOW = Date.UTC(2026, 7, 8, 12)

/** Matches an element by its whole text, across the figures set in bold inside it. */
function wholeText(text: string) {
  return (_content: string, element: Element | null) =>
    element?.textContent === text &&
    [...element.children].every((child) => child.textContent !== text)
}

function transportOf(result: (range: UsageHistoryRange) => ResultOf<'usage.history'>) {
  const request = vi.fn(
    async (_method: string, params: { range: UsageHistoryRange; refresh?: boolean }) =>
      result(params.range),
  )
  return { request, transport: { request } as unknown as Transport }
}

function limitsOf(states: UsageSummaryState[]) {
  return {
    snapshot: () => states,
    subscribe: () => () => {},
    show: vi.fn<PlanLimitsSource['show']>(() => () => {}),
    refresh: vi.fn<PlanLimitsSource['refresh']>(),
  } satisfies PlanLimitsSource
}

function ready(
  provider: ProviderLimitSource['provider'],
  limits: ProviderLimit[],
): UsageSummaryState {
  const none = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
  return {
    status: 'ready',
    provider,
    summary: {
      session: none,
      today: none,
      limitSource: { provider, status: 'ready', limits },
      limits,
    },
  }
}

/** Three days of Codex use with four models, the busiest on the last day. */
function codexHistory(range: UsageHistoryRange): ResultOf<'usage.history'> {
  const result = historyResult(range)
  result.startDate = '2026-08-06'
  result.daily = [
    ['2026-08-06', 0, 0, 0],
    ['2026-08-07', 400_000, 3.21, 1],
    ['2026-08-08', 830_000, 9.13, 3],
  ].map(([date, tokens, value, sessions]) => ({
    date: date as string,
    sessionCount: sessions as number,
    totals: usageTotals({ processedTokens: tokens as number, estimatedCostUsd: value as number }),
    providers:
      (tokens as number) > 0
        ? [{ provider: 'codex', tokens: tokens as number, estimatedCostUsd: value as number }]
        : [],
  }))
  result.activeDays = 2
  result.models = ['gpt-a', 'gpt-b', 'gpt-c', 'gpt-d'].map((model, index) => ({
    provider: 'codex',
    model,
    sessionCount: 1,
    pricing: index === 1 ? 'family' : index === 3 ? 'unpriced' : 'exact',
    totals: usageTotals({ processedTokens: 1_000 * (4 - index), estimatedCostUsd: 4 - index }),
  }))
  return result
}

describe('usage settings', () => {
  it('loads local history, changes period, and explicitly requests a rescan', async () => {
    const { request, transport } = transportOf(historyResult)
    render(<UsageSettings transport={transport} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Usage' })).toBeTruthy()
    expect(screen.getByRole('status', { name: 'Reading the usage index' })).toBeTruthy()
    expect(await screen.findByText(wholeText('4 sessions on 1 of 1 day'))).toBeTruthy()
    const totals = document.querySelector('.usage-page__totals')
    expect([...(totals?.children ?? [])].map((part) => part.textContent)).toEqual([
      '1.23M tokens',
      '$12.34 at API prices',
      '4 sessions on 1 of 1 day',
    ])
    expect(screen.getByRole('img', { name: 'Tokens by provider: Codex 100%' })).toBeTruthy()
    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(within(codex).getByText('1.23M tokens')).toBeTruthy()
    expect(within(codex).getByRole('columnheader', { name: 'Tokens' })).toBeTruthy()
    expect(request).toHaveBeenNthCalledWith(1, 'usage.history', { range: '30d' })
    const period = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Period' })
    expect(period.value).toBe('30d')

    fireEvent.change(period, { target: { value: '7d' } })
    await waitFor(() => {
      expect(request).toHaveBeenNthCalledWith(2, 'usage.history', { range: '7d' })
    })
    expect(period.closest('label')?.firstElementChild?.textContent).toBe('Last 7 days')

    fireEvent.click(screen.getByRole('button', { name: 'Check for new usage' }))
    await waitFor(() => {
      expect(request).toHaveBeenNthCalledWith(3, 'usage.history', { range: '7d', refresh: true })
    })
  })

  it('draws one sheet per provider with its value, models and the close', async () => {
    const result = codexHistory('30d')
    result.sources.push({ provider: 'grok', available: false, sessionCount: 0 })
    result.warnings = ['Some token records use models without a known public API price.']
    vi.useFakeTimers({ now: result.generatedAt + 5 * 60_000, toFake: ['Date'] })
    const { transport } = transportOf(() => result)
    render(<UsageSettings transport={transport} />)

    const codex = await screen.findByRole('region', { name: 'Codex' })
    const totals = codex.querySelector('.usage-sheet__totals')
    expect([...(totals?.children ?? [])].map((part) => part.textContent)).toEqual([
      '4 sessions',
      '1.23M tokens',
      '$12.34',
    ])
    expect(within(codex).getByText('≈ $3.00').getAttribute('title')).toBe(
      'Priced from a sibling model, so approximate',
    )
    expect(within(codex).queryByText('gpt-d')).toBeNull()
    fireEvent.click(within(codex).getByRole('button', { name: '1 more model' }))
    expect(within(codex).getByText('not priced')).toBeTruthy()
    expect(within(codex).getByRole('button', { name: 'Fewer models' })).toBeTruthy()
    expect(
      within(within(codex).getByRole('group', { name: 'Plan limits' })).getByText('None reported'),
    ).toBeTruthy()

    expect(
      screen.getByText(
        wholeText('Caching saved $4.56. Without it, these tokens would come to $16.90.'),
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(/Some token records use models without a known public API price\./),
    ).toBeTruthy()
    expect(screen.getByText('Indexed 5 min ago from 4 files in the Codex histories.')).toBeTruthy()
  })

  it('reads one day of a chart in a tooltip, by keyboard', async () => {
    const { transport } = transportOf(codexHistory)
    render(<UsageSettings transport={transport} />)
    const codex = await screen.findByRole('region', { name: 'Codex' })
    const chart = within(codex).getByRole('img', { name: /Codex tokens a day/ })

    fireEvent.focus(chart)
    const tip = () => codex.querySelector('.usage-chart__tip')
    expect([...(tip()?.children ?? [])].map((line) => line.textContent)).toEqual([
      'Sat, Aug 8',
      '830K tokens',
      '$9.13',
    ])

    fireEvent.keyDown(chart, { key: 'ArrowLeft', shiftKey: true })
    expect([...(tip()?.children ?? [])].map((line) => line.textContent)).toEqual([
      'Thu, Aug 6',
      'No use',
    ])

    fireEvent.keyDown(chart, { key: 'Escape' })
    expect(tip()).toBeNull()
  })

  it('reads a day whose tokens have no API price as not priced, not as free', async () => {
    const result = codexHistory('30d')
    const last = result.daily.at(-1)?.providers[0]
    if (last) last.estimatedCostUsd = 0
    const { transport } = transportOf(() => result)
    render(<UsageSettings transport={transport} />)
    const codex = await screen.findByRole('region', { name: 'Codex' })

    fireEvent.focus(within(codex).getByRole('img', { name: /Codex tokens a day/ }))
    const tip = codex.querySelector('.usage-chart__tip')
    expect([...(tip?.children ?? [])].map((line) => line.textContent)).toEqual([
      'Sat, Aug 8',
      '830K tokens',
      'not priced',
    ])
  })

  it('names a reached and a low limit under the totals and keeps them in their sheets', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const limits = limitsOf([
      ready('codex', [{ label: 'Session', usedPercent: 90, resetsAt: NOW + 42 * 60_000 }]),
      ready('grok', [{ label: 'Weekly', usedPercent: 100, resetsAt: NOW + 3 * 3_600_000 }]),
    ])
    const { transport } = transportOf(historyResult)
    render(<UsageSettings transport={transport} limits={limits} />)

    expect(
      await screen.findByText(
        'Grok weekly limit reached, resets in 3h. Codex session limit at 10% left, resets in 42m.',
      ),
    ).toBeTruthy()
    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(within(codex).getByText('10% left')).toBeTruthy()
    expect(
      within(codex)
        .getByRole('progressbar', { name: 'Codex Session left' })
        .getAttribute('aria-valuenow'),
    ).toBe('10')
    const grok = screen.getByRole('region', { name: 'Grok' })
    expect(within(grok).getByText('Reached')).toBeTruthy()
  })

  it('collapses a provider without sessions to its name and its limits', async () => {
    const limits = limitsOf([
      ready('grok', [{ label: 'Weekly', usedPercent: 20 }]),
      ready('claude-code', [{ label: 'Credits', usedPercent: 0, valueLabel: '$209.60' }]),
    ])
    const { transport } = transportOf(historyResult)
    render(<UsageSettings transport={transport} limits={limits} />)

    const grok = await screen.findByRole('region', { name: 'Grok' })
    expect(within(grok).getByText('No sessions in the last 30 days')).toBeTruthy()
    expect(within(grok).getByText('80% left')).toBeTruthy()
    expect(within(grok).queryByRole('img')).toBeNull()
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).getByText('$209.60')).toBeTruthy()
    expect(within(claude).queryByRole('progressbar')).toBeNull()
    const sheets = [...document.querySelectorAll('.usage-sheet')]
    expect(sheets.map((sheet) => sheet.getAttribute('aria-label'))).toEqual([
      'Codex',
      'Grok',
      'Claude Code',
    ])
  })

  it('lists each account of a provider under its sheet, named by its label', async () => {
    const history = codexHistory('30d')
    history.providers = [
      {
        provider: 'codex',
        accountId: 'work-1a2b3c',
        sessionCount: 3,
        totals: usageTotals({ processedTokens: 830_000, estimatedCostUsd: 9.13 }),
      },
      {
        provider: 'codex',
        accountId: 'default',
        sessionCount: 1,
        totals: usageTotals({ processedTokens: 400_000, estimatedCostUsd: 3.21 }),
      },
    ]
    const limits = limitsOf([
      ready('codex', [{ label: '5 hours', usedPercent: 25 }]),
      { status: 'error', provider: 'codex', accountId: 'work-1a2b3c', message: 'offline' },
    ])
    const transport = new TestTransport((method) => {
      if (method === 'usage.history') return history
      if (method === 'accounts.list') {
        return {
          accounts: [
            { id: 'default', provider: 'codex', label: 'Personal', managed: false },
            {
              id: 'work-1a2b3c',
              provider: 'codex',
              label: 'Work',
              home: 'C:\\TasteCode\\accounts\\codex\\work-1a2b3c',
              managed: true,
            },
          ],
          active: {},
        }
      }
      throw new Error(`unexpected ${method}`)
    })
    render(<UsageSettings transport={transport} limits={limits} />)

    const codex = await screen.findByRole('region', { name: 'Codex' })
    // The sheet is the provider's whole usage, every account summed.
    expect(within(codex).getByText('1.23M tokens')).toBeTruthy()
    const accounts = within(codex).getByRole('group', { name: 'Accounts' })
    await waitFor(() =>
      expect(
        [...accounts.querySelectorAll('.usage-account__name')].map((name) => name.textContent),
      ).toEqual(['Personal', 'Work']),
    )
    expect(
      within(accounts)
        .getByRole('progressbar', { name: 'Codex Personal 5 hours left' })
        .getAttribute('aria-valuenow'),
    ).toBe('75')
    expect(within(codex).queryByText(/work-1a2b3c/)).toBeNull()
    // Work's own limits could not be read; Retry asks for Work alone.
    fireEvent.click(within(accounts).getByRole('button', { name: 'Retry' }))
    expect(limits.refresh).toHaveBeenCalledWith('codex', 'retry', 'work-1a2b3c')
  })

  it('offers a retry for plan limits that could not be read', async () => {
    const limits = limitsOf([{ status: 'error', provider: 'grok', message: 'offline' }])
    const { transport } = transportOf(historyResult)
    render(<UsageSettings transport={transport} limits={limits} />)

    const grok = await screen.findByRole('region', { name: 'Grok' })
    expect(within(grok).getByText('Unavailable')).toBeTruthy()
    fireEvent.click(within(grok).getByRole('button', { name: 'Retry' }))
    expect(limits.refresh).toHaveBeenCalledWith('grok', 'retry')
    // Opening the page asks the server to read sources it reads only on view.
    expect(limits.show).toHaveBeenCalledTimes(1)
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

    // A refresh of an existing index that is over by the next read is never
    // announced: the notice would only push the page down and back up.
    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
    expect(screen.getByText(wholeText('4 sessions on 1 of 1 day'))).toBeTruthy()
    await advance(1_999)
    expect(request).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
  })

  it('announces a refresh that a later read still finds running', async () => {
    vi.useFakeTimers()
    let call = 0
    const request = vi.fn(async () => {
      const result = historyResult('30d')
      call += 1
      if (call < 3) result.scan = { status: 'scanning', filesProcessed: call * 10, filesTotal: 100 }
      return result
    })
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
    await advance(2_000)
    expect(screen.getByText(/Indexing local usage · 20 of 100 files/)).toBeTruthy()
    await advance(3_000)
    expect(request).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
  })

  it('says at once that a first index is running', async () => {
    vi.useFakeTimers()
    const result = historyResult('30d')
    result.generatedAt = 0
    result.scan = { status: 'scanning', filesProcessed: 0, filesTotal: 0 }
    const transport = { request: vi.fn(async () => result) } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.getByText(/Indexing local usage · finding sessions/)).toBeTruthy()
  })

  it('keeps polling a background scan after a transient refresh failure', async () => {
    vi.useFakeTimers()
    let call = 0
    const request = vi.fn(async () => {
      const result = historyResult('30d')
      if (call === 0) {
        // A first index, which says so at once.
        result.generatedAt = 0
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

    expect(screen.getByText(/Indexing local usage/)).toBeTruthy()
    await advance(2_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/The last refresh failed/).getAttribute('title')).toBe(
      'Temporary connection failure',
    )
    await advance(3_000)
    expect(request).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
  })

  it('cancels a pending scan poll when the page unmounts', async () => {
    vi.useFakeTimers()
    const result = historyResult('30d')
    result.generatedAt = 0
    result.scan = { status: 'scanning', filesProcessed: 10, filesTotal: 100 }
    const request = vi.fn(async () => result)
    const transport = { request } as unknown as Transport
    const view = render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.getByText(/Indexing local usage/)).toBeTruthy()
    view.unmount()
    await advance(30_000)

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('says a refresh failed and offers to try again', async () => {
    let fail = false
    const request = vi.fn(async (_method: string, params: { range: UsageHistoryRange }) => {
      if (fail) throw new Error('The index could not be opened.')
      return historyResult(params.range)
    })
    render(<UsageSettings transport={{ request } as unknown as Transport} />)
    await screen.findByText(wholeText('4 sessions on 1 of 1 day'))

    fail = true
    fireEvent.click(screen.getByRole('button', { name: 'Check for new usage' }))
    const notice = await screen.findByText(
      /The last refresh failed, so the figures are from the one before\./,
    )
    expect(notice.getAttribute('title')).toBe('The index could not be opened.')
    expect(screen.getByText(wholeText('4 sessions on 1 of 1 day'))).toBeTruthy()

    fail = false
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }))
    await waitFor(() => {
      expect(screen.queryByText(/The last refresh failed/)).toBeNull()
    })
  })

  it('offers another try when the first read fails', async () => {
    let fail = true
    const request = vi.fn(async (_method: string, params: { range: UsageHistoryRange }) => {
      if (fail) throw new Error('The index could not be opened.')
      return historyResult(params.range)
    })
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The index could not be opened.')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(wholeText('4 sessions on 1 of 1 day'))).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
