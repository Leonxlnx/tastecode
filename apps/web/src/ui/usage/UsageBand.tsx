import { memo, useMemo, type KeyboardEvent, type PointerEvent } from 'react'
import { formatTokens } from './usage-format.js'
import type { SheetDay } from './usage-sheets.js'

/** Band height; the baseline sits on the provider name's baseline. */
const BAND_HEIGHT = 56
const BASE = BAND_HEIGHT - 6
const HEAD = 8
const AMPLITUDE = BASE - HEAD
const TICK_HEIGHT = 9
/** Peak labels closer than this to a placed one are left out. */
const LABEL_SPACING = 46

type Geometry = { slot: number; left: (index: number) => number; center: (index: number) => number }

function geometry(width: number, days: number): Geometry {
  const slot = width / days
  return { slot, left: (index) => index * slot, center: (index) => (index + 0.5) * slot }
}

function heightOf(tokens: number, top: number): number {
  if (tokens <= 0 || top <= 0) return BASE
  return BASE - Math.max(1.5, (Math.min(tokens, top) / top) * AMPLITUDE)
}

/**
 * One provider's daily tokens as a stepped line on the shared scale: each day
 * a flat step across its slot, a quiet wash under runs of active days, capped
 * days run to the top with a break mark and their true value. A provider too
 * small to rise on the scale shows its active days as ticks on the baseline.
 */
export const UsageBand = memo(function UsageBand(props: {
  name: string
  daily: SheetDay[]
  quiet: boolean
  activeDays: number
  top: number
  width: number
  hover: number | undefined
  onHover: (index: number | undefined) => void
}) {
  const { daily, quiet, top, width, hover, onHover } = props
  const days = daily.length
  const ink = useMemo(
    () => (width > 0 && days > 0 ? drawInk(daily, quiet, top, width) : undefined),
    [daily, quiet, top, width, days],
  )

  const indexAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * days)
    return Math.max(0, Math.min(days - 1, index))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = (event.shiftKey ? 7 : 1) * (event.key === 'ArrowLeft' ? -1 : 1)
      onHover(Math.max(0, Math.min(days - 1, (hover ?? days - 1) + step)))
    } else if (event.key === 'Escape') {
      onHover(undefined)
    }
  }

  const g = width > 0 && days > 0 ? geometry(width, days) : undefined
  const day = hover === undefined ? undefined : daily[hover]
  const dotY =
    day === undefined
      ? BASE
      : quiet && day.tokens > 0
        ? BASE - TICK_HEIGHT
        : heightOf(day.tokens, top)

  return (
    <div
      className="usage-band"
      tabIndex={0}
      role="img"
      aria-label={`${props.name} daily tokens, ${props.activeDays} active ${props.activeDays === 1 ? 'day' : 'days'}. Use the arrow keys to read a day.`}
      onPointerMove={(event) => {
        const index = indexAt(event)
        if (index !== hover) onHover(index)
      }}
      onPointerLeave={() => onHover(undefined)}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (hover === undefined) onHover(days - 1)
      }}
      onBlur={() => onHover(undefined)}
    >
      {ink && g ? (
        <>
          <svg
            className="usage-band__ink"
            width={width}
            height={BAND_HEIGHT}
            viewBox={`0 0 ${width} ${BAND_HEIGHT}`}
            aria-hidden
          >
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
                  y={HEAD - 3}
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
  peaks: Array<{ x: number; tokens: number }>
}

function drawInk(daily: SheetDay[], quiet: boolean, top: number, width: number): Ink {
  const g = geometry(width, daily.length)
  if (quiet) {
    const tickWidth = Math.max(2, Math.min(4, g.slot - 1))
    const ticks = daily.flatMap((day, index) =>
      day.tokens > 0 ? [{ x: g.center(index) - tickWidth / 2, width: tickWidth }] : [],
    )
    return { line: '', wash: '', ticks, breaks: [], peaks: [] }
  }

  let line = ''
  let wash = ''
  let index = 0
  while (index < daily.length) {
    if ((daily[index]?.tokens ?? 0) <= 0) {
      index += 1
      continue
    }
    const start = index
    let run = `M${g.left(index).toFixed(2)},${BASE}`
    while (index < daily.length && (daily[index]?.tokens ?? 0) > 0) {
      const y = heightOf(daily[index]?.tokens ?? 0, top).toFixed(2)
      run += `L${g.left(index).toFixed(2)},${y}L${g.left(index + 1).toFixed(2)},${y}`
      index += 1
    }
    run += `L${g.left(index).toFixed(2)},${BASE}`
    line += run
    wash += `${run}L${g.left(start).toFixed(2)},${BASE}Z`
  }

  const capped = daily.flatMap((day, index) =>
    day.tokens > top ? [{ x: g.center(index), tokens: day.tokens }] : [],
  )
  const peaks: Ink['peaks'] = []
  for (const peak of capped.toSorted((left, right) => right.tokens - left.tokens)) {
    if (peaks.some((placed) => Math.abs(placed.x - peak.x) < LABEL_SPACING)) continue
    peaks.push(peak)
  }
  return { line, wash, ticks: [], breaks: capped.map((peak) => peak.x), peaks }
}
