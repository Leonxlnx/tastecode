import { useId, useState } from 'react'
import type { ResultOf, UsageHistoryModel, UsageHistoryTotals } from '@harness/contracts'
import { providerDisplayName, providerMark } from '../../provider-presentation.js'
import '../../styles/usage-models.css'
import { ProviderIcon } from '../ProviderIcon.js'
import { formatMoney, formatPercent, formatTokens } from './usage-format.js'

type History = ResultOf<'usage.history'>

/** Models listed before "Show all". */
const MODELS_SHOWN = 8

/** Every model of the period by tokens, with its share and its value at API prices. */
export function UsageModels(props: { data: History }) {
  const titleId = useId()
  const [expanded, setExpanded] = useState(false)
  const rows = props.data.models.toSorted(
    (left, right) => right.totals.processedTokens - left.totals.processedTokens,
  )
  const total = props.data.totals.processedTokens
  const shown = expanded ? rows : rows.slice(0, MODELS_SHOWN)

  return (
    <section className="usage-section usage-models" aria-labelledby={titleId}>
      <header className="usage-section__head">
        <h2 className="usage-section__title" id={titleId}>
          Models
        </h2>
      </header>
      {rows.length === 0 ? (
        <p className="usage-section__empty">No model activity in this period.</p>
      ) : (
        <>
          <table className="usage-models__table" aria-labelledby={titleId}>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Tokens</th>
                <th scope="col">Share</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((model) => (
                <ModelRow key={`${model.provider}:${model.model}`} model={model} total={total} />
              ))}
            </tbody>
          </table>
          {rows.length > MODELS_SHOWN ? (
            <button
              className="set-button set-button--quiet usage-models__more"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Show fewer' : `Show all ${rows.length} models`}
            </button>
          ) : null}
        </>
      )}
    </section>
  )
}

function ModelRow(props: { model: UsageHistoryModel; total: number }) {
  const { model } = props
  const share = props.total > 0 ? model.totals.processedTokens / props.total : 0
  const badge = pricingLabel(model.pricing, model.totals)
  const valued = model.totals.pricedTokens + model.totals.providerReportedTokens > 0
  const provider = providerDisplayName(model.provider)
  return (
    <tr data-provider={model.provider}>
      <th scope="row">
        <span className="usage-models__name" title={`${provider} · ${model.model}`}>
          <ProviderIcon mark={providerMark(model.provider)} size={13} />
          <span className="visually-hidden">{provider}: </span>
          <span className="usage-models__model">{model.model}</span>
          {badge ? <em>{badge}</em> : null}
        </span>
      </th>
      <td>{formatTokens(model.totals.processedTokens)}</td>
      <td>
        <span className="usage-models__share">
          <span className="usage-models__track" aria-hidden>
            <span style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }} />
          </span>
          {formatPercent(share)}
        </span>
      </td>
      <td>{valued ? formatMoney(model.totals.estimatedCostUsd) : '—'}</td>
    </tr>
  )
}

function pricingLabel(
  pricing: UsageHistoryModel['pricing'],
  totals: UsageHistoryTotals,
): string | undefined {
  if (
    totals.providerReportedCostUsd > 0 &&
    totals.pricedTokens === 0 &&
    totals.unpricedTokens === 0
  ) {
    return 'provider cost'
  }
  if (pricing === 'family') return 'approximate'
  if (pricing === 'unpriced') return 'unpriced'
  return undefined
}
