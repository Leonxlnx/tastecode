import { useId } from 'react'
import type { ResultOf, UsageHistoryTotals } from '@harness/contracts'
import { providerDisplayName, providerMark } from '../../provider-presentation.js'
import '../../styles/usage-value.css'
import { cacheHitRate } from '../../usage-history-state.js'
import { ProviderIcon } from '../ProviderIcon.js'
import { SettingsRow } from '../settings/SettingsLayout.js'
import { formatMoney, formatPercent } from './usage-format.js'

type History = ResultOf<'usage.history'>

/**
 * The dollar figure counts as the cost of the period only when at least this
 * share of its tokens has a public or provider-reported price.
 */
const FULL_ESTIMATE_SHARE = 0.95

/** Share of tokens with a price, or undefined when there are no tokens. */
export function pricedShare(totals: UsageHistoryTotals): number | undefined {
  if (totals.processedTokens <= 0) return undefined
  return (totals.pricedTokens + totals.providerReportedTokens) / totals.processedTokens
}

/**
 * What the period's tokens would cost at public API prices, never shown as a
 * bill: under 95% priced tokens the figure is muted and called a partial
 * estimate, with the priced share beside it.
 */
export function UsageValue(props: { data: History }) {
  const titleId = useId()
  const { totals } = props.data
  const priced = pricedShare(totals)
  const partial = priced !== undefined && priced < FULL_ESTIMATE_SHARE
  const coverage =
    priced === undefined ? undefined : formatPercent(Math.floor(priced * 1_000) / 1_000)
  const hitRate = cacheHitRate(totals)
  const providers = props.data.providers.filter((provider) => provider.totals.processedTokens > 0)

  return (
    <section className="usage-section usage-value" aria-labelledby={titleId}>
      <header className="usage-section__head">
        <h2 className="usage-section__title" id={titleId}>
          API value
        </h2>
      </header>
      <p className="usage-section__note">
        What these tokens would cost at public API prices, not what your plan bills.
      </p>
      {priced === undefined ? (
        <p className="usage-section__empty">No token records in this period.</p>
      ) : (
        <>
          <SettingsRow
            name="Total"
            className="usage-value__total"
            note={partial ? `Partial estimate · ${coverage} of tokens priced` : undefined}
          >
            <span className="usage-value__figure" data-partial={partial ? '' : undefined}>
              {formatMoney(totals.estimatedCostUsd)}
            </span>
          </SettingsRow>
          {providers.length > 1
            ? providers.map((provider) => (
                <SettingsRow
                  key={provider.provider}
                  name={
                    <span className="usage-value__provider">
                      <ProviderIcon mark={providerMark(provider.provider)} size={13} />
                      {providerDisplayName(provider.provider)}
                    </span>
                  }
                >
                  <span className="usage-value__figure">
                    {formatMoney(provider.totals.estimatedCostUsd)}
                  </span>
                </SettingsRow>
              ))
            : null}
          <SettingsRow
            name="Saved by caching"
            note={
              hitRate === undefined
                ? undefined
                : `${formatPercent(hitRate)} of input was read from cache${partial ? '. Counts priced tokens only.' : '.'}`
            }
          >
            <span className="usage-value__figure" data-partial={partial ? '' : undefined}>
              {formatMoney(totals.cacheSavingsUsd)}
            </span>
          </SettingsRow>
        </>
      )}
    </section>
  )
}
