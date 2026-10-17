import type { LocalUsageRecord } from '@harness/contracts'

type TokenCounts = LocalUsageRecord['tokens']

export type ModelRate = {
  input: number
  cachedInput: number
  output: number
  pricing: 'exact' | 'family'
  longContextMultipliers?: { input: number; output: number }
}

export function priceEntry(rate: ModelRate | null, tokens: TokenCounts, longContext: boolean) {
  if (!rate) return { pricing: 'unpriced' as const, estimatedCostUsd: 0, cacheSavingsUsd: 0 }
  const inputMultiplier = longContext ? (rate.longContextMultipliers?.input ?? 1) : 1
  const outputMultiplier = longContext ? (rate.longContextMultipliers?.output ?? 1) : 1
  const perMillion = 1_000_000
  const estimatedCostUsd =
    (tokens.uncachedInputTokens * rate.input * inputMultiplier +
      tokens.cachedInputTokens * rate.cachedInput * inputMultiplier +
      tokens.cacheWrite5mInputTokens * rate.input * 1.25 * inputMultiplier +
      tokens.cacheWrite1hInputTokens * rate.input * 2 * inputMultiplier +
      tokens.outputTokens * rate.output * outputMultiplier) /
    perMillion
  const cacheSavingsUsd =
    (tokens.cachedInputTokens * Math.max(rate.input - rate.cachedInput, 0) * inputMultiplier) /
    perMillion
  return { pricing: rate.pricing, estimatedCostUsd, cacheSavingsUsd }
}

/**
 * Public API list prices in USD per million tokens, checked 2026-08-08.
 * OpenAI: https://developers.openai.com/api/docs/models
 * Anthropic: https://docs.anthropic.com/en/docs/about-claude/pricing
 * xAI: https://docs.x.ai/developers/pricing
 * Google: https://ai.google.dev/gemini-api/docs/pricing
 */
export function modelRate(model: string, date: string): ModelRate | undefined {
  const value = model.toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
  const exact = (
    input: number,
    cachedInput: number,
    output: number,
    longContextMultipliers?: ModelRate['longContextMultipliers'],
  ): ModelRate => ({
    input,
    cachedInput,
    output,
    pricing: 'exact',
    ...(longContextMultipliers ? { longContextMultipliers } : {}),
  })

  if (value.includes('grok-4-5')) return exact(2, 0.3, 6, { input: 2, output: 2 })

  if (value.includes('gemini-3-6-flash')) return exact(1.5, 0.15, 7.5)
  if (value.includes('gemini-3-5-flash-lite')) return exact(0.3, 0.03, 2.5)
  if (value.includes('gemini-3-5-flash')) return exact(1.5, 0.15, 9)
  if (value.includes('gemini-3-1-flash-lite')) return exact(0.25, 0.025, 1.5)
  if (value.includes('gemini-3-1-pro')) {
    return exact(2, 0.2, 12, { input: 2, output: 1.5 })
  }
  if (value.includes('gemini-2-5-flash-lite')) return exact(0.1, 0.01, 0.4)
  if (value.includes('gemini-2-5-flash')) return exact(0.3, 0.03, 2.5)
  if (value.includes('gemini-2-5-pro')) {
    return exact(1.25, 0.125, 10, { input: 2, output: 1.5 })
  }

  const openAiLongContext = { input: 2, output: 1.5 }
  if (value.includes('gpt-5-6-sol') || value === 'gpt-5-6') {
    return exact(5, 0.5, 30, openAiLongContext)
  }
  if (value.includes('gpt-5-6-terra')) return exact(2.5, 0.25, 15, openAiLongContext)
  if (value.includes('gpt-5-6-luna')) return exact(1, 0.1, 6, openAiLongContext)
  if (value.includes('gpt-5-6')) {
    return { ...exact(5, 0.5, 30, openAiLongContext), pricing: 'family' }
  }
  if (value.includes('gpt-5-5')) return exact(5, 0.5, 30)
  if (value.includes('gpt-5-4-mini')) return exact(0.75, 0.075, 4.5)
  if (value.includes('gpt-5-4')) return exact(2.5, 0.25, 15)
  if (value.includes('codex-auto-review')) return exact(1.75, 0.175, 14)
  if (value.includes('gpt-5-3-codex')) return exact(1.75, 0.175, 14)
  if (value.includes('gpt-5-2')) return exact(1.75, 0.175, 14)
  if (value.includes('gpt-5-1')) return exact(1.25, 0.125, 10)
  if (value === 'gpt-5' || value.startsWith('gpt-5-202') || value.includes('gpt-5-codex')) {
    return exact(1.25, 0.125, 10)
  }

  if (value.includes('claude-fable-5')) return exact(10, 1, 50)
  if (value.includes('claude-sonnet-5')) {
    return date <= '2026-08-31' ? exact(2, 0.2, 10) : exact(3, 0.3, 15)
  }
  if (
    value.includes('claude-opus-4-8') ||
    value.includes('claude-opus-4-7') ||
    value.includes('claude-opus-4-6') ||
    value.includes('claude-opus-4-5')
  ) {
    return exact(5, 0.5, 25)
  }
  if (value.includes('claude-sonnet-4')) return exact(3, 0.3, 15)
  if (value.includes('claude-haiku-4-5')) return exact(1, 0.1, 5)
  if (
    value === 'claude-opus-4' ||
    value.includes('claude-opus-4-1') ||
    value.includes('claude-opus-4-2025')
  ) {
    return exact(15, 1.5, 75)
  }
  if (value.includes('claude-sonnet-3')) return exact(3, 0.3, 15)
  if (value.includes('claude-haiku-3-5')) return exact(0.8, 0.08, 4)
  if (value.includes('claude-haiku-3')) return exact(0.25, 0.025, 1.25)

  if (value.includes('claude-fable')) return { ...exact(10, 1, 50), pricing: 'family' }
  return undefined
}
