import { describe, expect, it } from 'vitest'
import type { GetAccountRateLimitsResponse } from './generated/v2/GetAccountRateLimitsResponse.js'
import { mapCodexRateLimits } from './adapter.js'

const snapshot = (overrides: Record<string, unknown> = {}) => ({
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

const response = (overrides: Record<string, unknown>): GetAccountRateLimitsResponse =>
  ({
    rateLimits: snapshot(),
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    ...overrides,
  }) as GetAccountRateLimitsResponse

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
      { label: '5 hours', usedPercent: 0, resetsAt: 1_800_000_000_000 },
      { label: 'Spark 7 days', usedPercent: 100 },
      { label: 'Credits', usedPercent: 0, valueLabel: '$1.00 · 25 credits' },
      { label: 'Rate limit resets', usedPercent: 0, valueLabel: '2 available' },
    ])
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
      { label: 'Primary limit', usedPercent: 20 },
      { label: 'Credits', usedPercent: 0, valueLabel: 'Unlimited' },
    ])
  })
})
