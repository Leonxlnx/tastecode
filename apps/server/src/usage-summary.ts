import type { ProviderId, ProviderLimitSource, ResultOf } from '@harness/contracts'

type UsageTotals = Pick<ResultOf<'usage.summary'>, 'session' | 'today'>

export async function usageSummaryWithLimits(
  totals: UsageTotals,
  provider: ProviderId,
  loadSource: (provider: ProviderId) => Promise<ProviderLimitSource>,
): Promise<ResultOf<'usage.summary'>> {
  const limitSource = await loadSource(provider)
  if (limitSource.provider !== provider) {
    throw new Error('Provider limit source did not match the request.')
  }
  return {
    ...totals,
    limitSource,
    limits: limitSource.status === 'ready' ? limitSource.limits : [],
  }
}
