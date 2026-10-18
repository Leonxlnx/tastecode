import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ProviderId, ResultOf, UsageHistoryRange } from '@harness/contracts'
import { IconChevronDown as ChevronDown, IconRefresh as RefreshCw } from '@tabler/icons-react'
import { providerDisplayName } from '../provider-presentation.js'
import '../styles/usage-page.css'
import type { Transport } from '../transport.js'
import { useUsageHistory } from '../usage-history-state.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import { readSessionClock, subscribeSessionClock } from './session-clock.js'
import { SettingsNotice, SettingsPage } from './settings/SettingsLayout.js'
import { UsageSheet } from './usage/UsageSheet.js'
import { formatInteger, formatTokens } from './usage/usage-format.js'
import {
  axisTicks,
  dayKey,
  dayText,
  deriveSheets,
  emptySheetText,
  formatValue,
  indexedAgo,
  isPartialEstimate,
  isPeriod,
  limitAlert,
  listText,
  PERIOD_OPTIONS,
  pricedShare,
  rangeText,
  sheetLimits,
  type AxisTick,
  type PeriodSlot,
  type PlanLimitsSource,
  type SheetLimits,
} from './usage/usage-sheets.js'
import { useIndexingNotice } from './usage/useIndexingNotice.js'

type History = ResultOf<'usage.history'>

const NO_LIMIT_STATES: UsageSummaryState[] = []
const noLimits = () => NO_LIMIT_STATES
const subscribeNothing = () => () => {}

/** Room kept between two axis labels, and the width of one character, in pixels. */
const LABEL_GAP = 14
const LABEL_CHAR = 7

function plural(value: number, one: string, many: string): string {
  return `${formatInteger(value)} ${value === 1 ? one : many}`
}

function slotText(slot: PeriodSlot, span: 1 | 7, referenceYear: number): string {
  return span === 1
    ? dayText(slot.start, referenceYear, true)
    : rangeText(slot.start, slot.end, referenceYear)
}

/**
 * Usage: one sheet per provider, each with its tokens over time on one shared
 * axis and height scale, its value at API prices, its plan limits and its
 * models; a limit running low is also named under the top line.
 */
export function UsageSettings(props: {
  transport: Transport
  /** The app's plan-limit owner; without one the page shows only the local history. */
  limits?: PlanLimitsSource | undefined
}) {
  const [range, setRange] = useState<UsageHistoryRange>('30d')
  const { data, loading, error, refresh } = useUsageHistory(props.transport, range)
  const indexing = useIndexingNotice(data)
  const busy = loading || data?.scan.status === 'scanning'
  const now = useSyncExternalStore(subscribeSessionClock, readSessionClock, readSessionClock)

  const source = props.limits
  const subscribe = useCallback(
    (listener: () => void) => source?.subscribe(listener) ?? (() => {}),
    [source],
  )
  const read = useCallback(() => source?.snapshot() ?? NO_LIMIT_STATES, [source])
  const states = useSyncExternalStore(
    source ? subscribe : subscribeNothing,
    source ? read : noLimits,
    source ? read : noLimits,
  )
  const limits = useMemo(() => {
    const byProvider = new Map<ProviderId, SheetLimits>()
    for (const state of states) {
      const entry = sheetLimits(state)
      if (entry) byProvider.set(state.provider, entry)
    }
    return byProvider
  }, [states])
  const { sheets, slots, span, top } = useMemo(() => deriveSheets(data, limits), [data, limits])
  const unit = span === 7 ? 'week' : 'day'

  // A hover belongs to the period it was made in.
  const [scrub, setScrub] = useState<{ range: UsageHistoryRange; index: number }>()
  const hover =
    data && scrub?.range === data.range && scrub.index < slots.length ? scrub.index : undefined
  const dataRange = data?.range
  const onHover = useCallback(
    (index: number | undefined) =>
      setScrub(
        index === undefined || dataRange === undefined ? undefined : { range: dataRange, index },
      ),
    [dataRange],
  )
  const retry = useCallback((provider: ProviderId) => source?.refresh(provider), [source])

  const [track, setTrack] = useState<HTMLDivElement | null>(null)
  const width = useWidth(track)
  const referenceYear = data ? Number(data.endDate.slice(0, 4)) : new Date(now).getFullYear()
  const hoverSlot = hover === undefined ? undefined : slots[hover]
  const startText = data ? dayText(data.startDate, referenceYear) : ''
  const endText = !data
    ? ''
    : data.endDate === dayKey(now)
      ? 'Today'
      : dayText(data.endDate, referenceYear)
  const ticks = useMemo(
    () => placeTicks(axisTicks(slots, span), slots.length, width, startText, endText),
    [slots, span, width, startText, endText],
  )
  const tickIndexes = useMemo(() => ticks.map((tick) => tick.index), [ticks])
  const alert = limitAlert(sheets, now)
  const failed = error !== undefined && data !== undefined
  const charted = data !== undefined && sheets.some((sheet) => !sheet.empty)
  const showSheets = data !== undefined || !loading

  return (
    <SettingsPage
      title="Usage"
      className={`usage-page${hover !== undefined ? ' is-scrubbing' : ''}`}
    >
      <div className="usage-page__top">
        <label className="usage-page__period">
          <span>{PERIOD_OPTIONS.find((option) => option.value === range)?.label}</span>
          <ChevronDown className="usage-page__chevron" size={14} stroke={2} aria-hidden />
          <select
            className="usage-page__period-select"
            aria-label="Period"
            value={range}
            onChange={(event) => {
              if (isPeriod(event.target.value)) setRange(event.target.value)
            }}
          >
            {PERIOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {data ? (
          <TopFacts data={data} slot={hoverSlot} span={span} referenceYear={referenceYear} />
        ) : null}
        <button
          className={`usage-page__refresh${busy ? ' is-busy' : ''}`}
          type="button"
          aria-label={failed ? 'Retry' : 'Check for new usage'}
          title={failed ? 'Retry' : 'Check for new usage'}
          disabled={busy}
          onClick={refresh}
        >
          <RefreshCw size={15} stroke={2} aria-hidden />
        </button>
      </div>

      {alert ? <p className="usage-page__alert">{alert}</p> : null}
      {indexing && data ? (
        <p className="usage-page__notice">
          Indexing local usage
          {data.scan.filesTotal > 0
            ? ` · ${formatInteger(data.scan.filesProcessed)} of ${formatInteger(data.scan.filesTotal)} files`
            : ' · finding sessions'}
          . The figures update as it goes.
        </p>
      ) : null}
      {failed ? (
        <p className="usage-page__notice is-failed" title={error}>
          The last refresh failed, so the figures are from the one before.{' '}
          <button className="usage-sheet__more usage-page__retry" type="button" onClick={refresh}>
            Try again
          </button>
        </p>
      ) : null}
      {!data && !loading ? (
        <SettingsNotice
          tone="error"
          action={
            <button className="set-button" type="button" onClick={refresh}>
              Try again
            </button>
          }
        >
          Usage could not be loaded. {error ?? 'The local session histories could not be read.'}
        </SettingsNotice>
      ) : null}

      {showSheets ? (
        <div className="usage-page__sheets">
          {charted ? (
            <div className="usage-page__axis" aria-hidden>
              <span>Tokens a {unit}</span>
              <div className="usage-page__axis-track" ref={setTrack}>
                <span className="usage-page__axis-start">{startText}</span>
                {ticks.map((tick) => (
                  <span key={tick.index} className="usage-page__axis-tick" style={{ left: tick.x }}>
                    {tick.label}
                  </span>
                ))}
                <span className="usage-page__axis-end">{endText}</span>
                {hoverSlot && hover !== undefined ? (
                  <AxisDay
                    text={slotText(hoverSlot, span, referenceYear)}
                    x={((hover + 0.5) / slots.length) * width}
                    width={width}
                  />
                ) : null}
              </div>
              <span className="usage-page__axis-end-label">At API prices</span>
            </div>
          ) : null}
          {sheets.map((sheet, index) => (
            <UsageSheet
              key={`${data?.range ?? 'none'}:${sheet.provider}`}
              sheet={sheet}
              index={index}
              top={top}
              width={width}
              unit={unit}
              ticks={tickIndexes}
              hover={hover}
              hoverTotal={hoverSlot?.tokens}
              emptyText={data ? emptySheetText(data.range) : undefined}
              now={now}
              onHover={onHover}
              onRetry={retry}
            />
          ))}
          {data && sheets.length === 0 ? (
            <p className="usage-page__empty">{emptySheetText(data.range)}.</p>
          ) : null}
        </div>
      ) : (
        <HistorySkeleton />
      )}

      {data ? <UsageClose data={data} now={now} indexing={indexing} /> : null}
    </SettingsPage>
  )
}

/** The period's figures on the top line, or the hovered day's or week's. */
function TopFacts(props: {
  data: History
  slot: PeriodSlot | undefined
  span: 1 | 7
  referenceYear: number
}) {
  const { data, slot } = props
  if (slot) {
    return (
      <span className="usage-page__facts">
        <span className="usage-page__fact is-name">
          {slotText(slot, props.span, props.referenceYear)}
        </span>
        <span className="usage-page__fact">{formatTokens(slot.tokens)} tokens</span>
        <span className="usage-page__fact">{formatValue(slot.value)}</span>
        <span className="usage-page__fact is-soft">
          {slot.sessions === undefined
            ? plural(slot.activeDays, 'active day', 'active days')
            : plural(slot.sessions, 'session', 'sessions')}
        </span>
      </span>
    )
  }
  return (
    <span className="usage-page__facts">
      <span className="usage-page__fact">{formatTokens(data.totals.processedTokens)} tokens</span>
      <span className="usage-page__fact">{formatValue(data.totals.estimatedCostUsd)}</span>
      <span className="usage-page__fact is-soft">
        {plural(data.sessionCount, 'session', 'sessions')} on {formatInteger(data.activeDays)} of{' '}
        {formatInteger(data.daily.length)} days
      </span>
    </span>
  )
}

/**
 * The axis labels that fit between its two ends, left to right, each kept
 * clear of its neighbours.
 */
function placeTicks(
  ticks: readonly AxisTick[],
  slots: number,
  width: number,
  start: string,
  end: string,
): Array<AxisTick & { x: number }> {
  if (width <= 0 || slots <= 0) return []
  const half = (label: string) => (label.length * LABEL_CHAR) / 2
  let right = start.length * LABEL_CHAR + LABEL_GAP
  const limit = width - end.length * LABEL_CHAR - LABEL_GAP
  const placed: Array<AxisTick & { x: number }> = []
  for (const tick of ticks) {
    const x = ((tick.index + 0.5) / slots) * width
    if (x - half(tick.label) < right || x + half(tick.label) > limit) continue
    placed.push({ ...tick, x })
    right = x + half(tick.label) + LABEL_GAP
  }
  return placed
}

/** The hovered date, centred on the crosshair and kept inside the track. */
function AxisDay(props: { text: string; x: number; width: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [half, setHalf] = useState(0)
  useLayoutEffect(() => {
    setHalf((ref.current?.offsetWidth ?? 0) / 2)
  }, [props.text])
  const left = Math.min(props.width - half, Math.max(half, props.x))
  return (
    <span ref={ref} className="usage-page__axis-day" style={{ left }}>
      {props.text}
    </span>
  )
}

/** Caching savings as a figure, then what the values mean and where they come from. */
function UsageClose(props: { data: History; now: number; indexing: boolean }) {
  const { data } = props
  const { totals } = data
  const priced = pricedShare(totals)
  const sources = listText(
    data.sources
      .filter((entry) => entry.available)
      .map((entry) => providerDisplayName(entry.provider)),
  )
  const histories = sources ? `the ${sources} histories` : 'the histories'
  return (
    <div className="usage-page__close">
      {totals.processedTokens > 0 ? (
        <div className="usage-page__saved">
          <span className="usage-page__saved-name">Caching saved</span>
          <span className="usage-page__saved-note">
            Without caching, these tokens would come to{' '}
            {formatValue(totals.estimatedCostUsd + totals.cacheSavingsUsd)}.
          </span>
          <span className="usage-page__saved-value">{formatValue(totals.cacheSavingsUsd)}</span>
        </div>
      ) : null}
      <div className="usage-page__notes">
        <p className="usage-page__note">
          Values are what the tokens would cost at public API list prices, not what your plans bill.{' '}
          {priced !== undefined && isPartialEstimate(totals)
            ? `Public prices cover ${Math.floor(priced * 100)}% of these tokens, so the total is a partial estimate. `
            : null}
          {data.warnings.map((warning) => `${warning} `)}≈ marks a model priced from a sibling.
        </p>
        <p className="usage-page__note">
          {props.indexing
            ? `Reading ${histories}. Figures so far are from ${plural(data.scan.filesProcessed, 'file', 'files')}.`
            : data.generatedAt > 0
              ? `Indexed ${indexedAgo(data.generatedAt, props.now)} from ${plural(data.scan.filesTotal, 'file', 'files')} in ${histories}.`
              : 'Not indexed yet.'}
        </p>
      </div>
    </div>
  )
}

/** While the first answer loads: each sheet's name and band, no numbers. */
function HistorySkeleton() {
  return (
    <div className="usage-skeleton" role="status" aria-label="Reading the usage index">
      {[0, 1, 2].map((index) => (
        <div className="usage-skeleton__sheet" key={index}>
          <span className="skeleton usage-skeleton__name" />
          <span className="skeleton usage-skeleton__band" />
        </div>
      ))}
    </div>
  )
}

/** The element's content width, kept current as the column resizes. */
function useWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!element) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return width
}
