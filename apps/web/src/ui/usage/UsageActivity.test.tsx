// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ProviderId, ResultOf } from '@harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageActivity } from './UsageActivity.js'
import { historyResult, usageTotals } from './usage-history.fixture.js'

afterEach(cleanup)

describe('usage page activity', () => {
  it('sets today against the last week and counts the streak', () => {
    render(
      <UsageActivity
        data={week([0, 2_000, 2_000, 0, 1_000, 3_000, 6_000])}
        periodLabel="Last 7 days"
      />,
    )

    const stats = within(screen.getByRole('region', { name: 'Activity' }))
    expect(stats.getByText('Today').nextElementSibling?.textContent).toBe('6K')
    expect(stats.getByText('7-day average 2K')).toBeTruthy()
    expect(stats.getByText('Last 7 days').nextElementSibling?.textContent).toBe('14K')
    expect(stats.getByText('2.8K per active day')).toBeTruthy()
    expect(stats.getByText('Active days').nextElementSibling?.textContent).toBe('5 of 7')
    expect(stats.getByText('Streak').nextElementSibling?.textContent).toBe('3 days')
    expect(stats.getByText('Longest 3 days')).toBeTruthy()
  })

  it('stacks each day by provider and names them in the legend', () => {
    const data = week([1, 1, 1, 1, 1, 1, 0])
    const today = data.daily.at(-1)
    if (!today) throw new Error('fixture has no days')
    today.providers = [
      { provider: 'codex', tokens: 300, estimatedCostUsd: 0 },
      { provider: 'grok', tokens: 100, estimatedCostUsd: 0 },
    ]
    today.totals = usageTotals({ processedTokens: 400 })
    render(<UsageActivity data={data} periodLabel="Last 7 days" />)

    const legend = screen.getByRole('list', { name: 'Legend' })
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Codex', 'Grok', '7-day average'])
    const bar = document.querySelector('.usage-ladder__column[data-today] .usage-ladder__bar')
    expect(
      Array.from(bar?.children ?? []).map((part) => part.getAttribute('data-provider')),
    ).toEqual(['codex', 'grok'])
    expect(document.querySelector('.usage-ladder__average')).not.toBeNull()
  })

  it('steps through the days from the keyboard with a tooltip for each', () => {
    render(
      <UsageActivity
        data={week([0, 2_000, 2_000, 0, 1_000, 3_000, 6_000])}
        periodLabel="Last 7 days"
      />,
    )
    const chart = screen.getByRole('group', { name: /Daily tokens by provider/ })

    fireEvent.keyDown(chart, { key: 'End' })
    let tooltip = screen.getByRole('tooltip')
    expect(chart.getAttribute('aria-describedby')).toBe(tooltip.id)
    expect(tooltip.textContent).toContain('Jan 7, 2026')
    expect(tooltip.textContent).toContain('6K tokens · 1 session')

    fireEvent.keyDown(chart, { key: 'ArrowLeft' })
    tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('Jan 6, 2026')

    fireEvent.keyDown(chart, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('goes by week beyond three months and leaves out the daily average', () => {
    const data = days(Array.from({ length: 120 }, () => 1_000))
    render(<UsageActivity data={data} periodLabel="All time" />)

    expect(screen.getByRole('group', { name: /Weekly tokens by provider/ })).toBeTruthy()
    expect(document.querySelectorAll('.usage-ladder__column')).toHaveLength(18)
    expect(document.querySelector('.usage-ladder__average')).toBeNull()
    expect(screen.queryByText('7-day average')).toBeNull()
  })

  it('says so when the period has no tokens', () => {
    render(<UsageActivity data={week([0, 0, 0, 0, 0, 0, 0])} periodLabel="Last 7 days" />)
    expect(screen.getByText('No token records in this period.')).toBeTruthy()
    expect(screen.getByText('Streak').nextElementSibling?.textContent).toBe('0 days')
  })
})

function week(tokens: number[]): ResultOf<'usage.history'> {
  return days(tokens)
}

function days(tokens: number[], provider: ProviderId = 'codex'): ResultOf<'usage.history'> {
  const result = historyResult('30d')
  result.daily = tokens.map((value, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    sessionCount: value > 0 ? 1 : 0,
    totals: usageTotals({ processedTokens: value }),
    providers: value > 0 ? [{ provider, tokens: value, estimatedCostUsd: 0 }] : [],
  }))
  const total = tokens.reduce((sum, value) => sum + value, 0)
  result.totals = usageTotals({ processedTokens: total })
  result.activeDays = tokens.filter((value) => value > 0).length
  return result
}
