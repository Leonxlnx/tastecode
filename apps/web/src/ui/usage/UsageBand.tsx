import { memo, useMemo, type KeyboardEvent, type PointerEvent } from 'react'
import { formatTokens } from './usage-format.js'
import type { SheetSlot } from './usage-sheets.js'

/** Band height; its baseline sits on the last line of the sheet's facts. */
const BAND_HEIGHT = 72
const BASE = BAND_HEIGHT - 6
/** Room above the tallest step for its label. */
const HEAD = 16
const AMPLITUDE = BASE - HEAD
const TICK_HEIGHT = 9
const AXIS_TICK = 4
/** Peak labels closer than this to a placed one are left out. */
const LABEL_SPACING = 46

type Geometry = { slot: number; left: (index: number) => number; center: (index: number) => number }

function geometry(width: number, slots: number): Geometry {
  const slot = width / slots
  return { slot, left: (index) => index * slot, center: (index) => (index + 0.5) * slot }
}

function heightOf(tokens: number, top: number): number {
  if (tokens <= 0 || top <= 0) return BASE
  return BASE - Math.max(1.5, (Math.min(tokens, top) / top) * AMPLITUDE)
}

/**
 * One provider's tokens as a stepped line on the shared scale: each slot a
 * flat step across its width, a quiet wash under runs of active slots. The
 * busiest slot carries its value; capped slots run to the top with a break
 * mark and their true value. A provider too small to rise on the scale shows
 * its active slots as ticks on the baseline.
 */
export const UsageBand = memo(function UsageBand(props: {
  name: string
  slots: SheetSlot[]
  /** "day", or "week" on a long period. */
  unit: string
  quiet: boolean
  activeDays: number
  top: number
  width: number
  /** Slots the axis labels, marked on the baseline. */
  ticks: readonly number[]
  hover: number | undefined
  onHover: (index: number | undefined) => void
}) {
  const { slots, quiet, top, width, hover, onHover } = props
  const count = slots.length
  const ink = useMemo(
    () => (width > 0 && count > 0 ? drawInk(slots, quiet, top, width) : undefined),
    [slots, quiet, top, width, count],
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
      onHover(Math.max(0, Math.min(count - 1, (hover ?? count - 1) + step)))
    } else if (event.key === 'Escape') {
      onHover(undefined)
    }
  }

  const g = width > 0 && count > 0 ? geometry(width, count) : undefined
  const slot = hover === undefined ? undefined : slots[hover]
  const dotY =
    slot === undefined
      ? BASE
      : quiet && slot.tokens > 0
        ? BASE - TICK_HEIGHT
        : heightOf(slot.tokens, top)
  const days = `${props.activeDays} active ${props.activeDays === 1 ? 'day' : 'days'}`

  return (
    <div
      className="usage-band"
      tabIndex={0}
      role="img"
      aria-label={`${props.name} tokens a ${props.unit}, ${days}${quiet ? ', too few to rise on the shared scale' : ''}. Use the arrow keys to read a ${props.unit}.`}
      onPointerMove={(event) => {
        const index = indexAt(event)
        if (index !== hover) onHover(index)
      }}
      onPointerLeave={() => onHover(undefined)}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (hover === undefined) onHover(count - 1)
      }}
      onBlur={() => onHover(undefined)}
    >
      {quiet ? (
        <span className="usage-band__note" aria-hidden>
          Too few to rise on the shared scale
        </span>
      ) : null}
      {ink && g ? (
        <>
          <svg
            className="usage-band__ink"
            width={width}
            height={BAND_HEIGHT}
            viewBox={`0 0 ${width} ${BAND_HEIGHT}`}
            aria-hidden
          >
            {props.ticks.map((index) => (
              <line
                key={index}
                className="usage-band__axis-tick"
                x1={g.center(index)}
                x2={g.center(index)}
                y1={BASE}
                y2={BASE + AXIS_TICK}
              />
            ))}
            {ink.ticks.map((tick) => (
              <rect
                key={tick.x}
                className="usage-band__tick"
                x={tick.x}
                y={BASE - TICK_HEIGHT}
                width={tick.width}
                height={TICK_HEIGHT + 0.5}
                rx={tick.width / 2}
              />
            ))}
            {ink.line ? (
              <>
                <path className="usage-band__wash" d={ink.wash} />
                <path className="usage-band__line" d={ink.line} />
              </>
            ) : null}
            {ink.breaks.map((x) => (
              <g key={x} className="usage-band__break">
                <path
                  className="usage-band__break-gap"
                  d={`M${x - 6},${HEAD + 11}L${x + 6},${HEAD + 7}L${x + 6},${HEAD + 11}L${x - 6},${HEAD + 15}Z`}
                />
                <path
                  className="usage-band__break-line"
                  d={`M${x - 6},${HEAD + 11}L${x + 6},${HEAD + 7}M${x - 6},${HEAD + 15}L${x + 6},${HEAD + 11}`}
                />
              </g>
            ))}
            <g className="usage-band__peaks">
              {ink.peaks.map((peak) => (
                <text
                  key={peak.x}
                  className="usage-band__peak"
                  x={Math.min(width - 2, Math.max(2, peak.x))}
                  y={peak.y - 5}
                  textAnchor={peak.x < 24 ? 'start' : peak.x > width - 24 ? 'end' : 'middle'}
                >
                  {formatTokens(peak.tokens)}
                </text>
              ))}
            </g>
          </svg>
          {hover !== undefined ? (
            <svg
              className="usage-band__hover"
              width={width}
              height={BAND_HEIGHT}
              viewBox={`0 0 ${width} ${BAND_HEIGHT}`}
              aria-hidden
            >
              <rect
                className="usage-band__slot"
                x={g.left(hover)}
                y={HEAD - 4}
                width={Math.max(1, g.slot)}
                height={BASE - HEAD + 4}
              />
              <line
                className="usage-band__cross"
                x1={g.center(hover)}
                x2={g.center(hover)}
                y1={HEAD - 4}
                y2={BASE}
              />
              <circle className="usage-band__dot" r={4} cx={g.center(hover)} cy={dotY} />
            </svg>
          ) : null}
        </>
      ) : null}
    </div>
  )
})

type Ink = {
  line: string
  wash: string
  ticks: Array<{ x: number; width: number }>
  breaks: number[]
  peaks: Array<{ x: number; y: number; tokens: number }>
}

function drawInk(slots: SheetSlot[], quiet: boolean, top: number, width: number): Ink {
  const g = geometry(width, slots.length)
  if (quiet) {
    const tickWidth = Math.max(2, Math.min(4, g.slot - 1))
    const ticks = slots.flatMap((slot, index) =>
      slot.tokens > 0 ? [{ x: g.center(index) - tickWidth / 2, width: tickWidth }] : [],
    )
    return { line: '', wash: '', ticks, breaks: [], peaks: [] }
  }

  let line = ''
  let wash = ''
  let index = 0
  while (index < slots.length) {
    if ((slots[index]?.tokens ?? 0) <= 0) {
      index += 1
      continue
    }
    const start = index
    let run = `M${g.left(index).toFixed(2)},${BASE}`
    while (index < slots.length && (slots[index]?.tokens ?? 0) > 0) {
      const y = heightOf(slots[index]?.tokens ?? 0, top).toFixed(2)
      run += `L${g.left(index).toFixed(2)},${y}L${g.left(index + 1).toFixed(2)},${y}`
      index += 1
    }
    run += `L${g.left(index).toFixed(2)},${BASE}`
    line += run
    wash += `${run}L${g.left(start).toFixed(2)},${BASE}Z`
  }

  const capped = slots.flatMap((slot, index) =>
    slot.tokens > top ? [{ x: g.center(index), y: HEAD, tokens: slot.tokens }] : [],
  )
  // Without a capped slot, the busiest one is labelled so the band has a scale.
  const busiest = slots.reduce(
    (best, slot, at) => (slot.tokens > (slots[best]?.tokens ?? 0) ? at : best),
    0,
  )
  const labelled =
    capped.length > 0
      ? capped
      : [
          {
            x: g.center(busiest),
            y: heightOf(slots[busiest]?.tokens ?? 0, top),
            tokens: slots[busiest]?.tokens ?? 0,
          },
        ]
  const peaks: Ink['peaks'] = []
  for (const peak of labelled.toSorted((left, right) => right.tokens - left.tokens)) {
    if (peak.tokens <= 0) continue
    if (peaks.some((placed) => Math.abs(placed.x - peak.x) < LABEL_SPACING)) continue
    peaks.push(peak)
  }
  return { line, wash, ticks: [], breaks: capped.map((peak) => peak.x), peaks }
}
