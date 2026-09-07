import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type {
  ProviderId,
  ResultOf,
  UsageHistoryDay,
  UsageHistoryRange,
  UsageHistoryTotals,
} from '@harness/contracts'
import {
  IconAlertCircle as CircleAlert,
  IconCalendarMonth as CalendarDays,
  IconRefresh as RefreshCw,
} from '@tabler/icons-react'
import { providerPresentation } from '../provider-presentation.js'
import type { Transport } from '../transport.js'
import { SourceIdentity } from './SourceIdentity.js'

const RANGE_OPTIONS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '1 year' },
  { value: 'all', label: 'All' },
] as const satisfies ReadonlyArray<{ value: UsageHistoryRange; label: string }>

const number = new Intl.NumberFormat('en-US')
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function UsageSettings(props: { transport: Transport }) {
  const [range, setRange] = useState<UsageHistoryRange>('30d')
  const [data, setData] = useState<ResultOf<'usage.history'>>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [requestVersion, setRequestVersion] = useState(0)
  const forceRefresh = useRef(false)
  const scanInProgress = useRef(false)

  useEffect(() => {
    let active = true
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const refresh = forceRefresh.current
    forceRefresh.current = false
    setLoading(true)
    setError(undefined)
    void props.transport
      .request('usage.history', { range, ...(refresh ? { refresh: true } : {}) })
      .then((result) => {
        if (!active) return
        setData(result)
        scanInProgress.current = result.scan.status === 'scanning'
      })
      .catch((requestError: unknown) => {
        if (!active) return
        setError(requestError instanceof Error ? requestError.message : String(requestError))
      })
      .finally(() => {
        if (active) {
          setLoading(false)
          if (scanInProgress.current) {
            pollTimer = setTimeout(() => {
              if (active) setRequestVersion((version) => version + 1)
            }, 500)
          }
        }
      })
    return () => {
      active = false
      clearTimeout(pollTimer)
    }
  }, [props.transport, range, requestVersion])

  const refresh = useCallback(() => {
    forceRefresh.current = true
    setRequestVersion((version) => version + 1)
  }, [])

  if (!data && loading) {
    return (
      <section className="usage-page usage-page--loading" aria-live="polite">
        <div className="usage-page__loading-mark" aria-hidden />
        <h1>Loading cached usage</h1>
      </section>
    )
  }

  if (!data) {
    return (
      <section className="usage-page usage-page--error" role="alert">
        <CircleAlert size={20} aria-hidden />
        <h1>Usage could not be loaded</h1>
        <p>{error ?? 'The local session histories could not be read.'}</p>
        <button type="button" onClick={refresh}>
          Try again
        </button>
      </section>
    )
  }

  const scanning = data.scan.status === 'scanning'

  return (
    <section
      className={`usage-page${loading || scanning ? ' is-refreshing' : ''}`}
      aria-labelledby="usage-title"
    >
      <header className="usage-page__header">
        <div>
          <h1 id="usage-title">Usage</h1>
          <p>
            {formatInteger(data.sessionCount)} {data.sessionCount === 1 ? 'session' : 'sessions'} ·{' '}
            {formatDateRange(data.startDate, data.endDate)}
          </p>
        </div>
        <div className="usage-page__range" aria-label="Usage period">
          <div className="usage-segmented" role="radiogroup" aria-label="Usage period">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={range === option.value}
                className={range === option.value ? 'is-selected' : ''}
                onClick={() => setRange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            className="usage-page__refresh"
            type="button"
            aria-label="Check for new usage"
            title="Check for new usage"
            disabled={loading || scanning}
            onClick={refresh}
          >
            <RefreshCw size={14} aria-hidden />
          </button>
        </div>
      </header>

      {scanning ? (
        <div className="usage-page__notice usage-page__notice--scan" role="status">
          <RefreshCw size={14} aria-hidden />
          <span>
            Indexing local usage in the background
            {data.scan.filesTotal > 0
              ? ` · ${formatInteger(data.scan.filesProcessed)} of ${formatInteger(data.scan.filesTotal)} files`
              : ' · discovering sessions'}
            . This page stays usable and updates automatically.
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="usage-page__notice" role="status">
          <CircleAlert size={14} aria-hidden />
          The refresh failed, so the last completed scan is still shown. {error}
        </div>
      ) : null}

      <div className="usage-overview">
        <CostSummary data={data} />
        <MetricStrip data={data} />
      </div>

      <DailyUsageChart data={data} />
      <UsageBreakdown data={data} />

      {data.warnings.length > 0 ? (
        <div className="usage-page__warnings">
          {data.warnings.map((warning) => (
            <p key={warning}>
              <CircleAlert size={13} aria-hidden />
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <p className="usage-page__source-note">
        Estimated from local provider histories and Harness usage records. This is API-equivalent
        token cost, not your subscription bill.
      </p>
    </section>
  )
}

function CostSummary(props: { data: ResultOf<'usage.history'> }) {
  const totalCost = props.data.totals.estimatedCostUsd
  return (
    <section className="usage-cost" aria-labelledby="usage-cost-title">
      <p className="usage-eyebrow" id="usage-cost-title">
        Estimated API cost
      </p>
      <p className="usage-cost__value">{formatMoney(totalCost)}</p>
      <p className="usage-cost__caption">At current public model rates</p>

      <div className="usage-cost__providers">
        {props.data.providers.length > 0 ? (
          props.data.providers.map((provider) => {
            const share = totalCost > 0 ? provider.totals.estimatedCostUsd / totalCost : 0
            return (
              <div
                className="usage-provider"
                data-provider={provider.provider}
                key={provider.provider}
              >
                <div className="usage-provider__heading">
                  <SourceIdentity presentation={providerPresentation(provider.provider)} />
                  <strong>{formatMoney(provider.totals.estimatedCostUsd)}</strong>
                </div>
                <div className="usage-provider__track" aria-hidden>
                  <span style={{ width: `${Math.max(share * 100, share > 0 ? 0.5 : 0)}%` }} />
                </div>
                <p>
                  {formatPercent(share)} of cost · {formatTokens(provider.totals.processedTokens)}
                </p>
              </div>
            )
          })
        ) : (
          <p className="usage-cost__empty">No token records in this period.</p>
        )}
      </div>
    </section>
  )
}

function MetricStrip(props: { data: ResultOf<'usage.history'> }) {
  const totals = props.data.totals
  const hitRate = cacheHitRate(totals)
  const perActiveDay =
    props.data.activeDays > 0 ? totals.processedTokens / props.data.activeDays : 0
  const savingsMultiple =
    totals.estimatedCostUsd > 0 ? totals.cacheSavingsUsd / totals.estimatedCostUsd : 0
  return (
    <section className="usage-metrics" aria-label="Token totals">
      <Metric
        id="processed"
        label="Processed tokens"
        value={formatTokens(totals.processedTokens)}
        detail={`${formatTokens(perActiveDay)} per active day`}
        providers={metricProviderDetails(
          props.data.providers,
          (providerTotals) => providerTotals.processedTokens,
          formatTokens,
        )}
      />
      <Metric
        id="cached"
        label="Cached input"
        value={formatTokens(totals.cachedInputTokens)}
        detail={
          hitRate === undefined ? 'No observed input' : `${formatPercent(hitRate)} cache hit rate`
        }
        providers={metricProviderDetails(
          props.data.providers,
          (providerTotals) => providerTotals.cachedInputTokens,
          formatTokens,
        )}
      />
      <Metric
        id="uncached"
        label="Uncached input"
        value={formatTokens(totals.uncachedInputTokens)}
        detail={`${formatTokens(totals.cacheWriteInputTokens)} cache writes`}
        providers={metricProviderDetails(
          props.data.providers,
          (providerTotals) => providerTotals.uncachedInputTokens,
          formatTokens,
        )}
      />
      <Metric
        id="output"
        label="Output"
        value={formatTokens(totals.outputTokens)}
        detail={`includes ${formatTokens(totals.reasoningTokens)} reasoning`}
        providers={metricProviderDetails(
          props.data.providers,
          (providerTotals) => providerTotals.outputTokens,
          formatTokens,
        )}
      />
      <Metric
        id="savings"
        label="Cache savings"
        value={formatMoney(totals.cacheSavingsUsd)}
        detail={`${formatDecimal(savingsMultiple)}× the raw token cost`}
        providers={metricProviderDetails(
          props.data.providers,
          (providerTotals) => providerTotals.cacheSavingsUsd,
          formatMoney,
        )}
      />
    </section>
  )
}

type MetricProviderDetail = {
  provider: ProviderId
  value: string
  share: string
}

function Metric(props: {
  id: string
  label: string
  value: string
  detail: string
  providers: ReadonlyArray<MetricProviderDetail>
}) {
  const tooltipId = `usage-metric-${props.id}-details`
  return (
    <div
      className="usage-metric"
      tabIndex={0}
      aria-label={`${props.label}: ${props.value}. ${props.detail}`}
      aria-describedby={tooltipId}
    >
      <p>{props.label}</p>
      <strong>{props.value}</strong>
      <span>{props.detail}</span>
      <div className="usage-metric__tooltip" id={tooltipId} role="tooltip">
        <div className="usage-metric__tooltip-heading">
          <strong>{props.label} by provider</strong>
          <span>Value · share</span>
        </div>
        {props.providers.length > 0 ? (
          <ul>
            {props.providers.map((provider) => (
              <li data-provider={provider.provider} key={provider.provider}>
                <span className="usage-metric__provider-name">
                  <SourceIdentity
                    presentation={providerPresentation(provider.provider)}
                    density="compact"
                  />
                </span>
                <span className="usage-metric__provider-value">
                  <b>{provider.value}</b>
                  <small>{provider.share}</small>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="usage-metric__tooltip-empty">No provider usage in this period.</p>
        )}
      </div>
    </div>
  )
}

function metricProviderDetails(
  providers: ResultOf<'usage.history'>['providers'],
  valueFor: (totals: UsageHistoryTotals) => number,
  formatValue: (value: number) => string,
): ReadonlyArray<MetricProviderDetail> {
  const values = providers.map((provider) => ({
    provider: provider.provider,
    rawValue: valueFor(provider.totals),
  }))
  const total = values.reduce((sum, provider) => sum + provider.rawValue, 0)
  return values
    .toSorted((left, right) => right.rawValue - left.rawValue)
    .map((provider) => ({
      provider: provider.provider,
      value: formatValue(provider.rawValue),
      share: total > 0 ? formatPercent(provider.rawValue / total) : '—',
    }))
}

function DailyUsageChart(props: { data: ResultOf<'usage.history'> }) {
  const [mode, setMode] = useState<'cost' | 'tokens'>('cost')
  const [hoveredIndex, setHoveredIndex] = useState<number>()
  const chart = useMemo(() => buildChart(props.data, mode), [props.data, mode])

  const updateHover = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (props.data.daily.length === 0) return
      const bounds = event.currentTarget.getBoundingClientRect()
      const svgX = ((event.clientX - bounds.left) / bounds.width) * CHART_WIDTH
      const ratio = Math.min(Math.max((svgX - CHART_LEFT) / CHART_PLOT_WIDTH, 0), 1)
      setHoveredIndex(Math.round(ratio * Math.max(props.data.daily.length - 1, 0)))
    },
    [props.data.daily.length],
  )
  const clearHover = useCallback(() => setHoveredIndex(undefined), [])
  const hoveredDay = hoveredIndex === undefined ? undefined : props.data.daily[hoveredIndex]
  const hoverLeft =
    hoveredIndex === undefined || props.data.daily.length <= 1
      ? CHART_LEFT
      : CHART_LEFT + (hoveredIndex / (props.data.daily.length - 1)) * CHART_PLOT_WIDTH

  return (
    <section className="usage-chart" aria-labelledby="daily-usage-title">
      <header className="usage-chart__header">
        <h2 id="daily-usage-title">{mode === 'cost' ? 'Cost' : 'Tokens'} over time</h2>
        <div className="usage-chart__controls">
          <div
            className="usage-segmented usage-segmented--small"
            role="radiogroup"
            aria-label="Chart value"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'cost'}
              className={mode === 'cost' ? 'is-selected' : ''}
              onClick={() => setMode('cost')}
            >
              Cost
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'tokens'}
              className={mode === 'tokens' ? 'is-selected' : ''}
              onClick={() => setMode('tokens')}
            >
              Tokens
            </button>
          </div>
          <div className="usage-chart__legend" aria-label="Providers">
            {props.data.providers.map((provider) => (
              <span data-provider={provider.provider} key={provider.provider}>
                <SourceIdentity
                  presentation={providerPresentation(provider.provider)}
                  density="compact"
                />
              </span>
            ))}
          </div>
        </div>
      </header>

      <div className="usage-chart__canvas">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label={`Daily ${mode} from ${formatDateRange(props.data.startDate, props.data.endDate)}`}
          onPointerMove={updateHover}
          onPointerLeave={clearHover}
        >
          <title>Daily {mode} by provider</title>
          {chart.ticks.map((tick) => (
            <g className="usage-chart__grid" key={tick.value}>
              <line x1={CHART_LEFT} x2={CHART_RIGHT} y1={tick.y} y2={tick.y} />
              <text x={CHART_LEFT - 10} y={tick.y + 4} textAnchor="end">
                {formatAxis(tick.value, mode)}
              </text>
            </g>
          ))}
          {chart.series.map((series) => (
            <g
              className="usage-chart__series"
              data-provider={series.provider}
              key={series.provider}
            >
              <path className="usage-chart__area" d={series.areaPath} />
              <path
                className="usage-chart__line"
                d={series.linePath}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          {hoveredDay ? (
            <line
              className="usage-chart__crosshair"
              x1={hoverLeft}
              x2={hoverLeft}
              y1={CHART_TOP}
              y2={CHART_BOTTOM}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          <g className="usage-chart__axis-labels">
            <text x={CHART_LEFT} y={CHART_HEIGHT - 4} textAnchor="start">
              {formatChartDate(props.data.startDate)}
            </text>
            <text x={(CHART_LEFT + CHART_RIGHT) / 2} y={CHART_HEIGHT - 4} textAnchor="middle">
              {formatChartDate(props.data.daily[Math.floor(props.data.daily.length / 2)]?.date)}
            </text>
            <text x={CHART_RIGHT} y={CHART_HEIGHT - 4} textAnchor="end">
              {formatChartDate(props.data.endDate)}
            </text>
          </g>
        </svg>
        {hoveredDay ? (
          <ChartTooltip
            day={hoveredDay}
            mode={mode}
            left={(hoverLeft / CHART_WIDTH) * 100}
            reversed={hoverLeft > CHART_WIDTH * 0.72}
          />
        ) : null}
      </div>
    </section>
  )
}

function ChartTooltip(props: {
  day: UsageHistoryDay
  mode: 'cost' | 'tokens'
  left: number
  reversed: boolean
}) {
  return (
    <div
      className={`usage-chart__tooltip${props.reversed ? ' is-reversed' : ''}`}
      style={{ left: `${props.left}%` }}
    >
      <strong>{formatLongDate(props.day.date)}</strong>
      <span>
        Total
        <b>
          {props.mode === 'cost'
            ? formatMoney(props.day.totals.estimatedCostUsd)
            : formatTokens(props.day.totals.processedTokens)}
        </b>
      </span>
      {props.day.providers.map((provider) => (
        <span data-provider={provider.provider} key={provider.provider}>
          <SourceIdentity
            presentation={providerPresentation(provider.provider)}
            density="compact"
          />
          <b>
            {props.mode === 'cost'
              ? formatMoney(provider.estimatedCostUsd)
              : formatTokens(provider.tokens)}
          </b>
        </span>
      ))}
    </div>
  )
}

function UsageBreakdown(props: { data: ResultOf<'usage.history'> }) {
  const [mode, setMode] = useState<'model' | 'day'>('model')
  const rows =
    mode === 'model'
      ? props.data.models.map((model) => ({
          key: `${model.provider}:${model.model}`,
          provider: model.provider,
          name: model.model,
          pricing: model.pricing,
          sessions: model.sessionCount,
          totals: model.totals,
        }))
      : props.data.daily
          .filter((day) => day.totals.processedTokens > 0)
          .toReversed()
          .map((day) => ({
            key: day.date,
            name: formatLongDate(day.date),
            pricing: day.totals.unpricedTokens > 0 ? ('unpriced' as const) : ('exact' as const),
            sessions: day.sessionCount,
            totals: day.totals,
          }))
  const denominator = props.data.totals.estimatedCostUsd
  const tokenDenominator = props.data.totals.processedTokens
  const quality = costQuality(props.data.totals)

  return (
    <div className="usage-breakdown-grid">
      <section className="usage-breakdown" aria-labelledby="usage-breakdown-title">
        <header>
          <h2 id="usage-breakdown-title">Usage details</h2>
          <div
            className="usage-segmented usage-segmented--small"
            role="radiogroup"
            aria-label="Breakdown grouping"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'model'}
              className={mode === 'model' ? 'is-selected' : ''}
              onClick={() => setMode('model')}
            >
              Model
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'day'}
              className={mode === 'day' ? 'is-selected' : ''}
              onClick={() => setMode('day')}
            >
              Day
            </button>
          </div>
        </header>
        <div className="usage-breakdown__scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{mode === 'model' ? 'Model' : 'Day'}</th>
                <th scope="col">Cost</th>
                <th scope="col">Share</th>
                <th scope="col">Tokens</th>
                <th scope="col">Cache hit rate</th>
                <th scope="col">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const share =
                  denominator > 0
                    ? row.totals.estimatedCostUsd / denominator
                    : tokenDenominator > 0
                      ? row.totals.processedTokens / tokenDenominator
                      : 0
                const badge = pricingLabel(row.pricing, row.totals)
                const hitRate = cacheHitRate(row.totals)
                return (
                  <tr key={row.key}>
                    <th scope="row">
                      <span className="usage-breakdown__name">
                        {'provider' in row ? (
                          <SourceIdentity
                            presentation={providerPresentation(row.provider)}
                            qualifier={row.name}
                            density="compact"
                          />
                        ) : (
                          <CalendarDays size={15} aria-hidden />
                        )}
                        {'provider' in row ? null : <span>{row.name}</span>}
                        {badge ? <em>{badge}</em> : null}
                      </span>
                    </th>
                    <td>
                      {row.totals.pricedTokens + row.totals.providerReportedTokens > 0
                        ? formatMoney(row.totals.estimatedCostUsd)
                        : '—'}
                    </td>
                    <td>{formatPercent(share)}</td>
                    <td>{formatTokens(row.totals.processedTokens)}</td>
                    <td>{hitRate === undefined ? '—' : formatPercent(hitRate)}</td>
                    <td>{formatInteger(row.sessions)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 ? (
            <p className="usage-breakdown__empty">No usage in this period.</p>
          ) : null}
        </div>
      </section>

      <aside className="usage-quality" aria-labelledby="usage-quality-title">
        <h2 id="usage-quality-title">Estimate coverage</h2>
        <dl>
          <div>
            <dt>Provider reported</dt>
            <dd>{formatPercent(quality.providerReported)}</dd>
          </div>
          <div>
            <dt>Model priced</dt>
            <dd>{formatPercent(quality.modelPriced)}</dd>
          </div>
          <div>
            <dt>Unpriced</dt>
            <dd>{formatPercent(quality.unpriced)}</dd>
          </div>
          <div>
            <dt>Cache savings</dt>
            <dd>{formatMoney(props.data.totals.cacheSavingsUsd)}</dd>
          </div>
          <div>
            <dt>Active days</dt>
            <dd>{formatInteger(props.data.activeDays)}</dd>
          </div>
        </dl>
      </aside>
    </div>
  )
}

const CHART_WIDTH = 900
const CHART_HEIGHT = 290
const CHART_LEFT = 72
const CHART_RIGHT = 888
const CHART_TOP = 18
const CHART_BOTTOM = 252
const CHART_PLOT_WIDTH = CHART_RIGHT - CHART_LEFT

function buildChart(data: ResultOf<'usage.history'>, mode: 'cost' | 'tokens') {
  const series = data.providers.map((provider) => {
    const values = smoothChartValues(
      data.daily.map((day) => {
        const providerDay = day.providers.find((entry) => entry.provider === provider.provider)
        return mode === 'cost' ? (providerDay?.estimatedCostUsd ?? 0) : (providerDay?.tokens ?? 0)
      }),
    )
    return { provider: provider.provider, values }
  })
  const max = niceMaximum(Math.max(...series.flatMap((entry) => entry.values), 0))
  const plotHeight = CHART_BOTTOM - CHART_TOP
  const pointFor = (value: number, index: number, length: number) => ({
    x: length <= 1 ? CHART_LEFT : CHART_LEFT + (index / Math.max(length - 1, 1)) * CHART_PLOT_WIDTH,
    y: CHART_BOTTOM - (value / max) * plotHeight,
  })
  const paths = series.map((entry) => {
    const points = entry.values.map((value, index) => pointFor(value, index, entry.values.length))
    const baselinePoints = entry.values.map((_, index) => pointFor(0, index, entry.values.length))
    return {
      provider: entry.provider,
      linePath: smoothPath(points),
      areaPath: filledAreaPath(points, baselinePoints),
    }
  })
  const ticks = [0, 0.5, 1].map((ratio) => ({
    value: max * (1 - ratio),
    y: CHART_TOP + plotHeight * ratio,
  }))
  return { series: paths, ticks }
}

function smoothChartValues(values: ReadonlyArray<number>): number[] {
  const smoothPass = (input: ReadonlyArray<number>) =>
    input.map((value, index) => {
      const previous = input[index - 1] ?? value
      const next = input[index + 1] ?? value
      return previous * 0.2 + value * 0.6 + next * 0.2
    })

  const firstPass = smoothPass(values)
  return values.length >= 14 ? smoothPass(firstPass) : firstPass
}

function smoothPath(points: ReadonlyArray<{ x: number; y: number }>): string {
  const first = points[0]
  if (!first) return ''
  let path = `M ${first.x} ${first.y}`
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    if (!previous || !current) continue
    const midpoint = (previous.x + current.x) / 2
    path += ` C ${midpoint} ${previous.y}, ${midpoint} ${current.y}, ${current.x} ${current.y}`
  }
  return path
}

function filledAreaPath(
  upperPoints: ReadonlyArray<{ x: number; y: number }>,
  lowerPoints: ReadonlyArray<{ x: number; y: number }>,
): string {
  const upperPath = smoothPath(upperPoints)
  const reversedLower = lowerPoints.toReversed()
  const firstLower = reversedLower[0]
  if (!upperPath || !firstLower) return ''
  const lowerPath = smoothPath(reversedLower)
  const firstCurve = lowerPath.indexOf(' C ')
  return `${upperPath} L ${firstLower.x} ${firstLower.y}${firstCurve >= 0 ? lowerPath.slice(firstCurve) : ''} Z`
}

function niceMaximum(value: number): number {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const scale = 10 ** exponent
  const normalized = value / scale
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return nice * scale
}

function costQuality(totals: UsageHistoryTotals) {
  const denominator = totals.processedTokens
  if (denominator <= 0) return { providerReported: 0, modelPriced: 0, unpriced: 0 }
  return {
    providerReported: totals.providerReportedTokens / denominator,
    modelPriced: totals.pricedTokens / denominator,
    unpriced: totals.unpricedTokens / denominator,
  }
}

function cacheHitRate(totals: UsageHistoryTotals): number | undefined {
  const inputTokens =
    totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheWriteInputTokens
  return inputTokens > 0 ? totals.cachedInputTokens / inputTokens : undefined
}

function pricingLabel(
  pricing: 'exact' | 'family' | 'unpriced',
  totals: UsageHistoryTotals,
): string | undefined {
  if (
    totals.providerReportedCostUsd > 0 &&
    totals.pricedTokens === 0 &&
    totals.unpricedTokens === 0
  ) {
    return 'provider cost'
  }
  if (pricing === 'family') return 'family price'
  if (pricing === 'unpriced') return 'unpriced'
  return undefined
}

function formatMoney(value: number): string {
  return money.format(value)
}

function formatInteger(value: number): string {
  return number.format(Math.round(value))
}

function formatTokens(value: number): string {
  const absolute = Math.abs(value)
  if (absolute < 1_000) return formatInteger(value)
  const units = [
    { size: 1_000_000_000_000, suffix: 'T' },
    { size: 1_000_000_000, suffix: 'B' },
    { size: 1_000_000, suffix: 'M' },
    { size: 1_000, suffix: 'K' },
  ]
  const unit = units.find((candidate) => absolute >= candidate.size) ?? units.at(-1)
  if (!unit) return formatInteger(value)
  const scaled = value / unit.size
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
  return `${scaled.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0+$/, '')}${unit.suffix}`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatDecimal(value: number): string {
  return value.toFixed(1)
}

function formatDateRange(start: string, end: string): string {
  if (start === end) return formatLongDate(start)
  const startDate = dateFromKey(start)
  const endDate = dateFromKey(end)
  const sameYear = startDate.getFullYear() === endDate.getFullYear()
  const first = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(startDate)
  const last = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(endDate)
  return `${first} to ${last}`
}

function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(dateFromKey(value))
}

function formatChartDate(value: string | undefined): string {
  if (!value) return ''
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
    .format(dateFromKey(value))
    .toUpperCase()
}

function formatAxis(value: number, mode: 'cost' | 'tokens'): string {
  if (value === 0) return '0'
  return mode === 'cost' ? `$${formatTokens(value)}` : formatTokens(value)
}

function dateFromKey(value: string): Date {
  const [year = 1970, month = 1, day = 1] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}
