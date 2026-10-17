import type { LocalUsageRecord } from '@harness/contracts'

type TokenCounts = LocalUsageRecord['tokens']

/** USD per million tokens. */
export type TokenRates = {
  input: number
  cachedInput: number
  output: number
}

/** One public API list price, as read from the model maker's own pricing page. */
export type ModelPrice = TokenRates & {
  /** Model ids as `normalizeModelId` writes them. */
  models: readonly string[]
  /** First day (YYYY-MM-DD) the price applies; the latest one on or before a record's day wins. */
  effectiveFrom?: string
  /** Rates for a request above the maker's long-context threshold. */
  longContext?: TokenRates
  /** The pricing page the figures come from. */
  source: string
  /** When the figures were last compared with that page. */
  checkedAt: string
}

export type ModelRate = TokenRates & {
  /** `family`: a listed model's price applied to an unlisted variant of it. */
  pricing: 'exact' | 'family'
  longContext?: TokenRates
}

const OPENAI_PRICING = 'https://developers.openai.com/api/docs/models'
const ANTHROPIC_PRICING = 'https://docs.anthropic.com/en/docs/about-claude/pricing'
const XAI_PRICING = 'https://docs.x.ai/developers/pricing'
const GOOGLE_PRICING = 'https://ai.google.dev/gemini-api/docs/pricing'

const usd = (input: number, cachedInput: number, output: number): TokenRates => ({
  input,
  cachedInput,
  output,
})

const listedOn =
  (source: string, checkedAt: string) =>
  (
    models: readonly string[],
    rates: TokenRates,
    more: Pick<ModelPrice, 'effectiveFrom' | 'longContext'> = {},
  ): ModelPrice => ({ models, ...rates, ...more, source, checkedAt })

const openAi = listedOn(OPENAI_PRICING, '2026-08-08')
const anthropic = listedOn(ANTHROPIC_PRICING, '2026-08-08')
const xai = listedOn(XAI_PRICING, '2026-08-08')
const google = listedOn(GOOGLE_PRICING, '2026-08-08')

/**
 * Public API list prices. Each figure comes from the page in its `source`;
 * a model missing here stays unpriced rather than guessed.
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  xai(['grok-4-5'], usd(2, 0.3, 6), { longContext: usd(4, 0.6, 12) }),

  google(['gemini-3-6-flash'], usd(1.5, 0.15, 7.5)),
  google(['gemini-3-5-flash-lite'], usd(0.3, 0.03, 2.5)),
  google(['gemini-3-5-flash'], usd(1.5, 0.15, 9)),
  google(['gemini-3-1-flash-lite'], usd(0.25, 0.025, 1.5)),
  google(['gemini-3-1-pro'], usd(2, 0.2, 12), { longContext: usd(4, 0.4, 18) }),
  google(['gemini-2-5-flash-lite'], usd(0.1, 0.01, 0.4)),
  google(['gemini-2-5-flash'], usd(0.3, 0.03, 2.5)),
  google(['gemini-2-5-pro'], usd(1.25, 0.125, 10), { longContext: usd(2.5, 0.25, 15) }),

  openAi(['gpt-5-6-sol', 'gpt-5-6'], usd(5, 0.5, 30), { longContext: usd(10, 1, 45) }),
  openAi(['gpt-5-6-terra'], usd(2.5, 0.25, 15), { longContext: usd(5, 0.5, 22.5) }),
  openAi(['gpt-5-6-luna'], usd(1, 0.1, 6), { longContext: usd(2, 0.2, 9) }),
  openAi(['gpt-5-5'], usd(5, 0.5, 30)),
  openAi(['gpt-5-4-mini'], usd(0.75, 0.075, 4.5)),
  openAi(['gpt-5-4'], usd(2.5, 0.25, 15)),
  openAi(['codex-auto-review', 'gpt-5-3-codex', 'gpt-5-2'], usd(1.75, 0.175, 14)),
  openAi(['gpt-5-1', 'gpt-5', 'gpt-5-codex'], usd(1.25, 0.125, 10)),

  anthropic(['claude-fable-5'], usd(10, 1, 50)),
  anthropic(['claude-sonnet-5'], usd(2, 0.2, 10)),
  anthropic(['claude-sonnet-5'], usd(3, 0.3, 15), { effectiveFrom: '2026-09-01' }),
  anthropic(
    ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'],
    usd(5, 0.5, 25),
  ),
  anthropic(['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4'], usd(3, 0.3, 15)),
  anthropic(['claude-haiku-4-5'], usd(1, 0.1, 5)),
  anthropic(['claude-opus-4-1', 'claude-opus-4'], usd(15, 1.5, 75)),
]

/** Dated prices of one model, latest first; an undated price sorts last. */
const PRICES_BY_MODEL = new Map<string, ModelPrice[]>()
for (const price of MODEL_PRICES) {
  for (const model of price.models) {
    const prices = PRICES_BY_MODEL.get(model) ?? []
    prices.push(price)
    PRICES_BY_MODEL.set(model, prices)
  }
}
for (const prices of PRICES_BY_MODEL.values()) {
  prices.sort((left, right) => (right.effectiveFrom ?? '').localeCompare(left.effectiveFrom ?? ''))
}
/** Longest first, so a variant falls back to its closest listed model. */
const LISTED_MODELS = [...PRICES_BY_MODEL.keys()].sort((left, right) => right.length - left.length)

/**
 * The id a model is priced under: lower case, `.` and `_` written as `-`,
 * without a route prefix (`openai/`), a release date (`-20251001`) or a
 * reasoning-effort suffix (`-high`), none of which changes the list price.
 */
export function normalizeModelId(model: string): string {
  return model
    .slice(model.lastIndexOf('/') + 1)
    .toLowerCase()
    .replaceAll('_', '-')
    .replaceAll('.', '-')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, '')
    .replace(/-(?:minimal|low|medium|high|xhigh)$/u, '')
}

/**
 * The list price of `model` on `date`. An unlisted named variant of a listed
 * model (`gpt-5-1-codex-mini` next to `gpt-5-1`) is estimated at that model's
 * price and marked `family`; an unlisted version number (`claude-opus-4-9`)
 * is a different model and stays unpriced.
 */
export function modelRate(model: string, date: string): ModelRate | undefined {
  const id = normalizeModelId(model)
  const exact = priceOn(PRICES_BY_MODEL.get(id), date)
  if (exact) return rateOf(exact, 'exact')
  const family = LISTED_MODELS.find(
    (listed) => id.startsWith(`${listed}-`) && /[a-z]/u.test(id.charAt(listed.length + 1)),
  )
  const price = family ? priceOn(PRICES_BY_MODEL.get(family), date) : undefined
  return price ? rateOf(price, 'family') : undefined
}

function priceOn(prices: readonly ModelPrice[] | undefined, date: string) {
  return prices?.find((price) => price.effectiveFrom === undefined || price.effectiveFrom <= date)
}

function rateOf(price: ModelPrice, pricing: ModelRate['pricing']): ModelRate {
  return {
    input: price.input,
    cachedInput: price.cachedInput,
    output: price.output,
    pricing,
    ...(price.longContext ? { longContext: price.longContext } : {}),
  }
}

/**
 * The API-equivalent cost of one record. Cache writes cost 1.25 times the
 * input rate for the 5-minute cache and twice it for the 1-hour cache.
 */
export function priceEntry(rate: ModelRate | null, tokens: TokenCounts, longContext: boolean) {
  if (!rate) return { pricing: 'unpriced' as const, estimatedCostUsd: 0, cacheSavingsUsd: 0 }
  const rates = longContext && rate.longContext ? rate.longContext : rate
  const perMillion = 1_000_000
  const estimatedCostUsd =
    (tokens.uncachedInputTokens * rates.input +
      tokens.cachedInputTokens * rates.cachedInput +
      tokens.cacheWrite5mInputTokens * rates.input * 1.25 +
      tokens.cacheWrite1hInputTokens * rates.input * 2 +
      tokens.outputTokens * rates.output) /
    perMillion
  const cacheSavingsUsd =
    (tokens.cachedInputTokens * Math.max(rates.input - rates.cachedInput, 0)) / perMillion
  return { pricing: rate.pricing, estimatedCostUsd, cacheSavingsUsd }
}
