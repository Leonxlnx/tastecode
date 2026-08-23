import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ProviderId, ProviderLimitSource, ResultOf } from '@harness/contracts'
import { CircleAlert, Gauge, RefreshCw } from 'lucide-react'
import { providerDisplayName, providerMark } from '../provider-presentation.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import { ProviderIcon } from './ProviderIcon.js'

type Limit = ResultOf<'usage.summary'>['limits'][number]
type ConsumeReset = (
  provider: ProviderId,
  idempotencyKey: string,
) => Promise<ResultOf<'usage.consumeReset'>>

export type AccountLimitsState = UsageSummaryState

export function AccountLimits(props: {
  states: AccountLimitsState[]
  onRetry: (provider: ProviderId) => void
  onConsumeReset?: ConsumeReset | undefined
}) {
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const visibleStates = props.states.filter((state) => limitSource(state)?.status !== 'unavailable')

  useLayoutEffect(() => heading.current?.focus(), [])

  const retry = (provider: ProviderId) => {
    heading.current?.focus()
    props.onRetry(provider)
  }

  if (visibleStates.length === 0) return null

  return (
    <section
      className="account-menu__usage"
      aria-labelledby={headingId}
      aria-busy={visibleStates.some((state) => state.status === 'loading')}
    >
      <h2 ref={heading} className="account-menu__usage-head" id={headingId} tabIndex={-1}>
        <Gauge size={14} aria-hidden />
        <span>Plan limits</span>
      </h2>

      {visibleStates.map((state) => (
        <LimitSource
          key={state.provider}
          state={state}
          onRetry={() => retry(state.provider)}
          onConsumeReset={props.onConsumeReset}
        />
      ))}
    </section>
  )
}

function LimitSource(props: {
  state: AccountLimitsState
  onRetry: () => void
  onConsumeReset?: ConsumeReset | undefined
}) {
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
          <LimitRow
            key={`${limit.label}:${index}`}
            name={name}
            provider={props.state.provider}
            limit={limit}
            onConsumeReset={props.onConsumeReset}
          />
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

function LimitRow(props: {
  name: string
  provider: ProviderId
  limit: Limit
  onConsumeReset?: ConsumeReset | undefined
}) {
  const row = useRef<HTMLDivElement>(null)
  const attemptKey = useRef<string | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string>()
  const consumable = props.limit.action === 'consume-reset' && props.onConsumeReset !== undefined
  const value = props.limit.valueLabel ?? `${remaining(props.limit)}% left`

  useLayoutEffect(() => {
    if (confirming && !pending) row.current?.focus()
  }, [confirming, pending])

  const cancelConfirm = () => {
    if (pending) return
    setConfirming(false)
  }

  const consume = async () => {
    if (!props.onConsumeReset || pending) return
    const key = attemptKey.current ?? crypto.randomUUID()
    attemptKey.current = key
    setPending(true)
    setMessage(undefined)
    try {
      const { outcome } = await props.onConsumeReset(props.provider, key)
      attemptKey.current = undefined
      setConfirming(false)
      if (outcome === 'nothingToReset') setMessage('Nothing needed a reset.')
      else if (outcome === 'noCredit') setMessage('No reset is available.')
      else if (outcome === 'alreadyRedeemed') setMessage('This reset was already used.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Couldn’t use the reset.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className={`account-menu__limit${consumable ? ' account-menu__limit--reset' : ''}${confirming ? ' is-confirming' : ''}`}
      ref={row}
      tabIndex={confirming ? -1 : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !confirming || pending) return
        event.preventDefault()
        event.stopPropagation()
        setConfirming(false)
      }}
    >
      <div className="account-menu__limit-row">
        {confirming ? (
          <button
            className="account-menu__limit-btn account-menu__limit-confirm"
            type="button"
            disabled={pending}
            aria-label="Confirm use rate limit reset"
            onClick={() => void consume()}
          >
            Confirm
          </button>
        ) : (
          <span className="account-menu__limit-label">{props.limit.label}</span>
        )}
        {confirming ? (
          <button
            className="account-menu__limit-btn account-menu__limit-cancel"
            type="button"
            disabled={pending}
            aria-label="Cancel using rate limit reset"
            onClick={cancelConfirm}
          >
            Cancel
          </button>
        ) : consumable ? (
          <span className="account-menu__limit-slot">
            <span className="account-menu__limit-value">{value}</span>
            <button
              className="account-menu__limit-btn account-menu__limit-use"
              type="button"
              aria-label="Use rate limit reset"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setMessage(undefined)
                setConfirming(true)
              }}
            >
              Use
            </button>
          </span>
        ) : (
          <span>{value}</span>
        )}
      </div>
      {props.limit.valueLabel === undefined ? (
        <div
          className="account-menu__limit-bar"
          role="progressbar"
          aria-label={`${props.name} ${props.limit.label} left`}
          aria-valuenow={remaining(props.limit)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            data-low={remaining(props.limit) <= 15 ? '' : undefined}
            style={{ width: `${remaining(props.limit)}%` }}
          />
        </div>
      ) : null}
      {props.limit.resetsAt !== undefined ? (
        <span className="account-menu__limit-reset">{resetLabel(props.limit.resetsAt)}</span>
      ) : null}
      {message ? (
        <span className="account-menu__limit-note" role="status">
          {message}
        </span>
      ) : null}
    </div>
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
