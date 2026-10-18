import type { ProviderId, ResultOf } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import type { UsageSummaryState } from '../../usage-summary-state.js'
import { historyResult, usageTotals } from './usage-history.fixture.js'
import {
  dayText,
  deriveSheets,
  formatValue,
  indexedAgo,
  limitAlert,
  listText,
  resetText,
  sheetLimits,
  type SheetLimits,
} from './usage-sheets.js'

type History = ResultOf<'usage.history'>

/** A history whose days carry the given tokens per provider, one array entry per day. */
function historyOf(days: Partial<Record<ProviderId, number[]>>): History {
  const result = historyResult('30d')
  const length = Math.max(...Object.values(days).map((tokens) => tokens.length))
  result.daily = Array.from({ length }, (_, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, '0')}`,
    sessionCount: 1,
    totals: usageTotals({}),
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
    const { sheets, top, capped } = deriveSheets(
      historyOf({ codex: [0, 100, 300], 'claude-code': [500, 0, 600] }),
      NO_LIMITS,
    )

    expect(sheets.map((sheet) => sheet.provider)).toEqual(['claude-code', 'codex'])
    expect(sheets[1]?.daily.map((day) => day.tokens)).toEqual([0, 100, 300])
    expect(sheets[1]?.activeDays).toBe(2)
    expect(top).toBe(600)
    expect(capped).toBe(false)
  })

  it('caps the scale at 1.5 times the 98th percentile when one day towers over the rest', () => {
    const busy = Array.from({ length: 60 }, () => 100)
    busy[10] = 10_000
    const { top, capped } = deriveSheets(historyOf({ codex: busy }), NO_LIMITS)

    expect(capped).toBe(true)
    expect(top).toBe(150)
  })

  it('marks a provider too small to rise on the scale as quiet', () => {
    const { sheets } = deriveSheets(
      historyOf({ codex: [1_000, 900, 800], grok: [0, 30, 0] }),
      NO_LIMITS,
    )

    expect(sheets.find((sheet) => sheet.provider === 'grok')?.quiet).toBe(true)
    expect(sheets.find((sheet) => sheet.provider === 'codex')?.quiet).toBe(false)
  })

  it('collapses a provider with limits but no sessions and sorts it last', () => {
    const limits = new Map<ProviderId, SheetLimits>([
      ['grok', sheetLimits(ready('grok', [{ label: 'Weekly', usedPercent: 20 }]))!],
    ])
    const { sheets } = deriveSheets(historyOf({ codex: [5, 0, 0] }), limits)

    expect(sheets.map((sheet) => [sheet.provider, sheet.empty])).toEqual([
      ['codex', false],
      ['grok', true],
    ])
    expect(sheets[1]?.limits.rows).toEqual([
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

    expect(sheetLimits(unavailable)).toBeUndefined()
    expect(sheetLimits(failed)).toEqual({
      rows: [],
      status: { label: 'Unavailable', detail: 'Plan limits couldn’t be loaded. offline' },
      retryable: true,
    })
  })
})

describe('limit alert', () => {
  it('names reached limits first, then those running low, with their resets', () => {
    const limits = new Map<ProviderId, SheetLimits>([
      ['claude-code', sheetLimits(ready('claude-code', [{ label: 'Session', usedPercent: 90 }]))!],
      ['grok', sheetLimits(ready('grok', [{ label: 'Weekly', usedPercent: 100 }]))!],
      ['codex', sheetLimits(ready('codex', [{ label: '30 days', usedPercent: 40 }]))!],
    ])
    const { sheets } = deriveSheets(historyOf({ 'claude-code': [10], grok: [1] }), limits)

    expect(limitAlert(sheets, NOW)).toBe(
      'Grok weekly limit reached, resets in 3h. Claude Code session limit at 10% left, resets in 3h.',
    )
  })

  it('says nothing while every limit has room', () => {
    const limits = new Map<ProviderId, SheetLimits>([
      ['codex', sheetLimits(ready('codex', [{ label: 'Weekly', usedPercent: 84 }]))!],
    ])
    expect(limitAlert(deriveSheets(undefined, limits).sheets, NOW)).toBeUndefined()
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
