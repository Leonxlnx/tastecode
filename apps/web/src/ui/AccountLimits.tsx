import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ProviderId, ProviderLimitSource, ResultOf } from '@harness/contracts'
import { providerDisplayName, providerMark } from '../provider-presentation.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import '../styles/account-limits.css'
import { ProviderIcon } from './ProviderIcon.js'

type Limit = ResultOf<'usage.summary'>['limits'][number]
type ConsumeReset = (
  provider: ProviderId,
  idempotencyKey: string,
  creditId?: string,
) => Promise<ResultOf<'usage.consumeReset'>>

export type AccountLimitsState = UsageSummaryState

/**
 * Plan limits, grouped by provider, shown as soon as the account popup opens.
 * A provider that cannot report is one quiet line in its own group, never an
 * alert: it is a missing number, not a problem the person has to act on.
 */
export function AccountLimits(props: {
  states: AccountLimitsState[]
  onRetry: (provider: ProviderId) => void
  onConsumeReset?: ConsumeReset | undefined
}) {
  const panel = useRef<HTMLElement>(null)
  const visibleStates = props.states.filter((state) => limitSource(state)?.status !== 'unavailable')

  // The popup lands on the list itself rather than on its first Retry or Use.
  useLayoutEffect(() => panel.current?.focus(), [])

  const retry = (provider: ProviderId) => {
    // The Retry button unmounts while the source reloads; keep focus in the popup.
    panel.current?.focus()
    props.onRetry(provider)
  }

  if (visibleStates.length === 0) return null

  return (
    <section
      ref={panel}
      className="account-menu__usage"
      aria-label="Plan limits"
      aria-busy={visibleStates.some((state) => state.status === 'loading')}
      // A scroll container that keyboard users can reach and scroll.
      tabIndex={0}
    >
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
  const statusId = useId()
  const source = limitSource(props.state)
  const limits = source?.status === 'ready' ? source.limits : []
  const name = providerDisplayName(props.state.provider)
  const status = sourceStatus(props.state, source, limits.length > 0)
  return (
    <section
      className="account-menu__source"
      aria-labelledby={titleId}
      aria-busy={props.state.status === 'loading'}
    >
      <div className="account-menu__source-head">
        <h3 id={titleId}>
          <ProviderIcon mark={providerMark(props.state.provider)} size={14} />
          <span>{name}</span>
        </h3>
        {status ? (
          <span className="account-menu__source-status" id={statusId} title={status.detail}>
            {status.label}
            {status.detail ? <span className="visually-hidden">. {status.detail}</span> : null}
          </span>
        ) : null}
        {props.state.status === 'error' ? (
          <button
            className="account-menu__retry"
            type="button"
            aria-describedby={statusId}
            onClick={props.onRetry}
          >
            Retry
          </button>
        ) : null}
      </div>
      {limits.map((limit, index) => (
        <LimitRow
          key={`${limit.label}:${index}`}
          name={name}
          provider={props.state.provider}
          limit={limit}
          onConsumeReset={props.onConsumeReset}
        />
      ))}
    </section>
  )
}

/** The one muted word beside a provider's name, with any detail kept for hover. */
function sourceStatus(
  state: AccountLimitsState,
  source: ProviderLimitSource | undefined,
  hasValues: boolean,
): { label: string; detail?: string | undefined } | undefined {
  if (state.status === 'error') {
    return hasValues
      ? { label: 'Last known', detail: `Couldn’t refresh plan limits. ${state.message}` }
      : { label: 'Unavailable', detail: `Plan limits couldn’t be loaded. ${state.message}` }
  }
  if (!source) return { label: 'Checking…' }
  if (!hasValues) return { label: 'None reported', detail: 'No plan limits reported.' }
  return undefined
}

function LimitRow(props: {
  name: string
  provider: ProviderId
  limit: Limit
  onConsumeReset?: ConsumeReset | undefined
}) {
  const consumable = props.limit.action === 'consume-reset' && props.onConsumeReset !== undefined
  const credits = props.limit.resetCredits
  const hasSelectableCredits = credits?.some((credit) => credit.id !== undefined)
  const value = props.limit.valueLabel ?? `${remaining(props.limit)}% left`

  return (
    <div className="account-menu__limit">
      <div className="account-menu__limit-row">
        <span className="account-menu__limit-label">{props.limit.label}</span>
        <span className="account-menu__limit-value">{value}</span>
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
      {credits?.length ? (
        <ResetCreditExpiries
          credits={credits}
          provider={props.provider}
          onConsumeReset={consumable ? props.onConsumeReset : undefined}
        />
      ) : null}
      {consumable && !hasSelectableCredits ? (
        <ResetCreditRow provider={props.provider} onConsumeReset={props.onConsumeReset}>
          Next available reset
        </ResetCreditRow>
      ) : null}
    </div>
  )
}

function ResetCreditRow(props: {
  children: ReactNode
  provider: ProviderId
  creditId?: string | undefined
  onConsumeReset?: ConsumeReset | undefined
}) {
  const row = useRef<HTMLDivElement>(null)
  const expiryId = useId()
  const attemptKey = useRef<string | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string>()

  useLayoutEffect(() => {
    if (confirming && !pending) row.current?.focus()
  }, [confirming, pending])

  const consume = async () => {
    if (!props.onConsumeReset || pending) return
    const key = attemptKey.current ?? crypto.randomUUID()
    attemptKey.current = key
    setPending(true)
    setMessage(undefined)
    try {
      const { outcome } = await props.onConsumeReset(props.provider, key, props.creditId)
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
      className={`account-menu__reset-credit${confirming ? ' is-confirming' : ''}`}
      ref={row}
      tabIndex={confirming ? -1 : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !confirming || pending) return
        event.preventDefault()
        event.stopPropagation()
        setConfirming(false)
      }}
    >
      <span className="account-menu__reset-expiry" id={expiryId}>
        {props.children}
      </span>
      {confirming ? (
        <>
          <button
            className="account-menu__limit-btn account-menu__limit-confirm"
            type="button"
            disabled={pending || !props.onConsumeReset}
            aria-label="Confirm use rate limit reset"
            aria-describedby={expiryId}
            onClick={() => void consume()}
          >
            {pending ? 'Using…' : 'Confirm'}
          </button>
          <button
            className="account-menu__limit-btn account-menu__limit-cancel"
            type="button"
            disabled={pending}
            aria-label="Cancel using rate limit reset"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </>
      ) : props.onConsumeReset ? (
        <button
          className="account-menu__limit-btn account-menu__limit-use"
          type="button"
          aria-label="Use rate limit reset"
          aria-describedby={expiryId}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setMessage(undefined)
            setConfirming(true)
          }}
        >
          Use
        </button>
      ) : null}
      {message ? (
        <span className="account-menu__limit-note" role="status">
          {message}
        </span>
      ) : null}
    </div>
  )
}

function ResetCreditExpiries(props: {
  credits: NonNullable<Limit['resetCredits']>
  provider: ProviderId
  onConsumeReset?: ConsumeReset | undefined
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const ordered = [...props.credits].sort(
    (a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity),
  )
  return (
    <ul className="account-menu__reset-expiries" aria-label="Rate limit reset expiries">
      {ordered.map(({ id, expiresAt }, index) => {
        const date = expiresAt === null ? undefined : new Date(expiresAt)
        const validDate = date && !Number.isNaN(date.getTime()) ? date : undefined
        const untilExpiry = expiresAt === null ? Infinity : expiresAt - now
        const usable = id !== undefined && (expiresAt === null || (validDate && untilExpiry > 0))
        return (
          <li key={id ?? `${expiresAt}:${index}`}>
            <ResetCreditRow
              provider={props.provider}
              creditId={id}
              onConsumeReset={usable ? props.onConsumeReset : undefined}
            >
              {validDate ? (
                <time
                  dateTime={validDate.toISOString()}
                  data-expiring-soon={untilExpiry > 0 && untilExpiry < 86_400_000 ? '' : undefined}
                >
                  {untilExpiry <= 0 ? 'Expired' : 'Expires'}{' '}
                  {validDate.toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}{' '}
                  <span className="account-menu__reset-time">
                    {validDate.toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </time>
              ) : expiresAt === null ? (
                'No expiry'
              ) : (
                'Expiry date unavailable'
              )}
            </ResetCreditRow>
          </li>
        )
      })}
    </ul>
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
