import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type PoolWindowTotal,
  type ProviderId,
  type ResultOf,
  type UsageHistoryRange,
} from '@harness/contracts'
import { multipleText, type ProviderPool } from '../account-pool.js'
import type { AccountLabel } from '../provider-accounts-state.js'
import { providerDisplayName, providerMark } from '../provider-presentation.js'
import type { Transport } from '../transport.js'
import { useUsageHistory } from '../usage-history-state.js'
import { limitKey, USAGE_LOW_PERCENT } from '../usage-limits-state.js'
import '../styles/sheet.css'
import '../styles/usage-dialog.css'
import {
  evenPace,
  limitSource,
  remaining,
  sourceStatus,
  type AccountLimitsState,
} from './AccountLimits.js'
import { useDialogFocus } from './dialog-focus.js'
import { MaterialIcon } from './MaterialIcon.js'
import { ProviderIcon } from './ProviderIcon.js'
import { readSessionClock, subscribeSessionClock } from './session-clock.js'
import { formatInteger, formatTokens, resetText } from './usage/usage-format.js'
import {
  deriveSheets,
  emptySheetText,
  formatValue,
  markInk,
  type SheetLimits,
} from './usage/usage-sheets.js'
import { useIndexingNotice } from './usage/useIndexingNotice.js'

type Limit = ResultOf<'usage.summary'>['limits'][number]
type History = ResultOf<'usage.history'>
export type UsageView = 'limits' | 'tokens'

const VIEWS: ReadonlyArray<{ id: UsageView; label: string }> = [
  { id: 'limits', label: 'Limits' },
  { id: 'tokens', label: 'Tokens' },
]
const RANGES: ReadonlyArray<{ id: UsageHistoryRange; label: string; period: string }> = [
  { id: '7d', label: '7 days', period: 'Last 7 days' },
  { id: '30d', label: '30 days', period: 'Last 30 days' },
  { id: '90d', label: '90 days', period: 'Last 90 days' },
]
/** Models named under each provider in the Tokens view; the rest are on the Usage page. */
const MODELS_SHOWN = 3
const NO_LIMITS: ReadonlyMap<string, SheetLimits> = new Map()

/**
 * Usage over the whole window: the plan limits as one long bar per window,
 * and the tokens each provider and model used over a period, as bars against
 * the largest. The full history with its charts stays on the Usage page in
 * Settings, one click away at the foot.
 */
export function UsageDialog(props: {
  transport: Transport
  states: readonly AccountLimitsState[]
  /** Names a provider account; without it a further account reads as "Account". */
  accountLabel?: AccountLabel | undefined
  /** Each provider's accounts as one pool (account-pool.ts), shown over its accounts. */
  pools?: readonly ProviderPool[] | undefined
  /** Called once while the limits are on screen; returns the release for when they leave. */
  onShow?: (() => () => void) | undefined
  onRetry: (provider: ProviderId, accountId?: AccountId) => void
  /** Reads every plan-limit source again. */
  onRefresh: () => void
  onOpenHistory: () => void
  onClose: () => void
}) {
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)
  const titleId = useId()
  const [view, setView] = useState<UsageView>('limits')
  const [range, setRange] = useState<UsageHistoryRange>('7d')
  const now = useSyncExternalStore(subscribeSessionClock, readSessionClock, readSessionClock)
  const history = useUsageHistory(props.transport, range)

  const onShow = useRef(props.onShow)
  useLayoutEffect(() => {
    onShow.current = props.onShow
  })
  // Showing the limits is what lets the server read the sources it reads only
  // on view: once per mount, before paint, so unread sources start as checking.
  useLayoutEffect(() => onShow.current?.(), [])

  const states = useMemo(() => visibleSources(props.states), [props.states])
  const limitsBusy = states.some((state) => state.status === 'loading')
  const historyBusy = history.loading || history.data?.scan.status === 'scanning'
  const busy = view === 'limits' ? limitsBusy : historyBusy

  return createPortal(
    <div className="sheet usage-dialog-sheet" role="presentation" onKeyDown={dialog.onKeyDown}>
      <button
        className="sheet__scrim"
        type="button"
        tabIndex={-1}
        onClick={props.onClose}
        aria-label="Close usage"
      />
      <div
        className="sheet__panel usage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog.panel}
        tabIndex={-1}
      >
        <header className="usage-dialog__head">
          <div className="usage-dialog__heading">
            <h2 className="usage-dialog__title" id={titleId}>
              <MaterialIcon className="usage-dialog__title-icon" name="bar_chart" size={22} />
              Usage
            </h2>
            <p className="usage-dialog__lead">
              {view === 'limits'
                ? limitsLead(states, props.accountLabel)
                : historyLead(history.data, RANGES.find((option) => option.id === range)!.period)}
            </p>
          </div>
          <div className="usage-dialog__switch" role="group" aria-label="View">
            {VIEWS.map((option) => (
              <button
                key={option.id}
                className="usage-dialog__switch-option"
                type="button"
                aria-pressed={view === option.id}
                onClick={() => setView(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="usage-dialog__tools">
            <button
              className={`usage-dialog__icon-button${busy ? ' is-busy' : ''}`}
              type="button"
              aria-label={view === 'limits' ? 'Refresh plan limits' : 'Check for new usage'}
              title={view === 'limits' ? 'Refresh plan limits' : 'Check for new usage'}
              // Not disabled, so focus stays on it while it turns.
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return
                if (view === 'limits') props.onRefresh()
                else history.refresh()
              }}
            >
              <MaterialIcon name="refresh" size={20} />
            </button>
            <button
              className="usage-dialog__icon-button"
              type="button"
              aria-label="Close"
              title="Close"
              onClick={props.onClose}
            >
              <MaterialIcon name="close" size={20} />
            </button>
          </div>
        </header>

        <div className="usage-dialog__body">
          {view === 'limits' ? (
            <LimitsView
              states={states}
              pools={props.pools}
              accountLabel={props.accountLabel}
              now={now}
              onRetry={(state) => {
                // The Retry button unmounts while the source reloads; keep focus in the dialog.
                dialog.panel.current?.focus()
                if (state.accountId === undefined) props.onRetry(state.provider)
                else props.onRetry(state.provider, state.accountId)
              }}
            />
          ) : (
            <TokensView
              history={history}
              range={range}
              accountLabel={props.accountLabel}
              onRange={setRange}
            />
          )}
        </div>

        <footer className="usage-dialog__foot">
          <p className="usage-dialog__note">
            {view === 'limits'
              ? 'The tick on a bar is where an even pace would be by now.'
              : 'Values are what the tokens would cost at public API prices, not what your plans bill.'}
          </p>
          <button className="usage-dialog__history" type="button" onClick={props.onOpenHistory}>
            Full history in Settings
            <MaterialIcon name="chevron_right" size={18} />
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The sources worth a row: a source without plan limits is left out, one
 * that could not be read yet is not. Each provider's accounts stay together,
 * where its first one is.
 */
function visibleSources(states: readonly AccountLimitsState[]): AccountLimitsState[] {
  const visible = states.filter((state) => {
    const source = limitSource(state)
    return source?.status !== 'unavailable' || source.reason === 'failed'
  })
  const order = new Map<ProviderId, number>()
  for (const state of visible) if (!order.has(state.provider)) order.set(state.provider, order.size)
  return visible.toSorted((a, b) => (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0))
}

function further(accountId: AccountId | undefined): boolean {
  return accountId !== undefined && accountId !== DEFAULT_ACCOUNT_ID
}

/** A provider account's name; the default account reads as "Default" without a label. */
function accountNameOf(state: AccountLimitsState, label: AccountLabel | undefined): string {
  return (
    label?.(state.provider, state.accountId) ?? (further(state.accountId) ? 'Account' : 'Default')
  )
}

/** The sources grouped by provider, in the order their first account came. */
function byProvider(
  states: readonly AccountLimitsState[],
): Array<{ provider: ProviderId; states: AccountLimitsState[] }> {
  const groups: Array<{ provider: ProviderId; states: AccountLimitsState[] }> = []
  for (const state of states) {
    const group = groups.find((each) => each.provider === state.provider)
    if (group) group.states.push(state)
    else groups.push({ provider: state.provider, states: [state] })
  }
  return groups
}

function readyLimits(state: AccountLimitsState): readonly Limit[] {
  const source = limitSource(state)
  return source?.status === 'ready' ? source.limits : []
}

/** The window with the least left across every source, named under the title. */
function limitsLead(
  states: readonly AccountLimitsState[],
  label: AccountLabel | undefined,
): string {
  let lowest: { state: AccountLimitsState; limit: Limit } | undefined
  for (const state of states) {
    for (const limit of readyLimits(state)) {
      if (limit.valueLabel !== undefined) continue
      if (!lowest || remaining(limit) < remaining(lowest.limit)) lowest = { state, limit }
    }
  }
  if (!lowest) return 'Plan limits from every signed-in provider'
  const several = states.filter((state) => state.provider === lowest.state.provider).length > 1
  const owner = several
    ? `${providerDisplayName(lowest.state.provider)} · ${accountNameOf(lowest.state, label)}`
    : providerDisplayName(lowest.state.provider)
  return `Lowest: ${owner} · ${lowest.limit.label}`
}

function historyLead(data: History | undefined, period: string): string {
  if (!data) return period
  return `${period} · ${formatInteger(data.sessionCount)} ${data.sessionCount === 1 ? 'session' : 'sessions'}`
}

/**
 * One panel per provider. A provider with one account shows each window as a
 * long bar; one with several shows its pooled total as the long bars and every
 * account as a line of a table, so eight accounts are eight short lines.
 */
function LimitsView(props: {
  states: readonly AccountLimitsState[]
  pools?: readonly ProviderPool[] | undefined
  accountLabel?: AccountLabel | undefined
  now: number
  onRetry: (state: AccountLimitsState) => void
}) {
  if (props.states.length === 0) {
    return <p className="usage-dialog__empty">No signed-in provider reports plan limits yet.</p>
  }
  return (
    <div className="usage-dialog__sources">
      {byProvider(props.states).map((group) => {
        const [first] = group.states
        if (group.states.length === 1 && first) {
          return (
            <LimitSource
              key={limitKey(first.provider, first.accountId)}
              state={first}
              account={
                further(first.accountId) ? accountNameOf(first, props.accountLabel) : undefined
              }
              now={props.now}
              onRetry={() => props.onRetry(first)}
            />
          )
        }
        return (
          <AccountsSource
            key={group.provider}
            provider={group.provider}
            states={group.states}
            pool={props.pools?.find((pool) => pool.provider === group.provider)}
            accountLabel={props.accountLabel}
            now={props.now}
            onRetry={props.onRetry}
          />
        )
      })}
    </div>
  )
}

/**
 * A provider with several accounts: the pool of all of them as one long bar
 * per window, sized in the provider's cheapest plan, then a table with a line
 * per account and a short bar per window. A window an account's plan lacks is
 * a dash; the account the pool recommends for the next chat is marked.
 */
function AccountsSource(props: {
  provider: ProviderId
  states: readonly AccountLimitsState[]
  pool?: ProviderPool | undefined
  accountLabel?: AccountLabel | undefined
  now: number
  onRetry: (state: AccountLimitsState) => void
}) {
  const name = providerDisplayName(props.provider)
  // Columns: every share window an account reports, by name, in the order first seen.
  const columns: string[] = []
  for (const state of props.states) {
    for (const limit of readyLimits(state)) {
      if (limit.valueLabel === undefined && !columns.includes(limit.label)) {
        columns.push(limit.label)
      }
    }
  }
  const pool = props.pool
  const totals = pool?.windows.filter((total) => total.capacity > 0) ?? []
  const recommended = props.states.length > 1 ? pool?.recommended : undefined
  return (
    <section
      className="usage-dialog__source"
      aria-label={name}
      aria-busy={props.states.some((state) => state.status === 'loading')}
      style={{ '--usage-ink': markInk(providerMark(props.provider)) } as CSSProperties}
    >
      <div className="usage-dialog__source-head">
        <ProviderIcon
          className="usage-dialog__mark"
          mark={providerMark(props.provider)}
          size={18}
        />
        <h3 className="usage-dialog__source-name">{name}</h3>
        <span className="usage-dialog__status">{formatInteger(props.states.length)} accounts</span>
      </div>
      {pool
        ? totals.map((total) => (
            <PoolRow key={total.id} provider={name} pool={pool} total={total} now={props.now} />
          ))
        : null}
      <table className="usage-dialog__accounts">
        <thead>
          <tr>
            <th scope="col">Account</th>
            {columns.map((column) => (
              <th scope="col" key={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.states.map((state) => (
            <AccountRow
              key={limitKey(state.provider, state.accountId)}
              state={state}
              provider={name}
              account={accountNameOf(state, props.accountLabel)}
              plan={
                pool?.accounts.find(
                  (account) => account.accountId === (state.accountId ?? DEFAULT_ACCOUNT_ID),
                )?.plan
              }
              recommended={
                recommended !== undefined && recommended === (state.accountId ?? DEFAULT_ACCOUNT_ID)
              }
              columns={columns}
              now={props.now}
              onRetry={() => props.onRetry(state)}
            />
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** All of a provider's accounts in one window: how much of the pool is left. */
function PoolRow(props: {
  provider: string
  pool: ProviderPool
  total: PoolWindowTotal
  now: number
}) {
  const { pool, total } = props
  const left = Math.min(100, Math.max(0, Math.round((total.remaining / total.capacity) * 100)))
  const unit = pool.unit ? ` ${pool.unit}` : ''
  const reset =
    total.nextResetAt === undefined ? undefined : resetText(total.nextResetAt, props.now)
  const counted =
    total.accounts < pool.accounts.length
      ? `Counts ${total.accounts} of ${pool.accounts.length} accounts; a plan of unknown size stays out.`
      : undefined
  return (
    <div
      className="usage-dialog__row"
      data-low={left <= USAGE_LOW_PERCENT ? '' : undefined}
      style={{ '--left': left / 100 } as CSSProperties}
    >
      <span className="usage-dialog__row-name">
        <span className="usage-dialog__row-label">All accounts · {total.label}</span>
        <span className="usage-dialog__reset" title={counted}>
          {multipleText(total.remaining, 1)}× of {multipleText(total.capacity)}×{unit} left
        </span>
      </span>
      <span
        className="usage-dialog__bar"
        role="progressbar"
        aria-label={`${props.provider} ${total.label} left, all accounts`}
        aria-valuenow={left}
        aria-valuemin={0}
        aria-valuemax={100}
        title={reset ? `Next reset ${reset.label.replace(/^resets /, '')}` : undefined}
      >
        <span className="usage-dialog__track">
          <span className="usage-dialog__fill" />
        </span>
      </span>
      <span className="usage-dialog__amount">
        <span className="usage-dialog__figure">
          {left}
          <span className="usage-dialog__percent">%</span>
        </span>
        <span className="usage-dialog__unit">left</span>
      </span>
    </div>
  )
}

/** One account in the table: its name and plan, then a short bar per window. */
function AccountRow(props: {
  state: AccountLimitsState
  provider: string
  account: string
  plan?: string | undefined
  recommended: boolean
  columns: readonly string[]
  now: number
  onRetry: () => void
}) {
  const { state } = props
  const source = limitSource(state)
  const limits = readyLimits(state)
  const status = sourceStatus(state, source, limits.length > 0, props.now)
  const retryable =
    !(state.status !== 'ready' && state.retry !== undefined) &&
    (state.status === 'error' || (state.status === 'ready' && source?.status === 'unavailable'))
  const shares = limits.filter((limit) => limit.valueLabel === undefined)
  return (
    <tr aria-busy={state.status === 'loading'}>
      <th scope="row">
        <span className="usage-dialog__account-line">
          <span className="usage-dialog__account-name" title={props.account}>
            {props.account}
          </span>
          {props.recommended ? (
            <span
              className="usage-dialog__tag"
              title="Resets soonest and has room left, so new chats start here"
            >
              Recommended
            </span>
          ) : null}
        </span>
        <span className="usage-dialog__account-plan" title={status?.detail}>
          {[planText(props.plan), status?.label].filter(Boolean).join(' · ') || '\u00a0'}
        </span>
      </th>
      {shares.length === 0 ? (
        <td colSpan={Math.max(1, props.columns.length)}>
          {state.status === 'loading' ? (
            <span className="usage-dialog__bar is-compact is-checking" aria-hidden>
              <span className="usage-dialog__track" />
            </span>
          ) : retryable ? (
            <button className="usage-dialog__retry" type="button" onClick={props.onRetry}>
              Retry
            </button>
          ) : (
            <span className="usage-dialog__dash">—</span>
          )}
        </td>
      ) : (
        props.columns.map((column) => {
          const limit = shares.find((each) => each.label === column)
          return (
            <td key={column}>
              {limit ? (
                <AccountCell
                  name={`${props.provider} · ${props.account}`}
                  limit={limit}
                  now={props.now}
                />
              ) : (
                <span className="usage-dialog__dash" title="This plan has no such window">
                  —
                </span>
              )}
            </td>
          )
        })
      )}
    </tr>
  )
}

/** "max x5" as "Max x5": providers report plans in their own case. */
function planText(plan: string | undefined): string | undefined {
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined
}

/** One account's window: a short bar with what is left at its end, the reset under it. */
function AccountCell(props: { name: string; limit: Limit; now: number }) {
  const { limit } = props
  const left = remaining(limit)
  const reset =
    limit.resetsAt === undefined || left === 100 ? undefined : resetText(limit.resetsAt, props.now)
  return (
    <span
      className="usage-dialog__cell"
      data-low={left <= USAGE_LOW_PERCENT ? '' : undefined}
      style={{ '--left': left / 100 } as CSSProperties}
    >
      <span
        className="usage-dialog__bar is-compact"
        role="progressbar"
        aria-label={`${props.name} ${limit.label} left`}
        aria-valuenow={left}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="usage-dialog__track">
          <span className="usage-dialog__fill" />
        </span>
      </span>
      <span className="usage-dialog__cell-figure">{left}%</span>
      <span className="usage-dialog__cell-reset" title={reset?.title}>
        {reset
          ? reset.label.charAt(0).toUpperCase() + reset.label.slice(1)
          : left === 100
            ? 'Untouched'
            : '\u00a0'}
      </span>
    </span>
  )
}

/** One provider account as a panel: its name and status, then one row per window. */
function LimitSource(props: {
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
      className="usage-dialog__source"
      aria-label={name}
      aria-busy={state.status === 'loading'}
      style={{ '--usage-ink': markInk(providerMark(state.provider)) } as CSSProperties}
    >
      <div className="usage-dialog__source-head">
        <ProviderIcon
          className="usage-dialog__mark"
          mark={providerMark(state.provider)}
          size={18}
        />
        <h3 className="usage-dialog__source-name">
          {provider}
          {props.account === undefined ? null : (
            <span className="usage-dialog__account"> · {props.account}</span>
          )}
        </h3>
        {status ? (
          <span className="usage-dialog__status" id={statusId} title={status.detail}>
            {status.label}
            {status.detail ? <span className="visually-hidden">. {status.detail}</span> : null}
          </span>
        ) : null}
        {retryable ? (
          <button
            className="usage-dialog__retry"
            type="button"
            aria-describedby={status ? statusId : undefined}
            onClick={props.onRetry}
          >
            Retry
          </button>
        ) : null}
      </div>
      {checking ? (
        <div className="usage-dialog__row" aria-hidden>
          <span className="usage-dialog__row-name">
            <span className="skeleton usage-dialog__skeleton-label" />
          </span>
          <span className="usage-dialog__bar is-checking">
            <span className="usage-dialog__track" />
          </span>
          <span />
        </div>
      ) : (
        limits.map((limit, index) => (
          <LimitRow key={`${limit.label}:${index}`} name={name} limit={limit} now={props.now} />
        ))
      )}
    </section>
  )
}

/** One window: its name and reset, the long bar, and what is left as the largest figure. */
function LimitRow(props: { name: string; limit: Limit; now: number }) {
  const { limit } = props
  if (limit.valueLabel !== undefined) {
    // A reported value that is not a share (credits, a balance) has no bar to draw.
    return (
      <div className="usage-dialog__row is-text">
        <span className="usage-dialog__row-name">
          <span className="usage-dialog__row-label">{limit.label}</span>
        </span>
        <span />
        <span className="usage-dialog__value">{limit.valueLabel}</span>
      </div>
    )
  }
  const left = remaining(limit)
  const pace = evenPace(limit, props.now)
  const reset =
    limit.resetsAt === undefined || left === 100 ? undefined : resetText(limit.resetsAt, props.now)
  return (
    <div
      className="usage-dialog__row"
      data-low={left <= USAGE_LOW_PERCENT ? '' : undefined}
      style={{ '--left': left / 100 } as CSSProperties}
    >
      <span className="usage-dialog__row-name">
        <span className="usage-dialog__row-label">{limit.label}</span>
        <span className="usage-dialog__reset" title={reset?.title}>
          {reset
            ? reset.label.charAt(0).toUpperCase() + reset.label.slice(1)
            : left === 100
              ? 'Untouched'
              : 'Reset time unavailable'}
        </span>
      </span>
      <span
        className="usage-dialog__bar"
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
        <span className="usage-dialog__track">
          <span className="usage-dialog__fill" />
        </span>
        {pace === undefined ? null : (
          <span className="usage-dialog__pace" style={{ left: `${pace}%` }} />
        )}
      </span>
      <span className="usage-dialog__amount">
        <span className="usage-dialog__figure">
          {left}
          <span className="usage-dialog__percent">%</span>
        </span>
        <span className="usage-dialog__unit">left</span>
      </span>
    </div>
  )
}

function TokensView(props: {
  history: ReturnType<typeof useUsageHistory>
  range: UsageHistoryRange
  accountLabel?: AccountLabel | undefined
  onRange: (range: UsageHistoryRange) => void
}) {
  const { data, loading, error, refresh } = props.history
  const indexing = useIndexingNotice(data)
  const label = props.accountLabel
  const { sheets } = useMemo(
    () =>
      deriveSheets(
        data,
        NO_LIMITS,
        label ? (provider, accountId) => label(provider, accountId) : undefined,
      ),
    [data, label],
  )
  const used = sheets.filter((sheet) => !sheet.empty)
  const largest = Math.max(1, ...used.map((sheet) => sheet.tokens))

  return (
    <div className="usage-dialog__tokens">
      <div className="usage-dialog__tokens-head">
        <div className="usage-dialog__totals">
          <span className="usage-dialog__total">
            <span className="usage-dialog__total-label">Tokens</span>
            <span className="usage-dialog__total-value">
              {data ? formatTokens(data.totals.processedTokens) : '—'}
            </span>
          </span>
          <span className="usage-dialog__total">
            <span className="usage-dialog__total-label">At API prices</span>
            <span className="usage-dialog__total-value">
              {data ? formatValue(data.totals.estimatedCostUsd) : '—'}
            </span>
          </span>
          <span className="usage-dialog__total">
            <span className="usage-dialog__total-label">Saved by caching</span>
            <span className="usage-dialog__total-value">
              {data ? formatValue(data.totals.cacheSavingsUsd) : '—'}
            </span>
          </span>
        </div>
        <div className="usage-dialog__switch is-small" role="group" aria-label="Period">
          {RANGES.map((option) => (
            <button
              key={option.id}
              className="usage-dialog__switch-option"
              type="button"
              aria-pressed={props.range === option.id}
              onClick={() => props.onRange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {indexing && data ? (
        <p className="usage-dialog__notice">
          Indexing local usage
          {data.scan.filesTotal > 0
            ? ` · ${formatInteger(data.scan.filesProcessed)} of ${formatInteger(data.scan.filesTotal)} files`
            : ' · finding sessions'}
          . The figures update as it goes.
        </p>
      ) : null}

      {!data ? (
        loading ? (
          <div className="usage-dialog__sources" role="status" aria-label="Reading the usage index">
            {[0, 1].map((index) => (
              <div className="usage-dialog__source is-skeleton" key={index}>
                <span className="skeleton usage-dialog__skeleton-name" />
                <span className="skeleton usage-dialog__skeleton-bar" />
              </div>
            ))}
          </div>
        ) : (
          <p className="usage-dialog__empty">
            Usage could not be loaded. {error ?? 'The local session histories could not be read.'}{' '}
            <button className="usage-dialog__retry" type="button" onClick={refresh}>
              Try again
            </button>
          </p>
        )
      ) : used.length === 0 ? (
        <p className="usage-dialog__empty">{emptySheetText(props.range)}.</p>
      ) : (
        <div className="usage-dialog__sources">
          {used.map((sheet) => {
            // One model is the provider's whole use: its row carries the model's name.
            const single = sheet.models.length === 1 ? sheet.models[0] : undefined
            const models = single ? [] : sheet.models.slice(0, MODELS_SHOWN)
            return (
              <section
                key={sheet.provider}
                className="usage-dialog__source"
                aria-label={sheet.name}
                style={{ '--usage-ink': markInk(providerMark(sheet.provider)) } as CSSProperties}
              >
                <div className="usage-dialog__source-head">
                  <ProviderIcon
                    className="usage-dialog__mark"
                    mark={providerMark(sheet.provider)}
                    size={18}
                  />
                  <h3 className="usage-dialog__source-name">{sheet.name}</h3>
                  <span className="usage-dialog__status">
                    {formatInteger(sheet.sessions)} {sheet.sessions === 1 ? 'session' : 'sessions'}
                  </span>
                </div>
                <TokenRow
                  label={single?.model ?? 'All models'}
                  sub={formatValue(sheet.value)}
                  tokens={sheet.tokens}
                  share={sheet.tokens / largest}
                />
                {models.map((model) => (
                  <TokenRow
                    key={model.model}
                    label={model.model}
                    sub={
                      model.pricing === 'unpriced'
                        ? 'not priced'
                        : `${model.pricing === 'family' ? '≈ ' : ''}${formatValue(model.totals.estimatedCostUsd)}`
                    }
                    tokens={model.totals.processedTokens}
                    share={model.totals.processedTokens / largest}
                    minor
                  />
                ))}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Tokens as a bar against the period's largest provider, the figure at its end. */
function TokenRow(props: {
  label: string
  sub: string
  tokens: number
  share: number
  minor?: boolean
}) {
  return (
    <div
      className={`usage-dialog__row${props.minor ? ' is-minor' : ''}`}
      style={{ '--left': Math.min(1, Math.max(0, props.share)) } as CSSProperties}
    >
      <span className="usage-dialog__row-name">
        <span className="usage-dialog__row-label" title={props.label}>
          {props.label}
        </span>
        <span className="usage-dialog__reset">{props.sub}</span>
      </span>
      <span
        className="usage-dialog__bar"
        role="img"
        aria-label={`${props.label}: ${formatTokens(props.tokens)} tokens`}
      >
        <span className="usage-dialog__track">
          <span className="usage-dialog__fill" />
        </span>
      </span>
      <span className="usage-dialog__amount">
        <span className="usage-dialog__figure">{formatTokens(props.tokens)}</span>
        <span className="usage-dialog__unit">tokens</span>
      </span>
    </div>
  )
}
