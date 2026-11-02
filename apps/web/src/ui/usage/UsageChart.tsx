import {
  memo,
  useLayoutEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { formatTokens } from './usage-format.js'
import { formatValue, type AxisTick, type SheetSlot } from './usage-sheets.js'

/** Plot height, with room above the tallest bar for its label. */
const HEIGHT = 72
const LABEL_ROOM = 16
const BASE = HEIGHT - 0.5
const AMPLITUDE = BASE - LABEL_ROOM
/** A slot with any use stays visible however small it is. */
const MIN_BAR = 2
const MAX_BAR = 20
const RADIUS = 3
/** Room between the read slot and its tooltip. */
const TIP_GAP = 6
/** Room kept between two axis labels, and the width of one character, in pixels. */
const LABEL_GAP = 14
const LABEL_CHAR = 6.5

/** One axis for every chart on the page: the slot names and the dates to print. */
export type ChartAxis = {
  /** "Sat, Oct 3" or "Sep 29 – Oct 5", one per slot. */
  slots: readonly string[]
  ticks: readonly AxisTick[]
  start: string
  end: string
}

/** A bar from the baseline to `top`, rounded at its data end only. */
function barPath(x: number, width: number, top: number): string {
  const radius = Math.min(RADIUS, width / 2, BASE - top)
  return (
    `M${x},${BASE}V${top + radius}Q${x},${top} ${x + radius},${top}` +
    `H${x + width - radius}Q${x + width},${top} ${x + width},${top + radius}V${BASE}Z`
  )
}

/**
 * One provider's tokens as a bar per day, or per week on a long period, on
 * its own scale. The busiest bar carries its value, the dates sit under the
 * baseline, and hovering or the arrow keys read one bar in a tooltip.
 */
export const UsageChart = memo(function UsageChart(props: {
  name: string
  slots: SheetSlot[]
  axis: ChartAxis
  /** "day", or "week" on a long period. */
  unit: string
}) {
  const { slots, axis } = props
  const count = slots.length
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const width = useWidth(element)
  const [hover, setHover] = useState<number>()
  const active = hover !== undefined && hover < count ? hover : undefined

  const bars = useMemo(() => drawBars(slots, width), [slots, width])
  const ticks = useMemo(
    () => placeTicks(axis.ticks, count, width, axis.start, axis.end),
    [axis.ticks, count, width, axis.start, axis.end],
  )

  const indexAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * count)
    return Math.max(0, Math.min(count - 1, index))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = (event.shiftKey ? 7 : 1) * (event.key === 'ArrowLeft' ? -1 : 1)
      setHover(Math.max(0, Math.min(count - 1, (active ?? count - 1) + step)))
    } else if (event.key === 'Escape') {
      setHover(undefined)
    }
  }

  const bar = active === undefined ? undefined : bars?.items[active]
  const slot = active === undefined ? undefined : slots[active]

  return (
    <div className={`usage-chart${active === undefined ? '' : ' is-reading'}`}>
      <div
        ref={setElement}
        className="usage-chart__plot"
        tabIndex={0}
        role="img"
        aria-label={`${props.name} tokens a ${props.unit}. Use the arrow keys to read a ${props.unit}.`}
        onPointerMove={(event) => {
          const index = indexAt(event)
          if (index !== active) setHover(index)
        }}
        onPointerLeave={() => setHover(undefined)}
        onKeyDown={onKeyDown}
        onFocus={() => setHover((current) => current ?? count - 1)}
        onBlur={() => setHover(undefined)}
      >
        {bars ? (
          <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden>
            {bar ? (
              <rect
                className="usage-chart__slot"
                x={bar.slotX}
                y={0}
                width={bars.slot}
                height={HEIGHT}
              />
            ) : null}
            <line className="usage-chart__base" x1={0} x2={width} y1={BASE} y2={BASE} />
            <g className="usage-chart__bars">
              {bars.items.map((item, index) =>
                item.path ? (
                  <path
                    key={index}
                    className={`usage-chart__bar${index === active ? ' is-active' : ''}`}
                    d={item.path}
                  />
                ) : null,
              )}
            </g>
            {bars.peak ? (
              <text
                className="usage-chart__peak"
                x={Math.min(width - 1, Math.max(1, bars.peak.x))}
                y={bars.peak.y - 5}
                textAnchor={
                  bars.peak.x < 24 ? 'start' : bars.peak.x > width - 24 ? 'end' : 'middle'
                }
              >
                {formatTokens(bars.peak.tokens)}
              </text>
            ) : null}
          </svg>
        ) : null}
      </div>
      <div className="usage-chart__reading" aria-live="polite">
        {slot && active !== undefined ? (
          <ChartTip
            x={active * (width / count)}
            slot={width / count}
            width={width}
            title={axis.slots[active] ?? ''}
            entry={slot}
          />
        ) : null}
      </div>
      <div className="usage-chart__axis" aria-hidden>
        <span className="usage-chart__axis-start">{axis.start}</span>
        {ticks.map((tick) => (
          <span key={tick.index} className="usage-chart__axis-tick" style={{ left: tick.x }}>
            {tick.label}
          </span>
        ))}
        <span className="usage-chart__axis-end">{axis.end}</span>
      </div>
    </div>
  )
})

/**
 * The read bar's date, tokens and value beside it: on its right, or on its
 * left where the right runs out, so the bar and the header stay in view.
 */
function ChartTip(props: {
  /** The read slot's left edge and width. */
  x: number
  slot: number
  width: number
  title: string
  entry: SheetSlot
}) {
  const { entry } = props
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [tipWidth, setTipWidth] = useState(0)
  useLayoutEffect(() => {
    setTipWidth(element?.offsetWidth ?? 0)
  }, [element, props.title, entry])
  const right = props.x + props.slot + TIP_GAP
  const left = right + tipWidth <= props.width ? right : props.x - TIP_GAP - tipWidth
  // Tokens with no value come from models without an API price, not free use.
  const value =
    entry.tokens <= 0 ? undefined : entry.value > 0 ? formatValue(entry.value) : 'not priced'
  return (
    <div
      ref={setElement}
      className="usage-chart__tip"
      style={{ left: Math.max(0, left), top: HEIGHT / 2 }}
    >
      <span className="usage-chart__tip-date">{props.title}</span>
      <span className="usage-chart__tip-tokens">
        {entry.tokens > 0 ? `${formatTokens(entry.tokens)} tokens` : 'No use'}
      </span>
      {value ? <span className="usage-chart__tip-value">{value}</span> : null}
    </div>
  )
}

type Bars = {
  slot: number
  items: Array<{ path: string; slotX: number }>
  peak: { x: number; y: number; tokens: number } | undefined
}

function drawBars(slots: readonly SheetSlot[], width: number): Bars | undefined {
  if (width <= 0 || slots.length === 0) return undefined
  const slot = width / slots.length
  const barWidth = Math.max(1, Math.min(MAX_BAR, slot - Math.max(2, slot * 0.25)))
  const max = Math.max(0, ...slots.map((entry) => entry.tokens))
  let peak: Bars['peak']
  const items = slots.map((entry, index) => {
    const slotX = index * slot
    const center = slotX + slot / 2
    if (entry.tokens <= 0 || max <= 0) return { path: '', slotX }
    const top = BASE - Math.max(MIN_BAR, (entry.tokens / max) * AMPLITUDE)
    if (!peak || entry.tokens > peak.tokens) peak = { x: center, y: top, tokens: entry.tokens }
    return { path: barPath(center - barWidth / 2, barWidth, top), slotX }
  })
  return { slot, items, peak }
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
