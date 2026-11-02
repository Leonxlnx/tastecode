import type { ResultOf, UsageHistoryRange, UsageHistoryTotals } from '@harness/contracts'

/** Test data for the Usage page: one Codex model, one day, fully priced. */
export function historyResult(range: UsageHistoryRange): ResultOf<'usage.history'> {
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
    generatedAt: Date.UTC(2026, 7, 8, 12),
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

export function usageTotals(values: Partial<UsageHistoryTotals>): UsageHistoryTotals {
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
