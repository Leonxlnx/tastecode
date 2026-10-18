import { describe, expect, it } from 'vitest'
import {
  formatDateRange,
  formatDays,
  formatLongDate,
  formatMoney,
  formatPercent,
  formatShortDate,
  formatTokens,
} from './usage-format.js'

describe('usage formats', () => {
  it('shortens token counts to three significant figures', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(12_340)).toBe('12.3K')
    expect(formatTokens(1_230_000)).toBe('1.23M')
    expect(formatTokens(1_400_000_000)).toBe('1.4B')
    expect(formatTokens(52_300_000_000)).toBe('52.3B')
    expect(formatTokens(412_000_000_000)).toBe('412B')
  })

  it('formats money, shares and day counts', () => {
    expect(formatMoney(25_348.856)).toBe('$25,348.86')
    expect(formatPercent(0.826)).toBe('82.6%')
    expect(formatDays(1)).toBe('1 day')
    expect(formatDays(17)).toBe('17 days')
    expect(formatDays(7, true)).toBe('7+ days')
    expect(formatDays(1, true)).toBe('1+ days')
  })

  it('reads day keys as calendar days in every time zone', () => {
    expect(formatLongDate('2026-10-17')).toBe('Oct 17, 2026')
    expect(formatShortDate('2026-01-01')).toBe('Jan 1')
    expect(formatDateRange('2026-09-18', '2026-10-17')).toBe('Sep 18 to Oct 17, 2026')
    expect(formatDateRange('2025-12-20', '2026-01-18')).toBe('Dec 20, 2025 to Jan 18, 2026')
    expect(formatDateRange('2026-10-17', '2026-10-17')).toBe('Oct 17, 2026')
  })
})
