import type { ProviderId, UsageHistoryDay } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  activityColumns,
  ladderRungs,
  MAX_DAY_COLUMNS,
  providerOrder,
  recentAverage,
  streaks,
  type ActivityColumn,
} from './usage-activity.js'

describe('usage activity', () => {
  it('keeps a column per day up to three months', () => {
    const daily = days([0, 5, 0, 7])
    const { unit, columns } = activityColumns(daily)
    expect(unit).toBe('day')
    expect(columns.map((column) => [column.startDate, column.tokens])).toEqual([
      ['2026-01-01', 0],
      ['2026-01-02', 5],
      ['2026-01-03', 0],
      ['2026-01-04', 7],
    ])
  })

  it('groups longer ranges by week, counted back from the last day', () => {
    const daily = days(Array.from({ length: MAX_DAY_COLUMNS + 3 }, () => 1))
    const { unit, columns } = activityColumns(daily)
    expect(unit).toBe('week')
    expect(columns.at(-1)?.endDate).toBe(daily.at(-1)?.date)
    expect(columns.at(-1)?.tokens).toBe(7)
    // 95 days: 13 full weeks and a first column of the 4 oldest days.
    expect(columns).toHaveLength(14)
    expect(columns[0]?.tokens).toBe(4)
    expect(columns[0]?.startDate).toBe(daily[0]?.date)
    expect(columns.reduce((sum, column) => sum + column.tokens, 0)).toBe(daily.length)
  })

  it('splits a column by provider, largest first', () => {
    const daily = [
      day('2026-01-01', [
        ['codex', 10],
        ['claude-code', 30],
        ['grok', 0],
      ]),
    ]
    const [column] = activityColumns(daily).columns
    expect(column?.providers).toEqual([
      { provider: 'claude-code', tokens: 30 },
      { provider: 'codex', tokens: 10 },
    ])
    expect(column?.sessions).toBe(1)
  })

  it('shares out rungs that always add up to the column height', () => {
    const order: ProviderId[] = ['claude-code', 'codex', 'grok']
    const parts = ladderRungs(
      column([
        ['claude-code', 50],
        ['codex', 30],
        ['grok', 20],
      ]),
      100,
      28,
      order,
    )
    expect(parts.reduce((sum, part) => sum + part.rungs, 0)).toBe(28)
    expect(parts.map((part) => part.provider)).toEqual(order)
    expect(parts.find((part) => part.provider === 'claude-code')?.rungs).toBe(14)
  })

  it('shows any use as at least one rung and nothing as none', () => {
    const order: ProviderId[] = ['codex']
    expect(ladderRungs(column([['codex', 1]]), 1_000_000, 28, order)).toEqual([
      { provider: 'codex', rungs: 1 },
    ])
    expect(ladderRungs(column([]), 1_000_000, 28, order)).toEqual([])
  })

  it('orders providers by their share of the whole range', () => {
    const columns = [
      column([
        ['codex', 10],
        ['grok', 1],
      ]),
      column([['claude-code', 30]]),
    ]
    expect(providerOrder(columns)).toEqual(['claude-code', 'codex', 'grok'])
  })

  it('counts the current streak up to yesterday while today has no use yet', () => {
    expect(streaks(days([1, 0, 1, 1, 1, 0]))).toEqual({
      current: 3,
      longest: 3,
      currentOpen: false,
      longestOpen: false,
    })
    expect(streaks(days([1, 1, 0, 1]))).toEqual({
      current: 1,
      longest: 2,
      currentOpen: false,
      longestOpen: true,
    })
    expect(streaks(days([1, 1, 1]))).toMatchObject({ current: 3, currentOpen: true })
    expect(streaks(days([0, 0]))).toMatchObject({ current: 0, longest: 0 })
  })

  it('averages the last seven days, today included', () => {
    expect(recentAverage(days([1, 2, 3, 4, 5, 6]))).toBeUndefined()
    expect(recentAverage(days([100, 7, 7, 7, 7, 7, 7, 14]))).toBe(8)
  })
})

function days(tokens: number[]): UsageHistoryDay[] {
  return tokens.map((value, index) =>
    day(new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10), [['codex', value]]),
  )
}

function day(date: string, providers: Array<[ProviderId, number]>): UsageHistoryDay {
  const tokens = providers.reduce((sum, [, value]) => sum + value, 0)
  return {
    date,
    sessionCount: tokens > 0 ? 1 : 0,
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      processedTokens: tokens,
      estimatedCostUsd: 0,
      cacheSavingsUsd: 0,
      providerReportedCostUsd: 0,
      providerReportedTokens: 0,
      pricedTokens: 0,
      unpricedTokens: 0,
    },
    providers: providers.map(([provider, value]) => ({
      provider,
      tokens: value,
      estimatedCostUsd: 0,
    })),
  }
}

function column(providers: Array<[ProviderId, number]>): ActivityColumn {
  return {
    startDate: '2026-01-01',
    endDate: '2026-01-01',
    tokens: providers.reduce((sum, [, value]) => sum + value, 0),
    sessions: 1,
    providers: providers.map(([provider, tokens]) => ({ provider, tokens })),
  }
}
