import { useId, useLayoutEffect, useRef, type CSSProperties } from 'react'
import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type ProviderId,
  type ResultOf,
} from '@harness/contracts'
import type { AccountLabel } from '../provider-accounts-state.js'
import { providerDisplayName, providerMark } from '../provider-presentation.js'
import { limitKey, USAGE_LOW_PERCENT } from '../usage-limits-state.js'
import '../styles/usage-popover.css'
import {
  evenPace,
  limitSource,
  remaining,
  sourceStatus,
  type AccountLimitsState,
} from './AccountLimits.js'
import { MaterialIcon } from './MaterialIcon.js'
import { ProviderIcon } from './ProviderIcon.js'
import { markInk } from './usage/usage-sheets.js'
import { resetText } from './usage/usage-format.js'

type Limit = ResultOf<'usage.summary'>['limits'][number]

/**
 * The usage popup the rail's usage button opens: every provider account's
 * plan limits as one large bar per window, how much is left as the figure
 * beside it, and when it resets under it. The full token history stays on
 * the Usage page, one click away at the foot.
 */
export function UsagePopover(props: {
  states: readonly AccountLimitsState[]
  /** Names a provider account; without it a further account reads as "Account". */
  accountLabel?: AccountLabel | undefined
  /** Called once while the limits are on screen; returns the release for when they leave. */
  onShow?: (() => () => void) | undefined
  onRetry: (provider: ProviderId, accountId?: AccountId) => void
  /** Reads every source again; without it the popup offers no refresh. */
  onRefresh?: (() => void) | undefined
  onOpenHistory: () => void
}) {
  const panel = useRef<HTMLElement>(null)
  const titleId = useId()
  const onShow = useRef(props.onShow)
  useLayoutEffect(() => {
    onShow.current = props.onShow
  })
  // Showing the limits is what lets the server read the sources it reads only
  // on view: once per mount, before paint, so unread sources start as checking.
  useLayoutEffect(() => onShow.current?.(), [])
  // The popup lands on itself rather than on its refresh button.
  useLayoutEffect(() => panel.current?.focus(), [])

  // A source without plan limits is left out; one that could not be read yet is not.
  const visible = props.states.filter((state) => {
    const source = limitSource(state)
    return source?.status !== 'unavailable' || source.reason === 'failed'
  })
  // Each provider's accounts stay together, where its first one is.
  const providerOrder = new Map<ProviderId, number>()
  for (const state of visible) {
    if (!providerOrder.has(state.provider)) providerOrder.set(state.provider, providerOrder.size)
  }
  const states = visible.toSorted(
    (a, b) => (providerOrder.get(a.provider) ?? 0) - (providerOrder.get(b.provider) ?? 0),
  )
  // Ages are read when the popup opens and when the values change.
  const now = Date.now()
  const busy = states.some((state) => state.status === 'loading')
  const accounts = new Map<ProviderId, number>()
  for (const state of states) accounts.set(state.provider, (accounts.get(state.provider) ?? 0) + 1)
  const accountName = (state: AccountLimitsState): string | undefined => {
    const further = state.accountId !== undefined && state.accountId !== DEFAULT_ACCOUNT_ID
    if (!further && accounts.get(state.provider) === 1) return undefined
    return (
      props.accountLabel?.(state.provider, state.accountId) ?? (further ? 'Account' : 'Default')
    )
  }

  return (
    <section
      ref={panel}
      className="usage-pop"
      aria-labelledby={titleId}
      aria-busy={busy}
      // A scroll container that keyboard users can reach and scroll.
      tabIndex={0}
    >
      <header className="usage-pop__head">
        <div className="usage-pop__heading">
          <h2 className="usage-pop__title" id={titleId}>
            Usage
          </h2>
          <p className="usage-pop__lead">Plan limits left</p>
        </div>
        {props.onRefresh ? (
          <button
            className={`usage-pop__icon-button${busy ? ' is-busy' : ''}`}
            type="button"
            aria-label="Refresh plan limits"
            title="Refresh plan limits"
            // Not disabled, so focus stays on it while it turns.
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) props.onRefresh?.()
            }}
          >
            <MaterialIcon name="refresh" size={18} />
          </button>
        ) : null}
      </header>

      <div className="usage-pop__body">
        {states.length === 0 ? (
          <p className="usage-pop__empty">No provider reports plan limits yet.</p>
        ) : (
          states.map((state) => (
            <UsageSource
              key={limitKey(state.provider, state.accountId)}
              state={state}
              account={accountName(state)}
              now={now}
              onRetry={() => {
                // The Retry button unmounts while the source reloads; keep focus in the popup.
                panel.current?.focus()
                if (state.accountId === undefined) props.onRetry(state.provider)
                else props.onRetry(state.provider, state.accountId)
              }}
            />
          ))
        )}
      </div>

      <footer className="usage-pop__foot">
        <button className="usage-pop__history" type="button" onClick={props.onOpenHistory}>
          <span>Usage history</span>
          <MaterialIcon name="chevron_right" size={18} />
        </button>
      </footer>
    </section>
  )
}

/** One provider account: its name and mark, then one large bar per window. */
function UsageSource(props: {
  state: AccountLimitsState
  account?: string | undefined
  now: number
  onRetry: () => void
}) {
  const statusId = useId()
  const { state } = props
  const source = limitSource(state)
  const limits = source?.status === 'ready' ? source.limits : []
  const status = sourceStatus(state, source, limits.length > 0, props.now)
  // Automatic retries run on their own; the button returns once they stop.
  const retryable =
    !(state.status !== 'ready' && state.retry !== undefined) &&
    (state.status === 'error' || (state.status === 'ready' && source?.status === 'unavailable'))
  const provider = providerDisplayName(state.provider)
  const name = props.account === undefined ? provider : `${provider} · ${props.account}`
  const checking = limits.length === 0 && state.status === 'loading'

  return (
    <section
      className="usage-pop__source"
      aria-label={name}
      aria-busy={state.status === 'loading'}
      style={{ '--usage-ink': markInk(providerMark(state.provider)) } as CSSProperties}
    >
      <div className="usage-pop__source-head">
        <ProviderIcon className="usage-pop__mark" mark={providerMark(state.provider)} size={16} />
        <h3 className="usage-pop__source-name">
          {provider}
          {props.account === undefined ? null : (
            <span className="usage-pop__account"> · {props.account}</span>
          )}
        </h3>
        {status ? (
          <span className="usage-pop__status" id={statusId} title={status.detail}>
            {status.label}
            {status.detail ? <span className="visually-hidden">. {status.detail}</span> : null}
          </span>
        ) : null}
        {retryable ? (
          <button
            className="usage-pop__retry"
            type="button"
            aria-describedby={status ? statusId : undefined}
            onClick={props.onRetry}
          >
            Retry
          </button>
        ) : null}
      </div>
      {checking ? (
        <div className="usage-pop__bar is-checking" aria-hidden>
          <span className="usage-pop__track" />
        </div>
      ) : (
        limits.map((limit, index) => (
          <UsageLimit key={`${limit.label}:${index}`} name={name} limit={limit} now={props.now} />
        ))
      )}
    </section>
  )
}

/** One window: its name and what is left as a large figure, the bar, then the reset. */
function UsageLimit(props: { name: string; limit: Limit; now: number }) {
  const { limit } = props
  // A reported value that is not a share (credits, a balance) has no bar to draw.
  if (limit.valueLabel !== undefined) {
    return (
      <div className="usage-pop__limit">
        <div className="usage-pop__limit-row">
          <span className="usage-pop__limit-label">{limit.label}</span>
          <span className="usage-pop__value">{limit.valueLabel}</span>
        </div>
      </div>
    )
  }
  const left = remaining(limit)
  const low = left <= USAGE_LOW_PERCENT
  const pace = evenPace(limit, props.now)
  const reset =
    limit.resetsAt === undefined || left === 100 ? undefined : resetText(limit.resetsAt, props.now)
  return (
    <div
      className="usage-pop__limit"
      data-low={low ? '' : undefined}
      style={{ '--left': left / 100 } as CSSProperties}
    >
      <div className="usage-pop__limit-row">
        <span className="usage-pop__limit-label">{limit.label}</span>
        <span className="usage-pop__amount">
          <span className="usage-pop__figure">
            {left}
            <span className="usage-pop__percent">%</span>
          </span>
          <span className="usage-pop__figure-unit">left</span>
        </span>
      </div>
      <div
        className="usage-pop__bar"
        role="progressbar"
        aria-label={`${props.name} ${limit.label} left`}
        aria-valuenow={left}
        aria-valuemin={0}
        aria-valuemax={100}
        title={
          pace === undefined
            ? undefined
            : `At an even pace, ${Math.round(pace)}% would be left now.`
        }
      >
        <span className="usage-pop__track">
          <span className="usage-pop__fill" />
        </span>
        {pace === undefined ? null : (
          <span className="usage-pop__pace" style={{ left: `${pace}%` }} />
        )}
      </div>
      {reset ? (
        <span className="usage-pop__reset" title={reset.title}>
          {reset.label.charAt(0).toUpperCase() + reset.label.slice(1)}
        </span>
      ) : null}
    </div>
  )
}
