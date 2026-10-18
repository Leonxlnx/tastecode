import { memo, useState, type CSSProperties, type ReactNode } from 'react'
import type { ProviderId, UsageHistoryModel } from '@harness/contracts'
import { providerMark } from '../../provider-presentation.js'
import { ProviderIcon } from '../ProviderIcon.js'
import { UsageBand } from './UsageBand.js'
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
 * One provider: its mark, name and figures beside its band on the shared
 * axis, its value, then its plan limits and its models, each group named in
 * the margin. A provider signed in more than once lists its accounts with
 * their limits instead. A provider without sessions in the period is one
 * quiet row and its limits.
 */
export function UsageSheet(props: {
  sheet: ProviderSheet
  index: number
  top: number
  width: number
  /** "day", or "week" on a long period. */
  unit: string
  ticks: readonly number[]
  hover: number | undefined
  /** Every provider's tokens in the hovered slot. */
  hoverTotal: number | undefined
  /** "No sessions in the last 7 days"; undefined when the history could not be read. */
  emptyText: string | undefined
  now: number
  onHover: (index: number | undefined) => void
  onRetry: (provider: ProviderId) => void
}) {
  const { sheet, hover } = props
  const retry = () => props.onRetry(sheet.provider)
  const style = { '--usage-sheet-index': props.index } as CSSProperties
  const title = (
    <div className="usage-sheet__title">
      <ProviderIcon className="usage-sheet__mark" mark={providerMark(sheet.provider)} size={20} />
      <h2 className="usage-sheet__name">{sheet.name}</h2>
    </div>
  )
  const split = sheet.accounts.length > 1
  const groups = split ? (
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

  if (sheet.empty) {
    return (
      <section className="usage-sheet is-empty" aria-label={sheet.name} style={style}>
        <div className="usage-sheet__head">
          <div className="usage-sheet__who">{title}</div>
          <p className="usage-sheet__empty">{props.emptyText}</p>
          <span />
        </div>
        {groups}
      </section>
    )
  }

  const slot = hover === undefined ? undefined : sheet.slots[hover]
  const idle = slot !== undefined && slot.tokens <= 0
  // Tokens with no value in a slot come from models without an API price, not free use.
  const unpriced = slot !== undefined && slot.tokens > 0 && slot.value <= 0
  const share =
    slot !== undefined && slot.tokens > 0 && props.hoverTotal ? slot.tokens / props.hoverTotal : 0

  return (
    <section className="usage-sheet" aria-label={sheet.name} style={style}>
      <div className="usage-sheet__head">
        <div className="usage-sheet__who">
          {title}
          <p className="usage-sheet__fact">
            {slot === undefined
              ? `${formatTokens(sheet.tokens)} tokens`
              : idle
                ? 'No use'
                : `${formatTokens(slot.tokens)} tokens`}
          </p>
          <p className="usage-sheet__fact is-soft">
            {slot === undefined ? (
              <>
                <span>{plural(sheet.sessions, 'session', 'sessions')}</span>{' '}
                <span>{plural(sheet.activeDays, 'day', 'days')}</span>
              </>
            ) : idle ? null : (
              `${Math.max(1, Math.round(share * 100))}% of the ${props.unit}`
            )}
          </p>
        </div>
        <UsageBand
          name={sheet.name}
          slots={sheet.slots}
          unit={props.unit}
          quiet={sheet.quiet}
          activeDays={sheet.activeDays}
          top={props.top}
          width={props.width}
          ticks={props.ticks}
          hover={hover}
          onHover={props.onHover}
        />
        <span className={`usage-sheet__value${idle || unpriced ? ' is-quiet' : ''}`}>
          {idle
            ? 'no use'
            : unpriced
              ? 'not priced'
              : formatValue(slot === undefined ? sheet.value : slot.value)}
        </span>
      </div>
      {groups}
      <SheetModels models={sheet.models} tokens={sheet.tokens} />
    </section>
  )
}

/** A group of rows named once in the margin. */
function SheetGroup(props: { label: string; className?: string; children: ReactNode }) {
  return (
    <div
      className={`usage-sheet__group${props.className ? ` ${props.className}` : ''}`}
      role="group"
      aria-label={props.label}
    >
      <span className="usage-sheet__group-label" aria-hidden>
        {props.label}
      </span>
      <div className="usage-sheet__rows">{props.children}</div>
    </div>
  )
}

/** One row on the sheet's sub-grid: name, a drawing, a note, and the figure at the edge. */
function SheetRow(props: {
  className?: string | undefined
  name: ReactNode
  nameTitle?: string | undefined
  graphic?: ReactNode
  aside?: ReactNode
  asideTitle?: string | undefined
  end?: ReactNode
  endClassName?: string | undefined
  endTitle?: string | undefined
}) {
  return (
    <div className={`usage-sheet__row${props.className ? ` ${props.className}` : ''}`}>
      <span className="usage-sheet__mid">
        <span className="usage-sheet__label" title={props.nameTitle}>
          {props.name}
        </span>
        <span className="usage-sheet__graphic">{props.graphic}</span>
        <span className="usage-sheet__aside" title={props.asideTitle}>
          {props.aside}
        </span>
      </span>
      <span
        className={`usage-sheet__end${props.endClassName ? ` ${props.endClassName}` : ''}`}
        title={props.endTitle}
      >
        {props.end}
      </span>
    </div>
  )
}

/** A thin bar for a share of the whole, without a track: it is a proportion, not a meter. */
function ShareBar(props: { share: number }) {
  return (
    <span
      className="usage-sheet__share"
      style={{ '--usage-share': Math.max(0, Math.min(1, props.share)) } as CSSProperties}
      aria-hidden
    />
  )
}

function SheetLimitGroup(props: {
  sheet: ProviderSheet
  now: number
  onRetry: () => void
  /** A collapsed sheet says nothing about limits it does not have. */
  quietWhenNone: boolean
}) {
  const account = props.sheet.accounts[0]
  if (!account) return null
  const { rows, status } = account.limits
  if (rows.length === 0 && !status && props.quietWhenNone) return null
  return (
    <SheetGroup label="Plan limits">
      <LimitRows sheet={props.sheet} account={account} now={props.now} onRetry={props.onRetry} />
      {rows.length === 0 && !status ? <SheetRow className="is-soft" name="None reported" /> : null}
    </SheetGroup>
  )
}

/** An account's share of the provider, then its limits indented under it. */
function AccountRows(props: {
  sheet: ProviderSheet
  account: SheetAccount
  now: number
  onRetry: () => void
}) {
  const { sheet, account } = props
  return (
    <>
      <SheetRow
        className="usage-sheet__account"
        name={account.label}
        nameTitle={account.label}
        graphic={
          account.tokens > 0 && sheet.tokens > 0 ? (
            <ShareBar share={account.tokens / sheet.tokens} />
          ) : null
        }
        aside={account.tokens > 0 ? `${formatTokens(account.tokens)} tokens` : 'No sessions'}
        end={account.tokens > 0 ? formatValue(account.value) : null}
      />
      <LimitRows sheet={sheet} account={account} now={props.now} onRetry={props.onRetry} nested />
    </>
  )
}

function LimitRows(props: {
  sheet: ProviderSheet
  account: SheetAccount
  now: number
  onRetry: () => void
  /** Under an account row. */
  nested?: boolean
}) {
  const { rows, status, retryable } = props.account.limits
  const owner =
    props.sheet.accounts.length > 1
      ? `${props.sheet.name} ${props.account.label}`
      : props.sheet.name
  const nested = props.nested ? ' is-nested' : ''
  return (
    <>
      {rows.map((limit, index) => (
        <LimitRow
          key={`${limit.label}:${index}`}
          owner={owner}
          limit={limit}
          now={props.now}
          nested={nested}
        />
      ))}
      {status ? (
        <SheetRow
          className={`usage-sheet__status${nested}`}
          name={status.label}
          graphic={
            status.detail ? <span className="usage-sheet__detail">{status.detail}</span> : null
          }
          end={
            retryable ? (
              <button className="usage-sheet__more" type="button" onClick={props.onRetry}>
                Retry
              </button>
            ) : null
          }
        />
      ) : null}
    </>
  )
}

function LimitRow(props: { owner: string; limit: SheetLimit; now: number; nested: string }) {
  const { limit } = props
  const reset = limit.resetsAt === undefined ? undefined : resetText(limit.resetsAt, props.now)
  return (
    <SheetRow
      className={`usage-sheet__limit is-${limit.state}${props.nested}`}
      name={limit.label}
      nameTitle={limit.label}
      graphic={
        limit.valueLabel === undefined ? (
          <span
            className="usage-sheet__meter"
            role="progressbar"
            aria-label={`${props.owner} ${limit.label} left`}
            aria-valuenow={limit.left}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className="usage-sheet__meter-fill"
              style={{ '--usage-sheet-left': `${limit.left}%` } as CSSProperties}
            />
          </span>
        ) : null
      }
      aside={reset?.label}
      asideTitle={reset?.title}
      end={limit.valueLabel ?? (limit.state === 'reached' ? 'Reached' : `${limit.left}% left`)}
    />
  )
}

/** The period's models: they describe the period, so a hover on the band fades them. */
const SheetModels = memo(function SheetModels(props: {
  models: UsageHistoryModel[]
  tokens: number
}) {
  const [expanded, setExpanded] = useState(false)
  const { models } = props
  if (models.length === 0) return null
  const shown = expanded ? models : models.slice(0, MODELS_SHOWN)
  const rest = models.length - MODELS_SHOWN
  return (
    <SheetGroup label="Models" className="usage-sheet__models">
      {shown.map((model) => (
        <SheetRow
          key={model.model}
          className="usage-sheet__model"
          name={model.model}
          nameTitle={model.model}
          graphic={
            props.tokens > 0 ? (
              <ShareBar share={model.totals.processedTokens / props.tokens} />
            ) : null
          }
          aside={`${formatTokens(model.totals.processedTokens)} tokens`}
          end={
            model.pricing === 'unpriced'
              ? 'not priced'
              : `${model.pricing === 'family' ? '≈ ' : ''}${formatValue(model.totals.estimatedCostUsd)}`
          }
          endClassName={model.pricing === 'unpriced' ? 'is-unpriced' : undefined}
          endTitle={
            model.pricing === 'family' ? 'Priced from a sibling model, so approximate' : undefined
          }
        />
      ))}
      {rest > 0 ? (
        <div className="usage-sheet__row usage-sheet__more-row">
          <button
            className="usage-sheet__more"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Fewer models' : `${rest} more ${rest === 1 ? 'model' : 'models'}`}
          </button>
        </div>
      ) : null}
    </SheetGroup>
  )
})
