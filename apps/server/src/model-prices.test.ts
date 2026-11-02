import { describe, expect, it } from 'vitest'
import type { LocalUsageRecord } from '@harness/contracts'
import { MODEL_PRICES, modelRate, normalizeModelId, priceEntry } from './model-prices.js'

const tokens = (values: Partial<LocalUsageRecord['tokens']>): LocalUsageRecord['tokens'] => ({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWrite1hInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  providerReportedCostUsd: 0,
  ...values,
})

describe('model prices', () => {
  it('prices a model under one id whatever route, date stamp or effort it is recorded with', () => {
    expect(normalizeModelId('openai/GPT-5.6-Sol')).toBe('gpt-5-6-sol')
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(normalizeModelId('gpt-5-2025-08-07')).toBe('gpt-5')
    expect(normalizeModelId('gemini-3.6-flash-high')).toBe('gemini-3-6-flash')
    expect(normalizeModelId('gpt_5_4_mini')).toBe('gpt-5-4-mini')
  })

  it('looks up exact list prices and the price in force on the record day', () => {
    expect(modelRate('gpt-5.6-terra', '2026-08-08')).toMatchObject({
      input: 2,
      cachedInput: 0.2,
      output: 12,
      pricing: 'exact',
    })
    expect(modelRate('claude-sonnet-5', '2026-09-01')).toMatchObject({ input: 2, output: 10 })
    expect(modelRate('gemini-3.6-flash-high', '2026-12-31')).toMatchObject({ input: 0.75 })
    expect(modelRate('gemini-3.6-flash-high', '2027-01-01')).toMatchObject({ input: 1.5 })
  })

  it('prices every model in current local histories exactly', () => {
    const current = [
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-4-8',
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'grok-4.7',
      'grok-4.6',
      'gemini-3.6-flash-high',
      'gemini-3.1-pro-high',
    ]
    const unpriced = current.filter((model) => modelRate(model, '2026-10-17')?.pricing !== 'exact')
    expect(unpriced).toEqual([])
  })

  it('marks a price the records cannot match exactly as an estimate', () => {
    const haiku = modelRate('claude-haiku-5-5', '2026-10-17')!
    expect(haiku.pricing).toBe('family')
    const usage = tokens({ uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(priceEntry(haiku, usage, false).estimatedCostUsd).toBeCloseTo(0.6, 8)
    expect(priceEntry(haiku, usage, true).estimatedCostUsd).toBeCloseTo(3, 8)
  })

  it('estimates a named variant at its model price but never guesses a new version', () => {
    expect(modelRate('gpt-5.1-codex-mini', '2026-08-08')).toMatchObject({
      input: 1.25,
      pricing: 'family',
    })
    expect(modelRate('claude-opus-4-9', '2026-08-08')).toBeUndefined()
    expect(modelRate('private-model', '2026-08-08')).toBeUndefined()
    // No public page prices Codex's auto-review model.
    expect(modelRate('codex-auto-review', '2026-10-17')).toBeUndefined()
  })

  it('applies long-context rates and charges cache writes from the input rate', () => {
    const rate = modelRate('gpt-5.6-sol', '2026-08-08')!
    const usage = tokens({ uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(priceEntry(rate, usage, false).estimatedCostUsd).toBeCloseTo(24, 8)
    expect(priceEntry(rate, usage, true).estimatedCostUsd).toBeCloseTo(38, 8)

    const writes = tokens({
      cacheWrite5mInputTokens: 1_000_000,
      cacheWrite1hInputTokens: 1_000_000,
    })
    const claude = modelRate('claude-opus-4-8', '2026-08-08')!
    expect(priceEntry(claude, writes, false).estimatedCostUsd).toBeCloseTo(5 * 1.25 + 5 * 2, 8)
    expect(priceEntry(null, usage, false)).toEqual({
      pricing: 'unpriced',
      estimatedCostUsd: 0,
      cacheSavingsUsd: 0,
    })
  })

  it('cites a source for every price and lists each model once per effective date', () => {
    const seen = new Set<string>()
    for (const price of MODEL_PRICES) {
      expect(price.source).toMatch(/^https:\/\//u)
      expect(price.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
      for (const model of price.models) {
        expect(normalizeModelId(model)).toBe(model)
        const key = `${model}@${price.effectiveFrom ?? ''}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
  })
})
