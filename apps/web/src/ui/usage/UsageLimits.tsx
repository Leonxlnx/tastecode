import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import type { ProviderId, ResultOf, UsageReadIntent } from '@harness/contracts'
import { providerDisplayName, providerMark } from '../../provider-presentation.js'
import '../../styles/usage-limits.css'
import type { UsageSummaryState } from '../../usage-summary-state.js'
import { evenPace, limitSource, remaining, sourceStatus } from '../AccountLimits.js'
import { ProviderIcon } from '../ProviderIcon.js'
import { readSessionClock, subscribeSessionClock } from '../session-clock.js'

type Limit = ResultOf<'usage.summary'>['limits'][number]

/** The plan limits the app keeps for every provider; the account popup reads the same owner. */
export type PlanLimitsSource = {
  snapshot(): UsageSummaryState[]
  subscribe(listener: () => void): () => void
  /** A view shows the limits until the returned release is called. */
  show(): () => void
  refresh(provider?: ProviderId, intent?: UsageReadIntent): void
}

/** At or under this share left, a window reads as running low. */
const LOW_SHARE = 15

/**
 * Plan limits first: every provider's windows with the share left, when they
 * reset and how fresh the numbers are. A provider that cannot report is one
 * quiet line with a Retry, as in the account popup.
 */
export function UsageLimits(props: { source: PlanLimitsSource }) {
  const titleId = useId()
  const { source } = props
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const read = useCallback(() => source.snapshot(), [source])
  const states = useSyncExternalStore(subscribe, read, read)
  // Countdowns move with the shared 30 s clock, which stops while the window is hidden.
  const now = useSyncExternalStore(subscribeSessionClock, readSessionClock, readSessionClock)

  // Showing the limits lets the server read sources it reads only on view.
  // Once per mount, before paint, so sources not read yet start as checking.
  const shown = useRef(source)
  shown.current = source
  useLayoutEffect(() => shown.current.show(), [])

  // A source without plan limits is left out; one that could not be read yet is not.
  const visible = states.filter((state) => {
    const limits = limitSource(state)
    return limits?.status !== 'unavailable' || limits.reason === 'failed'
  })

  return (
    <section
      className="usage-section usage-limits"
      aria-labelledby={titleId}
      aria-busy={visible.some((state) => state.status === 'loading')}
    >
      <header className="usage-section__head">
        <h2 className="usage-section__title" id={titleId}>
          Plan limits
        </h2>
      </header>
      {visible.length > 0 ? (
        visible.map((state) => (
          <LimitGroup
            key={state.provider}
            state={state}
            now={now}
            onRetry={() => source.refresh(state.provider, 'retry')}
          />
        ))
      ) : (
        <p className="usage-section__empty">None of your providers reports plan limits.</p>
      )}
    </section>
  )
}

function LimitGroup(props: { state: UsageSummaryState; now: number; onRetry: () => void }) {
  const titleId = useId()
  const statusId = useId()
  const source = limitSource(props.state)
  const limits = source?.status === 'ready' ? source.limits : []
  const name = providerDisplayName(props.state.provider)
  const status = sourceStatus(props.state, source, limits.length > 0, props.now)
  const retryable =
    props.state.status === 'error' ||
    (props.state.status === 'ready' && source?.status === 'unavailable')

  return (
    <section
      className="usage-limits__source"
      aria-labelledby={titleId}
      aria-busy={props.state.status === 'loading'}
    >
      <div className="usage-limits__head">
        <h3 className="usage-limits__name" id={titleId}>
          <ProviderIcon mark={providerMark(props.state.provider)} size={14} />
          <span>{name}</span>
        </h3>
        {status ? (
          <span className="usage-limits__status" id={statusId} title={status.detail}>
            {status.label}
            {status.detail ? <span className="visually-hidden">. {status.detail}</span> : null}
          </span>
        ) : null}
        {retryable ? (
          <button
            className="set-button set-button--quiet usage-limits__retry"
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
          key={limit.id ?? `${limit.label}:${index}`}
          name={name}
          limit={limit}
          now={props.now}
        />
      ))}
    </section>
  )
}

function LimitRow(props: { name: string; limit: Limit; now: number }) {
  const { limit } = props
  const left = remaining(limit)
  // Reached only when the provider says it is used up, not when 0.4% rounds to none.
  const blocked = limit.valueLabel === undefined && limit.usedPercent >= 100
  const pace = evenPace(limit, props.now)
  const reset = limit.resetsAt === undefined ? undefined : resetCountdown(limit.resetsAt, props.now)

  return (
    <div
      className="usage-limit"
      data-state={blocked ? 'blocked' : left <= LOW_SHARE ? 'low' : undefined}
    >
      <span className="usage-limit__label">{limit.label}</span>
      {limit.valueLabel === undefined ? (
        <>
          <div
            className="usage-meter"
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
            <span className="usage-meter__rungs" aria-hidden>
              <span
                className="usage-meter__fill"
                style={{ '--usage-meter-fill': `${left}%` } as CSSProperties}
              />
            </span>
            {pace === undefined ? null : (
              <span className="usage-meter__pace" style={{ left: `${pace}%` }} />
            )}
          </div>
          <span className="usage-limit__value">{blocked ? 'Limit reached' : `${left}% left`}</span>
        </>
      ) : (
        <span className="usage-limit__text">{limit.valueLabel}</span>
      )}
      <span className="usage-limit__reset" title={reset?.title}>
        {reset?.label}
      </span>
    </div>
  )
}

// Words in English like the rest of the page; the clock as the system shows it.
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * "Resets in 42m" and "Resets in 3h 12m" within a day, the weekday and time
 * within the week, the date after that. The exact time is kept for hover.
 */
export function resetCountdown(
  at: number,
  now: number,
): { label: string; title: string } | undefined {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return undefined
  const title = `${weekday.format(date)}, ${monthDay.format(date)}, ${clock.format(date)}`
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return { label: 'Resets now', title }
  if (minutes < 60) return { label: `Resets in ${minutes}m`, title }
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return { label: `Resets in ${hours}h${rest > 0 ? ` ${rest}m` : ''}`, title }
  }
  const label =
    at - now < 6 * 86_400_000
      ? `${weekday.format(date)} ${clock.format(date)}`
      : monthDay.format(date)
  return { label: `Resets ${label}`, title }
}
