import { useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { ResultOf } from '@harness/contracts'
import { providerDisplayName, providerMark } from '../../provider-presentation.js'
import '../../styles/usage-activity.css'
import { ProviderIcon } from '../ProviderIcon.js'
import {
  activityColumns,
  ladderRungs,
  providerOrder,
  recentAverage,
  streaks,
  type ActivityColumn,
} from './usage-activity.js'
import {
  formatDays,
  formatInteger,
  formatLongDate,
  formatShortDate,
  formatTokens,
} from './usage-format.js'

type History = ResultOf<'usage.history'>

/** Rungs from the floor to the tallest column; each is a 3 px bar under a 2 px gap. */
const RUNGS = 28
const PITCH = 5

/**
 * Daily tokens as rung ladders stacked by provider, today against the last
 * week, and the streak of active days. The ladder keeps the 5 px rhythm of
 * the leader dots every other Settings row draws.
 */
export function UsageActivity(props: { data: History; periodLabel: string }) {
  const titleId = useId()
  const tooltipId = useId()
  const { data } = props
  const chart = useMemo(() => {
    const { unit, columns } = activityColumns(data.daily)
    const order = providerOrder(columns)
    const maximum = columns.reduce((value, column) => Math.max(value, column.tokens), 0)
    return {
      unit,
      columns,
      order,
      maximum,
      rungs: columns.map((column) => ladderRungs(column, maximum, RUNGS, order)),
    }
  }, [data.daily])
  const average = recentAverage(data.daily)
  const runs = streaks(data.daily)
  const today = data.daily.at(-1)?.totals.processedTokens ?? 0
  const perActiveDay = data.activeDays > 0 ? data.totals.processedTokens / data.activeDays : 0
  const [active, setActive] = useState<number>()
  const activeColumn = active === undefined ? undefined : chart.columns[active]
  const count = chart.columns.length

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return
    let next: number | undefined
    if (event.key === 'ArrowRight') next = Math.min(count - 1, (active ?? count - 2) + 1)
    else if (event.key === 'ArrowLeft') next = Math.max(0, (active ?? count) - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else if (event.key === 'Escape' && active !== undefined) next = undefined
    else return
    event.preventDefault()
    setActive(next)
  }

  const averageHeight =
    chart.unit === 'day' && average !== undefined && chart.maximum > 0
      ? (average / chart.maximum) * RUNGS * PITCH
      : undefined
  const first = chart.columns[0]
  const middle = chart.columns[Math.floor((count - 1) / 2)]
  const last = chart.columns.at(-1)

  return (
    <section className="usage-section usage-activity" aria-labelledby={titleId}>
      <header className="usage-section__head">
        <h2 className="usage-section__title" id={titleId}>
          Activity
        </h2>
        {chart.order.length > 0 ? (
          <ul className="usage-legend" aria-label="Legend">
            {chart.order.map((provider) => (
              <li data-provider={provider} key={provider}>
                <span className="usage-legend__swatch" aria-hidden />
                {providerDisplayName(provider)}
              </li>
            ))}
            {averageHeight === undefined ? null : (
              <li className="usage-legend__average">
                <span className="usage-legend__swatch" aria-hidden />
                7-day average
              </li>
            )}
          </ul>
        ) : null}
      </header>

      <dl className="usage-stats">
        <div>
          <dt>Today</dt>
          <dd>{formatTokens(today)}</dd>
          <p>{average === undefined ? 'So far' : `7-day average ${formatTokens(average)}`}</p>
        </div>
        <div>
          <dt>{props.periodLabel}</dt>
          <dd>{formatTokens(data.totals.processedTokens)}</dd>
          <p>
            {data.activeDays > 0 ? `${formatTokens(perActiveDay)} per active day` : 'No activity'}
          </p>
        </div>
        <div>
          <dt>Active days</dt>
          <dd>
            {formatInteger(data.activeDays)}
            <span className="usage-stats__of"> of {formatInteger(data.daily.length)}</span>
          </dd>
        </div>
        <div>
          <dt>Streak</dt>
          <dd>{formatDays(runs.current, runs.currentOpen)}</dd>
          <p>Longest {formatDays(runs.longest, runs.longestOpen)}</p>
        </div>
      </dl>

      <div
        className="usage-ladder"
        role="group"
        aria-label={`${chart.unit === 'week' ? 'Weekly' : 'Daily'} tokens by provider. Arrow keys step through the ${chart.unit === 'week' ? 'weeks' : 'days'}.`}
        aria-describedby={activeColumn ? tooltipId : undefined}
        tabIndex={count > 0 ? 0 : -1}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(undefined)}
        style={{ '--usage-ladder-height': `${RUNGS * PITCH}px` } as CSSProperties}
      >
        <div
          className="usage-ladder__plot"
          style={{ gridTemplateColumns: `repeat(${Math.max(count, 1)}, minmax(0, 1fr))` }}
          onPointerLeave={() => setActive(undefined)}
        >
          {chart.columns.map((column, index) => (
            <div
              className="usage-ladder__column"
              data-today={index === count - 1 ? '' : undefined}
              data-active={index === active ? '' : undefined}
              key={column.startDate}
              onPointerEnter={() => setActive(index)}
            >
              <div className="usage-ladder__bar">
                {chart.rungs[index]?.map((part) => (
                  <span
                    data-provider={part.provider}
                    key={part.provider}
                    style={{ height: `${part.rungs * PITCH}px` }}
                  />
                ))}
              </div>
            </div>
          ))}
          {averageHeight === undefined ? null : (
            <div className="usage-ladder__average" style={{ bottom: `${averageHeight}px` }} />
          )}
        </div>
        <div className="usage-ladder__axis" aria-hidden>
          <span>{first ? formatShortDate(first.startDate) : ''}</span>
          <span>{middle && count > 2 ? formatShortDate(middle.endDate) : ''}</span>
          <span>{last ? formatShortDate(last.endDate) : ''}</span>
        </div>
        {count === 0 || chart.maximum === 0 ? (
          <p className="usage-ladder__empty">No token records in this period.</p>
        ) : null}
        {activeColumn && active !== undefined ? (
          <ColumnTooltip
            id={tooltipId}
            column={activeColumn}
            unit={chart.unit}
            left={((active + 0.5) / count) * 100}
          />
        ) : null}
      </div>
    </section>
  )
}

function ColumnTooltip(props: {
  id: string
  column: ActivityColumn
  unit: 'day' | 'week'
  left: number
}) {
  const { column } = props
  const title =
    props.unit === 'week' && column.startDate !== column.endDate
      ? `${formatShortDate(column.startDate)} to ${formatLongDate(column.endDate)}`
      : formatLongDate(column.endDate)
  return (
    <div
      className="usage-ladder__tooltip"
      id={props.id}
      role="tooltip"
      data-side={props.left > 66 ? 'left' : 'right'}
      style={{ left: `${props.left}%` }}
    >
      <p className="usage-ladder__tooltip-title">{title}</p>
      <p className="usage-ladder__tooltip-total">
        {formatTokens(column.tokens)} tokens · {formatInteger(column.sessions)}{' '}
        {column.sessions === 1 ? 'session' : 'sessions'}
      </p>
      {column.providers.length > 0 ? (
        <ul>
          {column.providers.map((entry) => (
            <li data-provider={entry.provider} key={entry.provider}>
              <ProviderIcon mark={providerMark(entry.provider)} size={12} />
              <span>{providerDisplayName(entry.provider)}</span>
              <b>{formatTokens(entry.tokens)}</b>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
