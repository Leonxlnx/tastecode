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
  /**
   * Why records can only be priced approximately, when the page prices
   * something the records do not tell apart. Such rates count as `family`.
   */
  approximation?: string
}

export type ModelRate = TokenRates & {
  /**
   * `family`: an estimate, either a listed model's price applied to an unlisted
   * variant of it or a price the records cannot match exactly.
   */
  pricing: 'exact' | 'family'
  longContext?: TokenRates
}

const OPENAI_PRICING = 'https://developers.openai.com/api/docs/pricing'
const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing'
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
    more: Pick<ModelPrice, 'effectiveFrom' | 'longContext' | 'approximation'> = {},
  ): ModelPrice => ({ models, ...rates, ...more, source, checkedAt })

const openAi = listedOn(OPENAI_PRICING, '2026-10-17')
const anthropic = listedOn(ANTHROPIC_PRICING, '2026-10-17')
const xai = listedOn(XAI_PRICING, '2026-10-17')
const google = listedOn(GOOGLE_PRICING, '2026-10-17')

/**
 * Public API list prices, standard tier. Each figure comes from the page in
 * its `source`; a model that page does not list stays unpriced rather than
 * guessed. A record is priced at the price in force on its day where the
 * page dates a change, and at today's price otherwise.
 *
 * Long-context rates apply above 272K input tokens for OpenAI and 200K prompt
 * tokens for xAI and Google, the thresholds the usage records are cut at.
 * Claude 4.6 and later have no long-context premium.
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  xai(['grok-4-7', 'grok-4-6'], usd(2, 0.5, 6), { longContext: usd(4, 1, 12) }),
  // Only in Cursor and Grok Build; the page prices it at twice Grok 4.7.
  xai(['grok-4-7-fast'], usd(4, 1, 12), { longContext: usd(6, 1.5, 18) }),
  xai(['grok-4-5'], usd(2, 0.3, 6), { longContext: usd(4, 0.6, 12) }),
  xai(
    [
      'grok-4-3',
      'grok-4-20-0309-reasoning',
      'grok-4-20-0309-non-reasoning',
      'grok-4-20-multi-agent-0309',
    ],
    usd(1.25, 0.2, 2.5),
    { longContext: usd(2.5, 0.4, 5) },
  ),
  xai(['grok-build-0-1'], usd(1, 0.2, 2), { longContext: usd(2, 0.4, 4) }),

  // Introductory price through 2026-12-31.
  google(['gemini-3-8-flash', 'gemini-3-6-flash'], usd(0.75, 0.075, 3.75)),
  google(['gemini-3-8-flash', 'gemini-3-6-flash'], usd(1.5, 0.15, 7.5), {
    effectiveFrom: '2027-01-01',
  }),
  google(['gemini-3-5-flash-lite'], usd(0.3, 0.03, 2.5)),
  google(['gemini-3-1-flash-lite'], usd(0.25, 0.025, 1.5)),
  // Listed as gemini-3.1-pro-preview; Antigravity reports it as gemini-3.1-pro.
  google(['gemini-3-1-pro-preview', 'gemini-3-1-pro'], usd(2, 0.2, 12), {
    longContext: usd(4, 0.4, 18),
  }),
  google(['gemini-3-flash-preview'], usd(0.5, 0.05, 3)),
  google(['gemini-2-5-pro'], usd(1.25, 0.125, 10), { longContext: usd(2.5, 0.25, 15) }),
  google(['gemini-2-5-flash'], usd(0.3, 0.03, 2.5)),
  google(['gemini-2-5-flash-lite'], usd(0.1, 0.01, 0.4)),

  openAi(['gpt-6-astra'], usd(10, 1, 50), { longContext: usd(20, 2, 75) }),
  openAi(['gpt-6-1-sol'], usd(2, 0.1, 10), { longContext: usd(4, 0.2, 15) }),
  openAi(['gpt-6-sol'], usd(2, 0.2, 10), { longContext: usd(4, 0.4, 15) }),
  openAi(['gpt-6-luna'], usd(0.1, 0.01, 0.5), { longContext: usd(0.2, 0.02, 0.75) }),
  // Promotional price, available at least through 2026-11-21.
  openAi(['gpt-5-6-sol'], usd(4, 0.4, 20), { longContext: usd(8, 0.8, 30) }),
  openAi(['gpt-5-6-terra'], usd(2, 0.2, 12), { longContext: usd(4, 0.4, 18) }),
  openAi(['gpt-5-6-luna'], usd(0.2, 0.02, 1.2), { longContext: usd(0.4, 0.04, 1.8) }),
  openAi(['gpt-5-5'], usd(5, 0.5, 30), { longContext: usd(10, 1, 45) }),
  openAi(['gpt-5-4'], usd(2.5, 0.25, 15), { longContext: usd(5, 0.5, 22.5) }),
  openAi(['gpt-5-4-mini'], usd(0.75, 0.075, 4.5)),
  openAi(['gpt-5-4-nano'], usd(0.2, 0.02, 1.25)),
  openAi(['gpt-5-3-codex', 'gpt-5-2'], usd(1.75, 0.175, 14)),
  openAi(['gpt-5-1', 'gpt-5'], usd(1.25, 0.125, 10)),
  openAi(['gpt-5-mini'], usd(0.25, 0.025, 2)),
  openAi(['gpt-5-nano'], usd(0.05, 0.005, 0.4)),
  // Pro models list no cached-input price: cached input is billed as input.
  openAi(['gpt-5-5-pro', 'gpt-5-4-pro'], usd(30, 30, 180), { longContext: usd(60, 60, 270) }),
  openAi(['gpt-5-2-pro'], usd(21, 21, 168)),
  openAi(['gpt-5-pro'], usd(15, 15, 120)),

  anthropic(['claude-fable-5-1'], usd(10, 0.25, 50)),
  anthropic(['claude-fable-5'], usd(10, 1, 50)),
  anthropic(['claude-opus-5-5'], usd(4, 0.2, 20)),
  anthropic(
    ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'],
    usd(5, 0.5, 25),
  ),
  anthropic(['claude-opus-4-1', 'claude-opus-4'], usd(15, 1.5, 75)),
  anthropic(['claude-sonnet-5-5'], usd(2, 0.1, 10)),
  // Launched as introductory pricing; the page now lists it as the standard price.
  anthropic(['claude-sonnet-5'], usd(2, 0.2, 10)),
  anthropic(['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4'], usd(3, 0.3, 15)),
  anthropic(['claude-haiku-5-5'], usd(0.1, 0.01, 0.5), {
    longContext: usd(0.5, 0.05, 2.5),
    approximation:
      'Prompts over 100K tokens cost five times as much, but records only mark prompts over 272K.',
  }),
  anthropic(['claude-haiku-4-5'], usd(1, 0.1, 5)),
  anthropic(['claude-3-5-haiku'], usd(0.8, 0.08, 4)),
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
    pricing: price.approximation ? 'family' : pricing,
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
