import { describe, expect, it } from 'vitest'
import { mapCodexRateLimits } from './limits.js'
import type { CodexRateLimitResponse, CodexRateLimitSnapshot } from './schemas.js'

const snapshot = (overrides: Partial<CodexRateLimitSnapshot> = {}): CodexRateLimitSnapshot => ({
  limitId: 'codex',
  limitName: null,
  primary: null,
  secondary: null,
  credits: null,
  individualLimit: null,
  planType: null,
  rateLimitReachedType: null,
  ...overrides,
})

const response = (overrides: Partial<CodexRateLimitResponse>): CodexRateLimitResponse => ({
  rateLimits: snapshot(),
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  ...overrides,
})

describe('mapCodexRateLimits', () => {
  it('maps and clamps every reported bucket', () => {
    expect(
      mapCodexRateLimits(
        response({
          rateLimits: snapshot({
            primary: { usedPercent: -5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            credits: { hasCredits: true, unlimited: false, balance: '25' },
          }),
          rateLimitsByLimitId: {
            spark: snapshot({
              limitId: 'spark',
              limitName: 'Spark',
              primary: { usedPercent: 140, windowDurationMins: 10_080, resetsAt: null },
            }),
          },
          rateLimitResetCredits: { availableCount: 2 },
        }),
      ),
    ).toEqual([
      {
        id: 'codex:primary',
        label: '5 hours',
        usedPercent: 0,
        resetsAt: 1_800_000_000_000,
        windowMinutes: 300,
      },
      { id: 'spark:primary', label: 'Weekly Spark', usedPercent: 100, windowMinutes: 10_080 },
      { id: 'credits', label: 'Credits', usedPercent: 0, valueLabel: '$1.00 · 25 credits' },
      {
        id: 'resets',
        label: 'Rate limit resets',
        usedPercent: 0,
        valueLabel: '2 available',
        action: 'consume-reset',
      },
    ])
  })

  it('labels the two weekly buckets with their friendly names', () => {
    expect(
      mapCodexRateLimits(
        response({
          rateLimits: snapshot({
            primary: { usedPercent: 14, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
          }),
          rateLimitsByLimitId: {
            spark: snapshot({
              limitId: 'spark',
              limitName: 'GPT-5.3-Codex-Spark',
              primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: null },
            }),
          },
        }),
      ).map((limit) => limit.label),
    ).toEqual(['Weekly', 'Weekly Spark'])
  })

  it('skips non-finite windows and stale reset metadata without losing valid rows', () => {
    expect(
      mapCodexRateLimits(
        response({
          rateLimits: snapshot({
            primary: { usedPercent: 20, windowDurationMins: null, resetsAt: Number.NaN },
            secondary: { usedPercent: Number.NaN, windowDurationMins: 60, resetsAt: 1 },
            credits: { hasCredits: true, unlimited: true, balance: null },
          }),
          rateLimitResetCredits: { availableCount: Number.POSITIVE_INFINITY },
        }),
      ),
    ).toEqual([
      { id: 'codex:primary', label: 'Primary limit', usedPercent: 20 },
      { id: 'credits', label: 'Credits', usedPercent: 0, valueLabel: 'Unlimited' },
    ])
  })

  it('names a row by its bucket and slot, so a window of another length keeps its id', () => {
    const rows = (primaryMinutes: number, secondaryMinutes: number) =>
      mapCodexRateLimits(
        response({
          rateLimits: snapshot({
            primary: { usedPercent: 5, windowDurationMins: primaryMinutes, resetsAt: null },
            secondary: { usedPercent: 9, windowDurationMins: secondaryMinutes, resetsAt: null },
          }),
        }),
      ).map(({ id, windowMinutes }) => [id, windowMinutes])
    expect(rows(300, 10_080)).toEqual([
      ['codex:primary', 300],
      ['codex:secondary', 10_080],
    ])
    expect(rows(10_080, 43_200)).toEqual([
      ['codex:primary', 10_080],
      ['codex:secondary', 43_200],
    ])
  })
})
