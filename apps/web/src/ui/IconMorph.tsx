import { Children, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import {
  interpolateMorphPoints,
  morphPath,
  pairMorphTracks,
  type MorphPoint,
  type MorphTrack,
} from './icon-morph-geometry.js'
import '../styles/icon-morph.css'

const GEOMETRY_SELECTOR = 'path, circle, ellipse, line, polyline, polygon, rect'
const POINT_COUNT = 32
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

type MorphPaint = Readonly<{
  fill: string
  fillOpacity: number
  stroke: string
  strokeOpacity: number
  strokeWidth: number
  lineCap: string
  lineJoin: string
}>

type IconTrack = MorphTrack<MorphPaint>

type RunningMorph = {
  frame: number
  tracks: IconTrack[]
}

function numeric(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function isVisiblePaint(value: string): boolean {
  return value !== '' && value !== 'none' && value !== 'rgba(0, 0, 0, 0)'
}

function centerOf(points: readonly MorphPoint[]): MorphPoint {
  if (points.length === 0) return { x: 0, y: 0 }
  const total = points.reduce(
    (center, point) => ({ x: center.x + point.x, y: center.y + point.y }),
    { x: 0, y: 0 },
  )
  return { x: total.x / points.length, y: total.y / points.length }
}

function isClosed(points: readonly MorphPoint[]): boolean {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return false
  return Math.hypot(first.x - last.x, first.y - last.y) < 0.15
}

function transformedPoint(point: DOMPoint, matrix: DOMMatrix, bounds: DOMRect): MorphPoint {
  return {
    x: point.x * matrix.a + point.y * matrix.c + matrix.e - bounds.left,
    y: point.x * matrix.b + point.y * matrix.d + matrix.f - bounds.top,
  }
}

function sampleGeometry(geometry: SVGGeometryElement, bounds: DOMRect): IconTrack | undefined {
  if (typeof geometry.getTotalLength !== 'function') return undefined

  try {
    const length = geometry.getTotalLength()
    const matrix = geometry.getScreenCTM()
    if (!matrix || !Number.isFinite(length) || length <= 0) return undefined

    const start = transformedPoint(geometry.getPointAtLength(0), matrix, bounds)
    const end = transformedPoint(geometry.getPointAtLength(length), matrix, bounds)
    const closed = Math.hypot(start.x - end.x, start.y - end.y) < 0.15
    const points: MorphPoint[] = []

    for (let index = 0; index < POINT_COUNT; index += 1) {
      const ratio = closed && index === POINT_COUNT - 1 ? 0 : index / (POINT_COUNT - 1)
      points.push(transformedPoint(geometry.getPointAtLength(length * ratio), matrix, bounds))
    }

    const style = window.getComputedStyle(geometry)
    const scale = Math.hypot(matrix.a, matrix.b)
    const opacity = numeric(style.opacity, 1)
    const fill = style.fill
    const stroke = style.stroke

    return {
      points,
      center: centerOf(points),
      closed,
      length: length * scale,
      paint: {
        fill,
        fillOpacity: isVisiblePaint(fill) ? numeric(style.fillOpacity, 1) * opacity : 0,
        stroke,
        strokeOpacity: isVisiblePaint(stroke) ? numeric(style.strokeOpacity, 1) * opacity : 0,
        strokeWidth: numeric(style.strokeWidth, 0) * scale,
        lineCap: style.strokeLinecap || 'round',
        lineJoin: style.strokeLinejoin || 'round',
      },
    }
  } catch {
    return undefined
  }
}

function sampleLayer(layer: Element | undefined, bounds: DOMRect): IconTrack[] {
  const svg = layer?.querySelector('svg')
  if (!(svg instanceof SVGSVGElement)) return []

  return Array.from(svg.querySelectorAll<SVGGeometryElement>(GEOMETRY_SELECTOR))
    .map((geometry) => sampleGeometry(geometry, bounds))
    .filter((track): track is IconTrack => track !== undefined)
}

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress
}

function interpolatePaint(from: MorphPaint, to: MorphPaint, progress: number): MorphPaint {
  return {
    fill: progress < 0.5 ? from.fill : to.fill,
    fillOpacity: mix(from.fillOpacity, to.fillOpacity, progress),
    stroke: progress < 0.5 ? from.stroke : to.stroke,
    strokeOpacity: mix(from.strokeOpacity, to.strokeOpacity, progress),
    strokeWidth: mix(from.strokeWidth, to.strokeWidth, progress),
    lineCap: progress < 0.5 ? from.lineCap : to.lineCap,
    lineJoin: progress < 0.5 ? from.lineJoin : to.lineJoin,
  }
}

function interpolateTrack(from: IconTrack, to: IconTrack, progress: number): IconTrack {
  const points = interpolateMorphPoints(from.points, to.points, progress)
  return {
    points,
    center: centerOf(points),
    closed: isClosed(points),
    length: mix(from.length, to.length, progress),
    paint: interpolatePaint(from.paint, to.paint, progress),
  }
}

function paintPath(path: SVGPathElement, track: IconTrack): void {
  path.setAttribute('d', morphPath(track.points))
  path.setAttribute('fill', track.paint.fillOpacity > 0 ? track.paint.fill : 'none')
  path.setAttribute('fill-opacity', String(track.paint.fillOpacity))
  path.setAttribute('stroke', track.paint.strokeOpacity > 0 ? track.paint.stroke : 'none')
  path.setAttribute('stroke-opacity', String(track.paint.strokeOpacity))
  path.setAttribute('stroke-width', String(track.paint.strokeWidth))
  path.setAttribute('stroke-linecap', track.paint.lineCap)
  path.setAttribute('stroke-linejoin', track.paint.lineJoin)
}

function durationInMilliseconds(root: HTMLElement): number {
  const value = window.getComputedStyle(root).getPropertyValue('--dur-slow').trim()
  if (value.endsWith('ms')) return numeric(value, 260)
  if (value.endsWith('s')) return numeric(value, 0.26) * 1_000
  return 260
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (time: number) => ((ax * time + bx) * time + cx) * time
  const sampleY = (time: number) => ((ay * time + by) * time + cy) * time
  const sampleSlope = (time: number) => (3 * ax * time + 2 * bx) * time + cx

  return (value: number) => {
    if (value <= 0) return 0
    if (value >= 1) return 1
    let time = value
    for (let index = 0; index < 8; index += 1) {
      const difference = sampleX(time) - value
      const slope = sampleSlope(time)
      if (Math.abs(difference) < 0.000_001 || Math.abs(slope) < 0.000_001) break
      time -= difference / slope
    }
    return sampleY(Math.min(1, Math.max(0, time)))
  }
}

function easingFunction(root: HTMLElement): (progress: number) => number {
  const value = window.getComputedStyle(root).getPropertyValue('--ease-in-out').trim()
  const match = value.match(
    /^cubic-bezier\(\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*\)$/,
  )
  if (!match) return cubicBezier(0.77, 0, 0.175, 1)
  return cubicBezier(
    numeric(match[1] ?? '', 0.77),
    numeric(match[2] ?? '', 0),
    numeric(match[3] ?? '', 0.175),
    numeric(match[4] ?? '', 1),
  )
}

function finishMorph(root: HTMLElement, overlay: SVGSVGElement): void {
  root.setAttribute('data-morph-settled', '')
  root.removeAttribute('data-morphing')
  overlay.replaceChildren()
}

/** Keeps glyphs in one slot and bends their SVG geometry into the next glyph. */
export function IconMorph(props: {
  active: number
  children: ReactNode
  className?: string | undefined
  from?: number | undefined
}) {
  const icons = Children.toArray(props.children)
  const active = Math.max(0, Math.min(props.active, icons.length - 1))
  const rootRef = useRef<HTMLSpanElement>(null)
  const overlayRef = useRef<SVGSVGElement>(null)
  const activeRef = useRef(active)
  const runningRef = useRef<RunningMorph | undefined>(undefined)
  const settleFrameRef = useRef(0)

  useLayoutEffect(() => {
    const root = rootRef.current
    const overlay = overlayRef.current
    if (!root || !overlay) return

    if (settleFrameRef.current) window.cancelAnimationFrame(settleFrameRef.current)
    root.removeAttribute('data-morph-settled')

    const explicitFrom =
      props.from === undefined ? undefined : Math.max(0, Math.min(props.from, icons.length - 1))
    const from = explicitFrom ?? activeRef.current
    activeRef.current = active
    if (from === active) return

    const previous = runningRef.current
    if (previous) window.cancelAnimationFrame(previous.frame)

    const bounds = root.getBoundingClientRect()
    const layers = Array.from(root.querySelectorAll('.icon-morph__layer'))
    const fromTracks = previous?.tracks ?? sampleLayer(layers[from], bounds)
    const toTracks = sampleLayer(layers[active], bounds)
    const pairs = pairMorphTracks(fromTracks, toTracks)
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    if (reduceMotion || pairs.length === 0 || bounds.width <= 0 || bounds.height <= 0) {
      runningRef.current = undefined
      root.removeAttribute('data-morphing')
      overlay.replaceChildren()
      return
    }

    overlay.replaceChildren()
    overlay.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`)
    const paths = pairs.map((pair) => {
      const path = document.createElementNS(SVG_NAMESPACE, 'path')
      paintPath(path, pair.from)
      overlay.append(path)
      return path
    })

    root.setAttribute('data-morphing', '')
    const duration = durationInMilliseconds(root)
    const ease = easingFunction(root)
    const started = performance.now()
    const running: RunningMorph = {
      frame: 0,
      tracks: pairs.map((pair) => pair.from),
    }
    runningRef.current = running

    const draw = (now: number) => {
      if (runningRef.current !== running) return
      const rawProgress = Math.min(1, Math.max(0, (now - started) / duration))
      const progress = ease(rawProgress)
      running.tracks = pairs.map((pair, index) => {
        const track = interpolateTrack(pair.from, pair.to, progress)
        const path = paths[index]
        if (path) paintPath(path, track)
        return track
      })

      if (rawProgress < 1) {
        running.frame = window.requestAnimationFrame(draw)
        return
      }

      runningRef.current = undefined
      finishMorph(root, overlay)
      settleFrameRef.current = window.requestAnimationFrame(() => {
        root.removeAttribute('data-morph-settled')
        settleFrameRef.current = 0
      })
    }

    running.frame = window.requestAnimationFrame(draw)
  }, [active, icons.length, props.from])

  useEffect(
    () => () => {
      const running = runningRef.current
      if (running) window.cancelAnimationFrame(running.frame)
      if (settleFrameRef.current) window.cancelAnimationFrame(settleFrameRef.current)
    },
    [],
  )

  return (
    <span
      className={`icon-morph${props.className ? ` ${props.className}` : ''}`}
      aria-hidden="true"
      ref={rootRef}
    >
      {icons.map((icon, index) => (
        <span
          className="icon-morph__layer"
          data-active={index === active ? '' : undefined}
          key={index}
        >
          {icon}
        </span>
      ))}
      <svg aria-hidden="true" className="icon-morph__overlay" ref={overlayRef} focusable="false" />
    </span>
  )
}
