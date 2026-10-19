import { memo, useState, type CSSProperties, type ReactNode } from 'react'
import type { ProviderId, UsageHistoryModel } from '@harness/contracts'
import { providerMark } from '../../provider-presentation.js'
import { ProviderIcon } from '../ProviderIcon.js'
import { UsageChart, type ChartAxis } from './UsageChart.js'
import { formatInteger, formatTokens } from './usage-format.js'
import {
  formatValue,
  resetText,
  type ProviderSheet,
  type SheetAccount,
  type SheetLimit,
} from './usage-sheets.js'

/** Models listed before "N more models". */
const MODELS_SHOWN = 3

function plural(value: number, one: string, many: string): string {
  return `${formatInteger(value)} ${value === 1 ? one : many}`
}

/**
 * One provider, read top to bottom: its name and totals, its tokens over the
 * period, then its plan limits beside its models. A provider signed in more
 * than once lists its accounts with their limits instead. A provider without
 * sessions in the period keeps only its name and its limits.
 */
export function UsageSheet(props: {
  sheet: ProviderSheet
  index: number
  axis: ChartAxis
  /** "day", or "week" on a long period. */
  unit: string
  /** "No sessions in the last 7 days"; undefined when the history could not be read. */
  emptyText: string | undefined
  now: number
  onRetry: (provider: ProviderId) => void
}) {
  const { sheet } = props
  const retry = () => props.onRetry(sheet.provider)
  const style = { '--usage-sheet-index': props.index } as CSSProperties
  const split = sheet.accounts.length > 1
  const limits = split ? (
    <SheetGroup label="Accounts">
      {sheet.accounts.map((account) => (
        <AccountRows
          key={account.key}
          sheet={sheet}
          account={account}
          now={props.now}
          onRetry={retry}
        />
      ))}
    </SheetGroup>
  ) : (
    <SheetLimitGroup sheet={sheet} now={props.now} onRetry={retry} quietWhenNone={sheet.empty} />
  )

  return (
    <section
      className={`usage-sheet${sheet.empty ? ' is-empty' : ''}`}
      aria-label={sheet.name}
      style={style}
    >
      <header className="usage-sheet__head">
        <ProviderIcon className="usage-sheet__mark" mark={providerMark(sheet.provider)} size={16} />
        <h2 className="usage-sheet__name">{sheet.name}</h2>
        {sheet.empty ? (
          <p className="usage-sheet__totals">{props.emptyText}</p>
        ) : (
          <p className="usage-sheet__totals">
            <span>{plural(sheet.sessions, 'session', 'sessions')}</span>
            <span>{formatTokens(sheet.tokens)} tokens</span>
            <span className="usage-sheet__total">{formatValue(sheet.value)}</span>
          </p>
        )}
      </header>
      {sheet.empty ? null : (
        <UsageChart name={sheet.name} slots={sheet.slots} axis={props.axis} unit={props.unit} />
      )}
      <div className="usage-sheet__details">
        {limits}
        {sheet.empty ? null : <SheetModels models={sheet.models} />}
      </div>
    </section>
  )
}

/** A titled run of rows. */
function SheetGroup(props: { label: string; children: ReactNode }) {
  return (
    <div className="usage-sheet__group" role="group" aria-label={props.label}>
      <h3 className="usage-sheet__group-title" aria-hidden>
        {props.label}
      </h3>
      {props.children}
    </div>
  )
}

function SheetLimitGroup(props: {
  sheet: ProviderSheet
  now: number
  onRetry: () => void
  /** A provider without sessions says nothing about limits it does not have. */
  quietWhenNone: boolean
}) {
  const account = props.sheet.accounts[0]
  if (!account) return null
  const { rows, status } = account.limits
  if (rows.length === 0 && !status && props.quietWhenNone) return null
  return (
    <SheetGroup label="Plan limits">
      <LimitRows sheet={props.sheet} account={account} now={props.now} onRetry={props.onRetry} />
      {rows.length === 0 && !status ? <p className="usage-sheet__none">None reported</p> : null}
    </SheetGroup>
  )
}

/** An account, its share of the provider, then its limits under it. */
function AccountRows(props: {
  sheet: ProviderSheet
  account: SheetAccount
  now: number
  onRetry: () => void
}) {
  const { sheet, account } = props
  return (
    <div className="usage-account">
      <div className="usage-sheet__line usage-account__line">
        <span className="usage-account__name" title={account.label}>
          {account.label}
        </span>
        <span className="usage-account__figures">
          {account.tokens > 0
            ? `${formatTokens(account.tokens)} tokens · ${formatValue(account.value)}`
            : 'No sessions'}
        </span>
      </div>
      <LimitRows sheet={sheet} account={account} now={props.now} onRetry={props.onRetry} />
    </div>
  )
}

function LimitRows(props: {
  sheet: ProviderSheet
  account: SheetAccount
  now: number
  onRetry: () => void
}) {
  const { rows, status, retryable } = props.account.limits
  const owner =
    props.sheet.accounts.length > 1
      ? `${props.sheet.name} ${props.account.label}`
      : props.sheet.name
  return (
    <>
      {rows.map((limit, index) => (
        <LimitRow key={`${limit.label}:${index}`} owner={owner} limit={limit} now={props.now} />
      ))}
      {status ? (
        <div className="usage-sheet__line usage-limit is-status">
          <span className="usage-limit__name">{status.label}</span>
          {status.detail ? (
            <span className="usage-limit__note" title={status.detail}>
              {status.detail}
            </span>
          ) : null}
          {retryable ? (
            <button
              className="usage-sheet__more usage-limit__end"
              type="button"
              onClick={props.onRetry}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/** A window's name, when it resets and what is left, over a meter of what is left. */
function LimitRow(props: { owner: string; limit: SheetLimit; now: number }) {
  const { limit } = props
  const reset = limit.resetsAt === undefined ? undefined : resetText(limit.resetsAt, props.now)
  return (
    <div className={`usage-limit is-${limit.state}`}>
      <div className="usage-sheet__line">
        <span className="usage-limit__name" title={limit.label}>
          {limit.label}
        </span>
        {reset ? (
          <span className="usage-limit__note" title={reset.title}>
            {reset.label}
          </span>
        ) : null}
        <span className="usage-limit__end">
          {limit.valueLabel ?? (limit.state === 'reached' ? 'Reached' : `${limit.left}% left`)}
        </span>
      </div>
      {limit.valueLabel === undefined ? (
        <span
          className="usage-limit__meter"
          role="progressbar"
          aria-label={`${props.owner} ${limit.label} left`}
          aria-valuenow={limit.left}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            className="usage-limit__fill"
            style={{ '--usage-limit-left': `${limit.left}%` } as CSSProperties}
          />
        </span>
      ) : null}
    </div>
  )
}

/** The period's models as a table: name, tokens and value at API prices. */
const SheetModels = memo(function SheetModels(props: { models: UsageHistoryModel[] }) {
  const [expanded, setExpanded] = useState(false)
  const { models } = props
  if (models.length === 0) return null
  const shown = expanded ? models : models.slice(0, MODELS_SHOWN)
  const rest = models.length - MODELS_SHOWN
  return (
    <div className="usage-sheet__group">
      <table className="usage-models">
        <thead>
          <tr>
            <th scope="col">Models</th>
            <th scope="col">Tokens</th>
            <th scope="col">At API prices</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((model) => (
            <tr key={model.model}>
              <td title={model.model}>{model.model}</td>
              <td>{formatTokens(model.totals.processedTokens)}</td>
              <td
                className={model.pricing === 'unpriced' ? 'is-unpriced' : undefined}
                title={
                  model.pricing === 'family'
                    ? 'Priced from a sibling model, so approximate'
                    : undefined
                }
              >
                {model.pricing === 'unpriced'
                  ? 'not priced'
                  : `${model.pricing === 'family' ? '≈ ' : ''}${formatValue(model.totals.estimatedCostUsd)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rest > 0 ? (
        <button
          className="usage-sheet__more usage-models__more"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Fewer models' : `${rest} more ${rest === 1 ? 'model' : 'models'}`}
        </button>
      ) : null}
    </div>
  )
})
