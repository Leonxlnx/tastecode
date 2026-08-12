import { useId } from 'react'
import type { ProviderId, ResultOf } from '@harness/contracts'
import { CircleAlert, Gauge, RefreshCw } from 'lucide-react'
import { providerDisplayName, providerMark } from '../provider-presentation.js'
import { ProviderIcon } from './ProviderIcon.js'

type Limit = ResultOf<'usage.summary'>['limits'][number]

export type AccountLimitSource =
  | { provider: ProviderId; status: 'ready'; limits: Limit[] }
  | { provider: ProviderId; status: 'unavailable' }

type Summary = ResultOf<'usage.summary'> & { limitSources?: AccountLimitSource[] }

export type AccountLimitsState =
  | { status: 'loading'; provider: ProviderId; summary?: Summary }
  | { status: 'ready'; provider: ProviderId; summary: Summary }
  | { status: 'error'; provider: ProviderId; message: string; summary?: Summary }

export function AccountLimits(props: { state: AccountLimitsState; onRetry: () => void }) {
  const headingId = useId()
  const sources = limitSources(props.state)
  const hasSources = sources.length > 0

  return (
    <section
      className="account-menu__usage"
      aria-labelledby={headingId}
      aria-busy={props.state.status === 'loading'}
    >
      <div className="account-menu__usage-head" id={headingId} tabIndex={-1}>
        <Gauge size={14} aria-hidden />
        <span>Plan limits</span>
      </div>

      {hasSources
        ? sources.map((source) => <LimitSource key={source.provider} source={source} />)
        : null}

      {props.state.status === 'loading' ? (
        <p className="account-menu__usage-note" role="status">
          <RefreshCw size={13} aria-hidden />
          {hasSources ? 'Refreshing plan limits…' : 'Checking plan limits…'}
        </p>
      ) : null}

      {props.state.status === 'error' ? (
        <div className="account-menu__usage-error" role="alert">
          <CircleAlert size={13} aria-hidden />
          <span>
            {hasSources
              ? 'Couldn’t refresh plan limits. Last known values are still shown.'
              : 'Plan limits couldn’t be loaded.'}
            <small>{props.state.message}</small>
          </span>
          <button type="button" onClick={props.onRetry}>
            Retry
          </button>
        </div>
      ) : null}
    </section>
  )
}

function LimitSource(props: { source: AccountLimitSource }) {
  const titleId = useId()
  const name = providerDisplayName(props.source.provider)
  return (
    <section className="account-menu__source" aria-labelledby={titleId}>
      <h3 id={titleId}>
        <ProviderIcon mark={providerMark(props.source.provider)} size={14} />
        {name}
      </h3>
      {props.source.status === 'unavailable' ? (
        <p className="account-menu__usage-note">Plan limits aren’t available from this source.</p>
      ) : props.source.limits.length === 0 ? (
        <p className="account-menu__usage-note">No plan limits reported.</p>
      ) : (
        props.source.limits.map((limit) => (
          <div className="account-menu__limit" key={limit.label}>
            <div className="account-menu__limit-row">
              <span className="account-menu__limit-label">{limit.label}</span>
              <span>{limit.valueLabel ?? `${remaining(limit)}% left`}</span>
            </div>
            {limit.valueLabel === undefined ? (
              <div
                className="account-menu__limit-bar"
                role="progressbar"
                aria-label={`${name} ${limit.label} left`}
                aria-valuenow={remaining(limit)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span
                  data-low={remaining(limit) <= 15 ? '' : undefined}
                  style={{ width: `${remaining(limit)}%` }}
                />
              </div>
            ) : null}
            {limit.resetsAt ? (
              <span className="account-menu__limit-reset">Resets {resetLabel(limit.resetsAt)}</span>
            ) : null}
          </div>
        ))
      )}
    </section>
  )
}

function limitSources(state: AccountLimitsState): AccountLimitSource[] {
  const summary = state.summary
  if (!summary) return []
  return (
    summary.limitSources ?? [{ provider: state.provider, status: 'ready', limits: summary.limits }]
  )
}

function remaining(limit: Limit): number {
  return Math.min(100, Math.max(0, Math.round(100 - limit.usedPercent)))
}

/** A reset within the week reads as weekday and time; further out, as a date. */
function resetLabel(at: number): string {
  const date = new Date(at)
  const withinWeek = at - Date.now() < 6 * 86_400_000
  return date.toLocaleString(
    undefined,
    withinWeek
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' },
  )
}
