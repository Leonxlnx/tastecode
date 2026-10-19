import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { ProviderId, ResultOf, UsageHistoryRange } from '@harness/contracts'
import { IconChevronDown as ChevronDown, IconRefresh as RefreshCw } from '@tabler/icons-react'
import { providerDisplayName } from '../provider-presentation.js'
import '../styles/usage-page.css'
import type { Transport } from '../transport.js'
import { useUsageHistory } from '../usage-history-state.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import { readSessionClock, subscribeSessionClock } from './session-clock.js'
import { SettingsNotice, SettingsPage } from './settings/SettingsLayout.js'
import type { ChartAxis } from './usage/UsageChart.js'
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
  type PeriodSlot,
  type PlanLimitsSource,
  type SheetLimits,
} from './usage/usage-sheets.js'
import { useIndexingNotice } from './usage/useIndexingNotice.js'

type History = ResultOf<'usage.history'>

const NO_LIMIT_STATES: UsageSummaryState[] = []
const noLimits = () => NO_LIMIT_STATES
const subscribeNothing = () => () => {}

function plural(value: number, one: string, many: string): string {
  return `${formatInteger(value)} ${value === 1 ? one : many}`
}

function slotText(slot: PeriodSlot, span: 1 | 7, referenceYear: number): string {
  return span === 1
    ? dayText(slot.start, referenceYear, true)
    : rangeText(slot.start, slot.end, referenceYear)
}

/**
 * Usage: the period's totals under the title, then one sheet per provider
 * with its tokens over the period, its plan limits and its models; a limit
 * running low is also named under the totals.
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
  const { sheets, slots, span } = useMemo(() => deriveSheets(data, limits), [data, limits])
  const unit = span === 7 ? 'week' : 'day'
  const retry = useCallback((provider: ProviderId) => source?.refresh(provider), [source])

  const endDate = data?.endDate
  const startDate = data?.startDate
  const today = dayKey(now)
  const axis = useMemo((): ChartAxis => {
    const referenceYear = endDate ? Number(endDate.slice(0, 4)) : new Date().getFullYear()
    return {
      slots: slots.map((slot) => slotText(slot, span, referenceYear)),
      ticks: axisTicks(slots, span),
      start: startDate ? dayText(startDate, referenceYear) : '',
      end: !endDate ? '' : endDate === today ? 'Today' : dayText(endDate, referenceYear),
    }
  }, [slots, span, startDate, endDate, today])
  const alert = limitAlert(sheets, now)
  const failed = error !== undefined && data !== undefined
  const showSheets = data !== undefined || !loading

  return (
    <SettingsPage
      title="Usage"
      className="usage-page"
      description={data ? <Totals data={data} /> : null}
      actions={
        <>
          <label className="usage-page__period">
            <span>{PERIOD_OPTIONS.find((option) => option.value === range)?.label}</span>
            <ChevronDown className="usage-page__chevron" size={13} stroke={2} aria-hidden />
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
          <button
            className={`usage-page__refresh${busy ? ' is-busy' : ''}`}
            type="button"
            aria-label={failed ? 'Retry' : 'Check for new usage'}
            title={failed ? 'Retry' : 'Check for new usage'}
            disabled={busy}
            onClick={refresh}
          >
            <RefreshCw size={14} stroke={2} aria-hidden />
          </button>
        </>
      }
    >
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
          {sheets.map((sheet, index) => (
            <UsageSheet
              key={`${data?.range ?? 'none'}:${sheet.provider}`}
              sheet={sheet}
              index={index}
              axis={axis}
              unit={unit}
              emptyText={data ? emptySheetText(data.range) : undefined}
              now={now}
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

/** The period's totals, each figure named. */
function Totals(props: { data: History }) {
  const { data } = props
  return (
    <span className="usage-page__totals">
      <span>
        <b>{formatTokens(data.totals.processedTokens)}</b> tokens
      </span>
      <span>
        <b>{formatValue(data.totals.estimatedCostUsd)}</b> at API prices
      </span>
      <span>
        <b>{formatInteger(data.sessionCount)}</b> {data.sessionCount === 1 ? 'session' : 'sessions'}{' '}
        on {formatInteger(data.activeDays)} of {plural(data.daily.length, 'day', 'days')}
      </span>
    </span>
  )
}

/** What caching saved, then what the values mean and where they come from. */
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
        <p className="usage-page__saved">
          Caching saved <b>{formatValue(totals.cacheSavingsUsd)}</b>. Without it, these tokens would
          come to {formatValue(totals.estimatedCostUsd + totals.cacheSavingsUsd)}.
        </p>
      ) : null}
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
  )
}

/** While the first answer loads: each sheet's name and chart, no numbers. */
function HistorySkeleton() {
  return (
    <div className="usage-skeleton" role="status" aria-label="Reading the usage index">
      {[0, 1, 2].map((index) => (
        <div className="usage-skeleton__sheet" key={index}>
          <span className="skeleton usage-skeleton__name" />
          <span className="skeleton usage-skeleton__chart" />
        </div>
      ))}
    </div>
  )
}
