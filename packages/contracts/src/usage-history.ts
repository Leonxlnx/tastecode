/**
 * One model-attributed slice read from a provider's local history. Adapters
 * own the provider-specific parsing; the server only aggregates this common
 * shape into ranges, charts, and pricing summaries.
 */
export type LocalUsageRecord = {
  date: string
  model: string
  sessionId: string
  longContext: boolean
  tokens: {
    uncachedInputTokens: number
    cachedInputTokens: number
    cacheWrite5mInputTokens: number
    cacheWrite1hInputTokens: number
    outputTokens: number
    reasoningTokens: number
    providerReportedCostUsd: number
  }
}
