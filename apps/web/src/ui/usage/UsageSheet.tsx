import { memo, useState, type CSSProperties } from 'react'
import type { ProviderId, UsageHistoryModel } from '@harness/contracts'
import { providerMark } from '../../provider-presentation.js'
import { ProviderIcon } from '../ProviderIcon.js'
import { UsageBand } from './UsageBand.js'
import { formatInteger, formatTokens } from './usage-format.js'
import {
  formatValue,
  resetText,
  type ProviderSheet,
  type SheetLimit,
  type SheetLimits,
} from './usage-sheets.js'

/** Models listed before "N more models". */
const MODELS_SHOWN = 3

function plural(value: number, one: string, many: string): string {
  return `${formatInteger(value)} ${value === 1 ? one : many}`
}

/**
 * One provider: its mark and name, its daily tokens on the shared band, its
 * value, then its plan limits and its models. A provider without sessions in
 * the period is one quiet row and its limits.
 */
export function UsageSheet(props: {
  sheet: ProviderSheet
  index: number
  top: number
  width: number
  hover: number | undefined
  /** The hovered day as text, when a day is hovered. */
  hoverDay: string | undefined
  /** "No sessions in the last 7 days"; undefined when the history could not be read. */
  emptyText: string | undefined
  now: number
  onHover: (index: number | undefined) => void
  onRetry: (provider: ProviderId) => void
}) {
  const { sheet, hover } = props
  const retry = () => props.onRetry(sheet.provider)
  const style = { '--usage-sheet-index': props.index } as CSSProperties
  const who = (
    <div className="usage-sheet__who">
      <ProviderIcon className="usage-sheet__mark" mark={providerMark(sheet.provider)} size={20} />
      <h2 className="usage-sheet__name">{sheet.name}</h2>
    </div>
  )

  if (sheet.empty) {
    return (
      <section className="usage-sheet is-empty" aria-label={sheet.name} style={style}>
        <div className="usage-sheet__head">
          {who}
          <p className="usage-sheet__empty">{props.emptyText}</p>
          <span />
        </div>
        <SheetLimitRows
          name={sheet.name}
          limits={sheet.limits}
          now={props.now}
          onRetry={retry}
          quietWhenNone
        />
      </section>
    )
  }

  const day = hover === undefined ? undefined : sheet.daily[hover]
  const idle = day !== undefined && day.tokens <= 0
  const caption =
    day === undefined
      ? `${formatTokens(sheet.tokens)} tokens on ${plural(sheet.activeDays, 'day', 'days')} · ${plural(sheet.sessions, 'session', 'sessions')}${sheet.quiet ? ' · too few to rise on this scale' : ''}`
      : idle
        ? `No use on ${props.hoverDay}`
        : `${formatTokens(day.tokens)} tokens on ${props.hoverDay}`

  return (
    <section className="usage-sheet" aria-label={sheet.name} style={style}>
      <div className="usage-sheet__head">
        {who}
        <UsageBand
          name={sheet.name}
          daily={sheet.daily}
          quiet={sheet.quiet}
          activeDays={sheet.activeDays}
          top={props.top}
          width={props.width}
          hover={hover}
          onHover={props.onHover}
        />
        <span className={`usage-sheet__value${idle ? ' is-quiet' : ''}`}>
          {idle ? 'no use' : formatValue(day === undefined ? sheet.value : day.value)}
        </span>
      </div>
      <div className="usage-sheet__row usage-sheet__caption-row">
        <span />
        <p className="usage-sheet__caption">{caption}</p>
      </div>
      <SheetLimitRows name={sheet.name} limits={sheet.limits} now={props.now} onRetry={retry} />
      <SheetModels models={sheet.models} />
    </section>
  )
}

function SheetLimitRows(props: {
  name: string
  limits: SheetLimits
  now: number
  onRetry: () => void
  /** A collapsed sheet says nothing about limits it does not have. */
  quietWhenNone?: boolean
}) {
  const { rows, status, retryable } = props.limits
  return (
    <div className="usage-sheet__limits">
      {rows.map((limit, index) => (
        <LimitRow key={`${limit.label}:${index}`} name={props.name} limit={limit} now={props.now} />
      ))}
      {status ? (
        <div className="usage-sheet__row usage-sheet__status">
          <span className="usage-sheet__label">{status.label}</span>
          <span className="usage-sheet__mid">
            <span className="usage-sheet__aside is-start">{status.detail}</span>
          </span>
          {retryable ? (
            <button
              className="usage-sheet__more usage-sheet__retry"
              type="button"
              onClick={props.onRetry}
            >
              Retry
            </button>
          ) : (
            <span />
          )}
        </div>
      ) : rows.length === 0 && !props.quietWhenNone ? (
        <div className="usage-sheet__row">
          <span className="usage-sheet__label">No plan limits reported</span>
        </div>
      ) : null}
    </div>
  )
}

function LimitRow(props: { name: string; limit: SheetLimit; now: number }) {
  const { limit } = props
  const reset = limit.resetsAt === undefined ? undefined : resetText(limit.resetsAt, props.now)
  return (
    <div className={`usage-sheet__row usage-sheet__limit is-${limit.state}`}>
      <span className="usage-sheet__label">{limit.label}</span>
      <span className="usage-sheet__mid">
        {limit.valueLabel === undefined ? (
          <span
            className="usage-sheet__meter"
            role="progressbar"
            aria-label={`${props.name} ${limit.label} left`}
            aria-valuenow={limit.left}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className="usage-sheet__meter-fill"
              style={{ '--usage-sheet-left': `${limit.left}%` } as CSSProperties}
            />
          </span>
        ) : null}
        {reset ? (
          <span className="usage-sheet__aside" title={reset.title}>
            {reset.label}
          </span>
        ) : null}
      </span>
      <span className="usage-sheet__end">
        {limit.valueLabel ?? (limit.state === 'reached' ? 'Reached' : `${limit.left}% left`)}
      </span>
    </div>
  )
}

/** The period's models: they describe the period, so a day hover fades them. */
const SheetModels = memo(function SheetModels(props: { models: UsageHistoryModel[] }) {
  const [expanded, setExpanded] = useState(false)
  const { models } = props
  if (models.length === 0) return null
  const shown = expanded ? models : models.slice(0, MODELS_SHOWN)
  const rest = models.length - MODELS_SHOWN
  return (
    <div className="usage-sheet__models">
      {shown.map((model) => (
        <div className="usage-sheet__row usage-sheet__model" key={model.model}>
          <span className="usage-sheet__label" title={model.model}>
            {model.model}
          </span>
          <span className="usage-sheet__mid">
            <span className="usage-sheet__aside is-start">
              {formatTokens(model.totals.processedTokens)} tokens
            </span>
          </span>
          {model.pricing === 'unpriced' ? (
            <span className="usage-sheet__end is-unpriced">not priced</span>
          ) : (
            <span
              className="usage-sheet__end"
              title={
                model.pricing === 'family'
                  ? 'Priced from a sibling model, so approximate'
                  : undefined
              }
            >
              {model.pricing === 'family' ? '≈ ' : ''}
              {formatValue(model.totals.estimatedCostUsd)}
            </span>
          )}
        </div>
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
    </div>
  )
})
