import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type ProviderId,
  type ProviderLimitSource,
  type ResultOf,
} from '@harness/contracts'
import type { AccountLabel } from '../provider-accounts-state.js'
import { providerDisplayName, providerMark } from '../provider-presentation.js'
import { limitKey } from '../usage-limits-state.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import '../styles/account-limits.css'
import { ProviderIcon } from './ProviderIcon.js'
import { compactRelativeTime } from './session-clock.js'

/** Values older than this say how old they are; younger ones read as current. */
const AGE_SHOWN_AFTER_MS = 10 * 60_000

type Limit = ResultOf<'usage.summary'>['limits'][number]
type ConsumeReset = (
  provider: ProviderId,
  idempotencyKey: string,
  creditId?: string,
  /** Absent means the default account. */
  accountId?: AccountId,
) => Promise<ResultOf<'usage.consumeReset'>>

export type AccountLimitsState = UsageSummaryState

/**
 * Plan limits, grouped by provider account, shown as soon as the account
 * popup opens. A provider that cannot report is one quiet line in its own
 * group, never an alert: it is a missing number, not a problem the person has
 * to act on. A provider shown with more than one account names each one.
 */
export function AccountLimits(props: {
  states: AccountLimitsState[]
  /** Names a provider account; without it a further account reads as "Account". */
  accountLabel?: AccountLabel | undefined
  /** Called once while the limits are on screen; returns the release for when they leave. */
  onShow?: (() => () => void) | undefined
  onRetry: (provider: ProviderId, accountId?: AccountId) => void
  onConsumeReset?: ConsumeReset | undefined
}) {
  const panel = useRef<HTMLElement>(null)
  const onShow = useRef(props.onShow)
  // A source without plan limits is left out; one that could not be read yet is not.
  const visibleStates = props.states.filter((state) => {
    const source = limitSource(state)
    return source?.status !== 'unavailable' || source.reason === 'failed'
  })

  // The popup lands on the list itself rather than on its first Retry or Use.
  useLayoutEffect(() => panel.current?.focus(), [])
  useLayoutEffect(() => {
    onShow.current = props.onShow
  })
  // Showing the limits is what lets the server read the sources it reads only
  // on view. Once per mount, so a new callback identity does not ask again,
  // and before paint, so a source not read yet already reads as checking.
  useLayoutEffect(() => onShow.current?.(), [])

  const retry = (provider: ProviderId, accountId: AccountId | undefined) => {
    // The Retry button unmounts while the source reloads; keep focus in the popup.
    panel.current?.focus()
    // The default account is asked for as the provider alone, as before accounts.
    if (accountId === undefined) props.onRetry(provider)
    else props.onRetry(provider, accountId)
  }

  if (visibleStates.length === 0) return null
  // Ages are read when the popup opens and when the values change; nothing
  // ticks while it stays open.
  const now = Date.now()

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
          key={limitKey(state.provider, state.accountId)}
          state={state}
          name={sourceName(state, visibleStates, props.accountLabel)}
          now={now}
          onRetry={() => retry(state.provider, state.accountId)}
          onConsumeReset={props.onConsumeReset}
        />
      ))}
    </section>
  )
}

/**
 * "Codex", or "Codex · Work" once the popup shows more than one of the
 * provider's accounts or a further account alone.
 */
function sourceName(
  state: AccountLimitsState,
  shown: readonly AccountLimitsState[],
  accountLabel: AccountLabel | undefined,
): string {
  const name = providerDisplayName(state.provider)
  const further = state.accountId !== undefined && state.accountId !== DEFAULT_ACCOUNT_ID
  const siblings = shown.filter((each) => each.provider === state.provider).length
  if (!further && siblings < 2) return name
  const label = accountLabel?.(state.provider, state.accountId) ?? (further ? 'Account' : 'Default')
  return `${name} · ${label}`
}

function LimitSource(props: {
  state: AccountLimitsState
  /** The provider, and the account when the popup names it. */
  name: string
  now: number
  onRetry: () => void
  onConsumeReset?: ConsumeReset | undefined
}) {
  const titleId = useId()
  const statusId = useId()
  const source = limitSource(props.state)
  const limits = source?.status === 'ready' ? source.limits : []
  const name = props.name
  const status = sourceStatus(props.state, source, limits.length > 0, props.now)
  // Automatic retries run on their own; the button returns once they stop.
  const retrying = props.state.status !== 'ready' && props.state.retry !== undefined
  const retryable =
    !retrying &&
    (props.state.status === 'error' ||
      (props.state.status === 'ready' && source?.status === 'unavailable'))
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
        {retryable ? (
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
          accountId={props.state.accountId}
          limit={limit}
          now={props.now}
          order={index}
          onConsumeReset={props.onConsumeReset}
        />
      ))}
    </section>
  )
}

/**
 * The one muted phrase beside a provider's name, with any detail kept for
 * hover. Values that could not be refreshed say how old they are rather than
 * raising an error; values that are merely old say when they were updated.
 */
export function sourceStatus(
  state: AccountLimitsState,
  source: ProviderLimitSource | undefined,
  hasValues: boolean,
  now: number,
): { label: string; detail?: string | undefined } | undefined {
  if (state.status !== 'ready' && state.retry) {
    const { attempt, of, message } = state.retry
    return {
      label: 'Retrying…',
      detail: `Plan limits couldn’t be loaded. ${message} Trying again, ${attempt} of ${of}.`,
    }
  }
  const checkedAt = source?.status === 'ready' ? source.checkedAt : undefined
  if (state.status === 'error') {
    return hasValues
      ? {
          label: lastKnownLabel(checkedAt, now),
          detail: `Couldn’t refresh plan limits. ${state.message}`,
        }
      : { label: 'Unavailable', detail: `Plan limits couldn’t be loaded. ${state.message}` }
  }
  if (!source) return { label: 'Checking…' }
  // Only shown sources reach here unavailable: ones that could not be read yet.
  if (source.status === 'unavailable') {
    return state.status === 'loading'
      ? { label: 'Checking…' }
      : {
          label: 'Unavailable',
          detail: ['Plan limits couldn’t be loaded.', source.error].filter(Boolean).join(' '),
        }
  }
  // The server kept these values through a failed refresh and retries on its own.
  if (source.status === 'ready' && source.stale && hasValues) {
    return {
      label: lastKnownLabel(checkedAt, now),
      detail: ['Couldn’t refresh plan limits.', source.refreshError].filter(Boolean).join(' '),
    }
  }
  if (!hasValues) return { label: 'None reported', detail: 'No plan limits reported.' }
  if (checkedAt !== undefined && now - checkedAt >= AGE_SHOWN_AFTER_MS) {
    return { label: `Updated ${compactRelativeTime(checkedAt, now)} ago` }
  }
  return undefined
}

/** "Last known · 2h ago"; under a minute, or without a read time, just "Last known". */
function lastKnownLabel(checkedAt: number | undefined, now: number): string {
  if (checkedAt === undefined || now - checkedAt < 60_000) return 'Last known'
  return `Last known · ${compactRelativeTime(checkedAt, now)} ago`
}

function LimitRow(props: {
  name: string
  provider: ProviderId
  accountId?: AccountId | undefined
  limit: Limit
  now: number
  order: number
  onConsumeReset?: ConsumeReset | undefined
}) {
  const consumable = props.limit.action === 'consume-reset' && props.onConsumeReset !== undefined
  const credits = props.limit.resetCredits
  const hasSelectableCredits = credits?.some((credit) => credit.id !== undefined)
  const left = remaining(props.limit)
  const gauge = props.limit.valueLabel === undefined
  const value = props.limit.valueLabel ?? `${left}% left`
  const pace = evenPace(props.limit, props.now)

  return (
    <div
      className="account-menu__limit"
      data-gauge={gauge ? '' : undefined}
      // The bar takes its length and colour from how much is left.
      style={
        gauge ? ({ '--left': left / 100, '--order': props.order } as CSSProperties) : undefined
      }
    >
      <div className="account-menu__limit-row">
        <span className="account-menu__limit-label">{props.limit.label}</span>
        <span className="account-menu__limit-value">{value}</span>
      </div>
      {gauge ? (
        <div
          className="account-menu__limit-bar"
          role="progressbar"
          aria-label={`${props.name} ${props.limit.label} left`}
          aria-valuenow={left}
          aria-valuemin={0}
          aria-valuemax={100}
          title={
            pace === undefined
              ? undefined
              : `At an even pace, ${Math.round(pace)}% would be left now.`
          }
        >
          <span />
          {pace === undefined ? null : (
            <span className="account-menu__limit-pace" style={{ left: `${pace}%` }} />
          )}
        </div>
      ) : null}
      {props.limit.resetsAt !== undefined ? (
        <span className="account-menu__limit-reset">
          {resetLabel(props.limit.resetsAt, props.now)}
        </span>
      ) : null}
      {credits?.length ? (
        <ResetCreditExpiries
          credits={credits}
          provider={props.provider}
          accountId={props.accountId}
          now={props.now}
          onConsumeReset={consumable ? props.onConsumeReset : undefined}
        />
      ) : null}
      {consumable && !hasSelectableCredits ? (
        <ResetCreditRow
          provider={props.provider}
          accountId={props.accountId}
          onConsumeReset={props.onConsumeReset}
        >
          Next available reset
        </ResetCreditRow>
      ) : null}
    </div>
  )
}

function ResetCreditRow(props: {
  children: ReactNode
  provider: ProviderId
  accountId?: AccountId | undefined
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
      const { outcome } =
        props.accountId === undefined
          ? await props.onConsumeReset(props.provider, key, props.creditId)
          : await props.onConsumeReset(props.provider, key, props.creditId, props.accountId)
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
  accountId?: AccountId | undefined
  now: number
  onConsumeReset?: ConsumeReset | undefined
}) {
  const now = props.now
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
              accountId={props.accountId}
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

export function limitSource(state: AccountLimitsState): ProviderLimitSource | undefined {
  // Retries that all failed leave the source out, as if it reported nothing.
  if (state.status !== 'ready' && state.gaveUp)
    return { provider: state.provider, status: 'unavailable' }
  const summary = state.summary
  if (!summary) return undefined
  if (summary.limitSource) return summary.limitSource
  return summary.limits.length > 0
    ? { provider: state.provider, status: 'ready', limits: summary.limits }
    : { provider: state.provider, status: 'unavailable' }
}

export function remaining(limit: Limit): number {
  return Math.min(100, Math.max(0, Math.round(100 - limit.usedPercent)))
}

/**
 * Where the bar would end if the window were spent evenly: the share of the
 * window still ahead, in percent. Absent without a window length and reset
 * time, or when the mark would sit on the bar's rounded ends.
 */
export function evenPace(limit: Limit, now: number): number | undefined {
  if (limit.windowMinutes === undefined || limit.resetsAt === undefined) return undefined
  const ahead = ((limit.resetsAt - now) / (limit.windowMinutes * 60_000)) * 100
  return ahead >= 2 && ahead <= 98 ? ahead : undefined
}

/** A reset within the week reads as weekday and time; further out, as a date. */
function resetLabel(at: number, now: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return 'Reset time unavailable.'
  const untilReset = at - now
  const withinWeek = untilReset >= 0 && untilReset < 6 * 86_400_000
  const formatted = date.toLocaleString(
    undefined,
    withinWeek
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' },
  )
  return `Resets ${formatted}`
}
