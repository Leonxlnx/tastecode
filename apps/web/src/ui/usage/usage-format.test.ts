import { describe, expect, it } from 'vitest'
import { dateFromKey, formatMoney, formatTokens, resetText } from './usage-format.js'

const NOW = Date.UTC(2026, 9, 18, 10)

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

  it('formats money', () => {
    expect(formatMoney(25_348.856)).toBe('$25,348.86')
  })

  it('reads day keys as calendar days in every time zone', () => {
    const date = dateFromKey('2026-10-17')
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 9, 17])
  })

  it('reads resets as a countdown, a weekday or a date', () => {
    expect(resetText(NOW - 1, NOW)?.label).toBe('resets now')
    expect(resetText(NOW + 42 * 60_000, NOW)?.label).toBe('resets in 42m')
    expect(resetText(NOW + 3 * 3_600_000 + 53 * 60_000, NOW)?.label).toBe('resets in 3h 53m')
    expect(resetText(NOW + 2 * 86_400_000, NOW)?.label).toMatch(/^resets [A-Z][a-z]{2} \d/)
    expect(resetText(NOW + 30 * 86_400_000, NOW)?.label).toBe('resets Nov 17')
    expect(resetText(Number.NaN, NOW)).toBeUndefined()
  })
})
