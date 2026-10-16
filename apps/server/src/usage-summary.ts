import type { ProviderId, ProviderLimitSource, ResultOf } from '@harness/contracts'

type UsageTotals = Pick<ResultOf<'usage.summary'>, 'session' | 'today'>

/**
 * Answers with the held limits at once and lets `loadSource` refresh them in
 * the background, so a chat's token totals never wait on a vendor process.
 * Only a provider's first read, with nothing held yet, is awaited. The
 * refresh reaches clients through the limits push and usage-change signal.
 */
export async function usageSummaryWithLimits(
  totals: UsageTotals,
  provider: ProviderId,
  loadSource: (provider: ProviderId) => Promise<ProviderLimitSource>,
  heldSource?: (provider: ProviderId) => ProviderLimitSource | undefined,
): Promise<ResultOf<'usage.summary'>> {
  const held = heldSource?.(provider)
  if (held) {
    // A fresh held value makes this a cache hit; an older one starts one shared read.
    void Promise.resolve()
      .then(() => loadSource(provider))
      .catch(() => undefined)
  }
  const limitSource = held ?? (await loadSource(provider))
  if (limitSource.provider !== provider) {
    throw new Error('Provider limit source did not match the request.')
  }
  return {
    ...totals,
    limitSource,
    limits: limitSource.status === 'ready' ? limitSource.limits : [],
  }
}
