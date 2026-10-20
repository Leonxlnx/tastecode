import type { ProviderId, ResultOf } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import type { UsageSummaryState } from '../../usage-summary-state.js'
import { historyResult, usageTotals } from './usage-history.fixture.js'
import {
  axisTicks,
  dayText,
  deriveSheets,
  formatValue,
  indexedAgo,
  limitAlert,
  listText,
  markInk,
  providerShares,
  rangeText,
  resetText,
  shareText,
  sheetLimits,
  type ProviderSheet,
  type SheetLimits,
} from './usage-sheets.js'

type History = ResultOf<'usage.history'>

/** The day key `index` days after Aug 1, 2026. */
function dateAt(index: number): string {
  const date = new Date(2026, 7, 1 + index, 12)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** A history whose days carry the given tokens per provider, one array entry per day. */
function historyOf(days: Partial<Record<ProviderId, number[]>>): History {
  const result = historyResult('30d')
  const length = Math.max(...Object.values(days).map((tokens) => tokens.length))
  result.daily = Array.from({ length }, (_, index) => ({
    date: dateAt(index),
    sessionCount: 1,
    totals: usageTotals({
      processedTokens: Object.values(days).reduce((sum, tokens) => sum + (tokens[index] ?? 0), 0),
    }),
    providers: Object.entries(days)
      .filter(([, tokens]) => (tokens[index] ?? 0) > 0)
      .map(([provider, tokens]) => ({
        provider: provider as ProviderId,
        tokens: tokens[index] ?? 0,
        estimatedCostUsd: (tokens[index] ?? 0) / 1_000,
      })),
  }))
  result.providers = Object.entries(days).map(([provider, tokens]) => {
    const sum = tokens.reduce((total, value) => total + value, 0)
    return {
      provider: provider as ProviderId,
      sessionCount: tokens.filter((value) => value > 0).length,
      totals: usageTotals({ processedTokens: sum, estimatedCostUsd: sum / 1_000 }),
    }
  })
  result.models = []
  return result
}

const NO_LIMITS = new Map<ProviderId, SheetLimits>()
const NOW = Date.UTC(2026, 9, 18, 10)

function ready(provider: ProviderId, limits: Array<{ label: string; usedPercent: number }>) {
  return {
    status: 'ready',
    provider,
    summary: {
      provider,
      limits: limits.map((limit) => ({ ...limit, resetsAt: NOW + 3 * 3_600_000 })),
    },
  } as unknown as UsageSummaryState
}

describe('provider sheets', () => {
  it('orders sheets by value and keeps each day on the shared range', () => {
    const { sheets } = deriveSheets(
      historyOf({ codex: [0, 100, 300], 'claude-code': [500, 0, 600] }),
      NO_LIMITS,
    )

    expect(sheets.map((sheet) => sheet.provider)).toEqual(['claude-code', 'codex'])
    expect(sheets[1]?.slots.map((slot) => slot.tokens)).toEqual([0, 100, 300])
    expect(sheets[1]?.activeDays).toBe(2)
  })

  it('draws a period longer than a quarter a week to a slot, the last ending today', () => {
    const tokens = Array.from({ length: 100 }, (_, index) => index + 1)
    const { slots, span, sheets } = deriveSheets(historyOf({ codex: tokens }), NO_LIMITS)

    expect(span).toBe(7)
    expect(slots).toHaveLength(15)
    expect(slots[0]).toMatchObject({ start: dateAt(0), end: dateAt(1), tokens: 3, activeDays: 2 })
    expect(slots[0]?.sessions).toBeUndefined()
    expect(slots.at(-1)).toMatchObject({ start: dateAt(93), end: dateAt(99), tokens: 679 })
    expect(sheets[0]?.slots.at(-1)?.tokens).toBe(679)
    expect(sheets[0]?.activeDays).toBe(100)
  })

  it('keeps a quarter a day to a slot with its sessions', () => {
    const { slots, span } = deriveSheets(historyOf({ codex: [5, 0, 7] }), NO_LIMITS)

    expect(span).toBe(1)
    expect(slots.map((slot) => [slot.start, slot.tokens, slot.sessions])).toEqual([
      [dateAt(0), 5, 1],
      [dateAt(1), 0, 1],
      [dateAt(2), 7, 1],
    ])
  })

  it('collapses a provider with limits but no sessions and sorts it last', () => {
    const limits = new Map<ProviderId, SheetLimits>([
      ['grok', sheetLimits(ready('grok', [{ label: 'Weekly', usedPercent: 20 }]), NOW)!],
    ])
    const { sheets } = deriveSheets(historyOf({ codex: [5, 0, 0] }), limits)

    expect(sheets.map((sheet) => [sheet.provider, sheet.empty])).toEqual([
      ['codex', false],
      ['grok', true],
    ])
    expect(sheets[1]?.accounts[0]?.limits.rows).toEqual([
      { label: 'Weekly', left: 80, state: 'ok', resetsAt: NOW + 3 * 3_600_000 },
    ])
  })

  it('lists models by value, then tokens', () => {
    const history = historyOf({ codex: [10] })
    history.models = [
      { model: 'small', value: 1, tokens: 9 },
      { model: 'big', value: 5, tokens: 1 },
      { model: 'free', value: 0, tokens: 7 },
      { model: 'free-more', value: 0, tokens: 8 },
    ].map(({ model, value, tokens }) => ({
      provider: 'codex',
      model,
      sessionCount: 1,
      pricing: 'exact',
      totals: usageTotals({ processedTokens: tokens, estimatedCostUsd: value }),
    }))

    const [sheet] = deriveSheets(history, NO_LIMITS).sheets
    expect(sheet?.models.map((model) => model.model)).toEqual(['big', 'small', 'free-more', 'free'])
  })

  it('leaves out a source without plan limits and keeps the status of a failed one', () => {
    const unavailable = {
      status: 'ready',
      provider: 'codex',
      summary: {
        provider: 'codex',
        limits: [],
        limitSource: { provider: 'codex', status: 'unavailable' },
      },
    } as unknown as UsageSummaryState
    const failed = {
      status: 'error',
      provider: 'grok',
      message: 'offline',
    } as unknown as UsageSummaryState

    expect(sheetLimits(unavailable, NOW)).toBeUndefined()
    const unread = {
      status: 'ready',
      provider: 'grok',
      summary: {
        provider: 'grok',
        limits: [],
        limitSource: { provider: 'grok', status: 'unavailable', reason: 'failed', error: 'down' },
      },
    } as unknown as UsageSummaryState
    // A source the server failed to read stays, with its reason and a Retry.
    expect(sheetLimits(unread, NOW)).toEqual({
      rows: [],
      status: { label: 'Unavailable', detail: 'Plan limits couldn’t be loaded. down' },
      retryable: true,
    })
    const none = {
      status: 'ready',
      provider: 'codex',
      summary: {
        provider: 'codex',
        limits: [],
        limitSource: { provider: 'codex', status: 'ready', limits: [] },
      },
    } as unknown as UsageSummaryState
    expect(sheetLimits(none, NOW)).toEqual({ rows: [], retryable: false })
    expect(sheetLimits(failed, NOW)).toEqual({
      rows: [],
      status: { label: 'Unavailable', detail: 'Plan limits couldn’t be loaded. offline' },
      retryable: true,
    })
    // While the automatic retries run there is no Retry to press.
    const retrying = {
      ...failed,
      retry: { attempt: 1, of: 3, message: 'offline' },
    } as unknown as UsageSummaryState
    expect(sheetLimits(retrying, NOW)).toEqual({
      rows: [],
      status: {
        label: 'Retrying…',
        detail: 'Plan limits couldn’t be loaded. offline Trying again, 1 of 3.',
      },
      retryable: false,
    })
  })
})

describe('axis ticks', () => {
  const slotsOf = (count: number, span: 1 | 7) =>
    Array.from({ length: count }, (_, index) => ({
      start: dateAt(index * span),
      end: dateAt(index * span + span - 1),
      tokens: 0,
      value: 0,
      activeDays: 0,
    }))

  it('labels every weekday on a week, Mondays on a month and month starts beyond', () => {
    // Aug 1, 2026 is a Saturday.
    expect(axisTicks(slotsOf(7, 1), 1).map((tick) => tick.label)).toEqual([
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
    ])
    expect(axisTicks(slotsOf(30, 1), 1)).toEqual([
      { index: 2, label: 'Aug 3' },
      { index: 9, label: 'Aug 10' },
      { index: 16, label: 'Aug 17' },
      { index: 23, label: 'Aug 24' },
    ])
    expect(axisTicks(slotsOf(90, 1), 1)).toEqual([
      { index: 31, label: 'Sep' },
      { index: 61, label: 'Oct' },
    ])
  })

  it('puts a month on the week that holds its first day, and the year on January', () => {
    const ticks = axisTicks(slotsOf(30, 7), 7)

    expect(ticks.slice(0, 5)).toEqual([
      { index: 4, label: 'Sep' },
      { index: 8, label: 'Oct' },
      { index: 13, label: 'Nov' },
      { index: 17, label: 'Dec' },
      { index: 21, label: '2027' },
    ])
  })
})

describe('accounts', () => {
  const label = (_provider: ProviderId, accountId: string | undefined) =>
    accountId === 'work-1a2b3c' ? 'Work' : accountId === 'alt-9f9f9f' ? 'Alt' : 'Personal'

  it('sums a split provider into one sheet and lists its accounts, the default first', () => {
    const history = historyOf({ codex: [30, 70] })
    const [whole] = history.providers
    history.providers = [
      {
        ...whole!,
        accountId: 'work-1a2b3c',
        sessionCount: 2,
        totals: usageTotals({ processedTokens: 70, estimatedCostUsd: 0.07 }),
      },
      {
        ...whole!,
        accountId: 'default',
        sessionCount: 1,
        totals: usageTotals({ processedTokens: 30, estimatedCostUsd: 0.03 }),
      },
    ]
    const limits = new Map([
      [
        'codex/alt-9f9f9f',
        sheetLimits(ready('codex', [{ label: 'Weekly', usedPercent: 10 }]), NOW)!,
      ],
    ])
    const [sheet] = deriveSheets(history, limits, label).sheets

    expect(sheet).toMatchObject({ provider: 'codex', sessions: 3, tokens: 100 })
    expect(
      sheet!.accounts.map(({ key, accountId, label, tokens }) => ({
        key,
        accountId,
        label,
        tokens,
      })),
    ).toEqual([
      { key: 'codex', accountId: undefined, label: 'Personal', tokens: 30 },
      { key: 'codex/alt-9f9f9f', accountId: 'alt-9f9f9f', label: 'Alt', tokens: 0 },
      { key: 'codex/work-1a2b3c', accountId: 'work-1a2b3c', label: 'Work', tokens: 70 },
    ])
    expect(sheet!.accounts[1]!.limits.rows).toHaveLength(1)
  })

  it('lists a further account that reports limits beside the default one', () => {
    const limits = new Map([
      ['codex', sheetLimits(ready('codex', [{ label: 'Weekly', usedPercent: 20 }]), NOW)!],
      [
        'codex/work-1a2b3c',
        sheetLimits(ready('codex', [{ label: 'Weekly', usedPercent: 50 }]), NOW)!,
      ],
    ])
    const [sheet] = deriveSheets(historyOf({ codex: [10] }), limits, label).sheets

    expect(sheet!.accounts.map((account) => [account.label, account.tokens])).toEqual([
      ['Personal', 10],
      ['Work', 0],
    ])
  })

  it('reads a provider on its default account alone as the provider itself', () => {
    const limits = new Map([
      ['codex', sheetLimits(ready('codex', [{ label: 'Weekly', usedPercent: 20 }]), NOW)!],
    ])
    const [sheet] = deriveSheets(historyOf({ codex: [10] }), limits, label).sheets

    expect(sheet!.accounts).toEqual([
      expect.objectContaining({ key: 'codex', label: 'Codex', tokens: 10 }),
    ])
    expect(sheet!.accounts[0]!.accountId).toBeUndefined()
  })

  it('names the account in a limit alert once a provider has more than one', () => {
    const limits = sheetLimits(ready('codex', [{ label: 'Weekly', usedPercent: 95 }]), NOW)!
    const [sheet] = deriveSheets(historyOf({ codex: [10] }), new Map([['codex', limits]])).sheets
    const split: ProviderSheet = {
      ...sheet!,
      accounts: [
        { ...sheet!.accounts[0]!, key: 'work', label: 'Work' },
        {
          ...sheet!.accounts[0]!,
          key: 'home',
          label: 'Home',
          limits: { rows: [], retryable: false },
        },
      ],
    }

    expect(limitAlert([sheet!], NOW)).toBe('Codex weekly limit at 5% left, resets in 3h.')
    expect(limitAlert([split], NOW)).toBe('Codex Work weekly limit at 5% left, resets in 3h.')
  })
})

describe('limit alert', () => {
  it('names reached limits first, then those running low, with their resets', () => {
    const limits = new Map<ProviderId, SheetLimits>([
      [
        'claude-code',
        sheetLimits(ready('claude-code', [{ label: 'Session', usedPercent: 90 }]), NOW)!,
      ],
      ['grok', sheetLimits(ready('grok', [{ label: 'Weekly', usedPercent: 100 }]), NOW)!],
      ['codex', sheetLimits(ready('codex', [{ label: '30 days', usedPercent: 40 }]), NOW)!],
    ])
    const { sheets } = deriveSheets(historyOf({ 'claude-code': [10], grok: [1] }), limits)

    expect(limitAlert(sheets, NOW)).toBe(
      'Grok weekly limit reached, resets in 3h. Claude Code session limit at 10% left, resets in 3h.',
    )
  })

  it('says nothing while every limit has room', () => {
    const limits = new Map<ProviderId, SheetLimits>([
      ['codex', sheetLimits(ready('codex', [{ label: 'Weekly', usedPercent: 84 }]), NOW)!],
    ])
    expect(limitAlert(deriveSheets(undefined, limits).sheets, NOW)).toBeUndefined()
  })
})

describe('provider colours and shares', () => {
  it('splits the period between the providers with tokens, in sheet order', () => {
    const { sheets } = deriveSheets(
      historyOf({ codex: [100, 100], 'claude-code': [600, 0], grok: [0, 0] }),
      NO_LIMITS,
    )

    expect(providerShares(sheets)).toEqual([
      { provider: 'claude-code', name: 'Claude Code', share: 0.75 },
      { provider: 'codex', name: 'Codex', share: 0.25 },
    ])
    expect(providerShares([])).toEqual([])
  })

  it('reads a share as a whole percent, a tenth under one, and a floor under that', () => {
    expect(shareText(0.806)).toBe('81%')
    expect(shareText(0.0024)).toBe('0.2%')
    expect(shareText(0.0004)).toBe('under 0.1%')
  })

  it('colours a provider by its brand mark, grey for a mark without a token', () => {
    expect(markInk('anthropic')).toBe('var(--mark-anthropic, var(--text-2))')
  })
})

describe('usage words', () => {
  it('reads resets as a countdown, a weekday or a date', () => {
    expect(resetText(NOW - 1, NOW)?.label).toBe('resets now')
    expect(resetText(NOW + 42 * 60_000, NOW)?.label).toBe('resets in 42m')
    expect(resetText(NOW + 3 * 3_600_000 + 53 * 60_000, NOW)?.label).toBe('resets in 3h 53m')
    expect(resetText(NOW + 2 * 86_400_000, NOW)?.label).toMatch(/^resets [A-Z][a-z]{2} \d/)
    expect(resetText(NOW + 30 * 86_400_000, NOW)?.label).toBe('resets Nov 17')
    expect(resetText(Number.NaN, NOW)).toBeUndefined()
  })

  it('reads a week as a range, naming the year once and only off the reference year', () => {
    expect(rangeText('2026-10-06', '2026-10-12', 2026)).toBe('Oct 6 – 12')
    expect(rangeText('2026-09-29', '2026-10-05', 2026)).toBe('Sep 29 – Oct 5')
    expect(rangeText('2025-12-29', '2026-01-04', 2026)).toBe('Dec 29, 2025 – Jan 4')
    expect(rangeText('2025-10-06', '2025-10-12', 2026)).toBe('Oct 6 – 12, 2025')
    expect(rangeText('2026-10-12', '2026-10-12', 2026)).toBe('Mon, Oct 12')
  })

  it('formats values, days, ages and lists', () => {
    expect(formatValue(0.003)).toBe('under $0.01')
    expect(formatValue(0)).toBe('$0.00')
    expect(formatValue(13_473.15)).toBe('$13,473.15')
    expect(dayText('2026-10-03', 2026)).toBe('Oct 3')
    expect(dayText('2026-10-03', 2026, true)).toBe('Sat, Oct 3')
    expect(dayText('2025-03-04', 2026)).toBe('Mar 4, 2025')
    expect(indexedAgo(NOW - 20_000, NOW)).toBe('just now')
    expect(indexedAgo(NOW - 5 * 60_000, NOW)).toBe('5 min ago')
    expect(indexedAgo(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago')
    expect(indexedAgo(NOW - 50 * 3_600_000, NOW)).toBe('2 days ago')
    expect(listText(['Codex'])).toBe('Codex')
    expect(listText(['Claude Code', 'Codex', 'Grok'])).toBe('Claude Code, Codex and Grok')
  })
})
