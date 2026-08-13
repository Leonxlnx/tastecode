import { useId, useLayoutEffect, useRef } from 'react'
import type { ProviderId, ProviderLimitSource, ResultOf } from '@harness/contracts'
import { CircleAlert, Gauge, RefreshCw } from 'lucide-react'
import { providerDisplayName, providerMark } from '../provider-presentation.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import { ProviderIcon } from './ProviderIcon.js'

type Limit = ResultOf<'usage.summary'>['limits'][number]

export type AccountLimitsState = UsageSummaryState

export function AccountLimits(props: {
  states: AccountLimitsState[]
  onRetry: (provider: ProviderId) => void
}) {
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)

  useLayoutEffect(() => heading.current?.focus(), [])

  const retry = (provider: ProviderId) => {
    heading.current?.focus()
    props.onRetry(provider)
  }

  return (
    <section
      className="account-menu__usage"
      aria-labelledby={headingId}
      aria-busy={props.states.some((state) => state.status === 'loading')}
    >
      <h2 ref={heading} className="account-menu__usage-head" id={headingId} tabIndex={-1}>
        <Gauge size={14} aria-hidden />
        <span>Plan limits</span>
      </h2>

      {props.states.map((state) => (
        <LimitSource key={state.provider} state={state} onRetry={() => retry(state.provider)} />
      ))}
    </section>
  )
}

function LimitSource(props: { state: AccountLimitsState; onRetry: () => void }) {
  const titleId = useId()
  const source = limitSource(props.state)
  const hasSource = source !== undefined
  const hasUsableValues = source?.status === 'ready' && source.limits.length > 0
  const name = providerDisplayName(props.state.provider)
  return (
    <section
      className="account-menu__source"
      aria-labelledby={titleId}
      aria-busy={props.state.status === 'loading'}
    >
      <h3 id={titleId}>
        <ProviderIcon mark={providerMark(props.state.provider)} size={14} />
        {name}
      </h3>
      {!source || (props.state.status === 'error' && !hasUsableValues) ? null : source.status ===
        'unavailable' ? (
        <p className="account-menu__usage-note">Plan limits aren’t available from this source.</p>
      ) : source.limits.length === 0 ? (
        <p className="account-menu__usage-note">No plan limits reported.</p>
      ) : (
        source.limits.map((limit, index) => (
          <div className="account-menu__limit" key={`${limit.label}:${index}`}>
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
            {limit.resetsAt !== undefined ? (
              <span className="account-menu__limit-reset">{resetLabel(limit.resetsAt)}</span>
            ) : null}
          </div>
        ))
      )}
      {props.state.status === 'loading' ? (
        <p className="account-menu__usage-note" role="status">
          <RefreshCw size={13} aria-hidden />
          {hasSource ? 'Refreshing plan limits…' : 'Checking plan limits…'}
          {hasUsableValues ? ' Last known values are shown.' : null}
        </p>
      ) : null}
      {props.state.status === 'error' ? (
        <div className="account-menu__usage-error" role="alert">
          <CircleAlert size={13} aria-hidden />
          <span>
            {hasUsableValues
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

function limitSource(state: AccountLimitsState): ProviderLimitSource | undefined {
  const summary = state.summary
  if (!summary) return undefined
  if (summary.limitSource) return summary.limitSource
  return summary.limits.length > 0
    ? { provider: state.provider, status: 'ready', limits: summary.limits }
    : { provider: state.provider, status: 'unavailable' }
}

function remaining(limit: Limit): number {
  return Math.min(100, Math.max(0, Math.round(100 - limit.usedPercent)))
}

/** A reset within the week reads as weekday and time; further out, as a date. */
function resetLabel(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return 'Reset time unavailable.'
  const untilReset = at - Date.now()
  const withinWeek = untilReset >= 0 && untilReset < 6 * 86_400_000
  const formatted = date.toLocaleString(
    undefined,
    withinWeek
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' },
  )
  return `Resets ${formatted}`
}
