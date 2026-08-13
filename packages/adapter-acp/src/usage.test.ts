import { describe, expect, it } from 'vitest'
import { acpSessionUsage, acpTurnUsage } from './usage.js'

describe('ACP usage extensions', () => {
  it('normalizes the draft end-turn token categories', () => {
    expect(
      acpTurnUsage(
        {
          totalTokens: 53_000,
          inputTokens: 35_000,
          outputTokens: 12_000,
          thoughtTokens: 5_000,
          cachedReadTokens: 5_000,
          cachedWriteTokens: 1_000,
        },
        'kimi-code/k3',
      ),
    ).toEqual({
      model: 'kimi-code/k3',
      inputTokens: 35_000,
      cachedInputTokens: 5_000,
      outputTokens: 17_000,
      reasoningTokens: 5_000,
      totalTokens: 53_000,
      inputIncludesCached: true,
    })
  })

  it('keeps session context separate while accepting cumulative USD cost', () => {
    expect(
      acpSessionUsage(
        { used: 53_000, size: 200_000, cost: { amount: 0.045, currency: 'USD' } },
        'kimi-code/k3',
      ),
    ).toEqual({
      model: 'kimi-code/k3',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 53_000,
      cumulative: true,
      contextWindow: 200_000,
      costUsd: 0.045,
    })
  })
})
