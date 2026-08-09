import { useEffect, useRef } from 'react'

const MAX_PIXEL_RATIO = 2
const DOT_FILL = 0.5
const MIN_DENSITY = 0.08
const MAX_DENSITY = 0.68

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((value) => (value + 0.5) / 16))

export type DitherAreaSeries = Readonly<{
  provider: string
  areaPath: string
  areaTop: number
  areaBottom: number
}>

type DitherAreaChartController = {
  paint: () => void
}

function paintDitherAreas(
  canvas: HTMLCanvasElement,
  bloomCanvas: HTMLCanvasElement,
  wrapper: HTMLElement,
  series: readonly DitherAreaSeries[],
  viewBoxWidth: number,
  viewBoxHeight: number,
  plotLeft: number,
  plotRight: number,
  cell: number,
) {
  const context = canvas.getContext('2d')
  const bloomContext = bloomCanvas.getContext('2d')
  if (
    !context ||
    !bloomContext ||
    typeof Path2D === 'undefined' ||
    wrapper.clientWidth <= 0 ||
    wrapper.clientHeight <= 0
  ) {
    return
  }

  const width = wrapper.clientWidth
  const height = wrapper.clientHeight
  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
  const canvasWidth = Math.max(1, Math.round(width * pixelRatio))
  const canvasHeight = Math.max(1, Math.round(height * pixelRatio))
  const chartScale = Math.min(width / viewBoxWidth, height / viewBoxHeight)
  const offsetX = (width - viewBoxWidth * chartScale) / 2
  const offsetY = (height - viewBoxHeight * chartScale) / 2
  const cellSize = Math.max(2, cell)
  const dotSize = Math.max(1, cellSize * DOT_FILL)
  const dotInset = (cellSize - dotSize) / 2

  if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
    canvas.width = canvasWidth
    canvas.height = canvasHeight
  }
  if (bloomCanvas.width !== canvasWidth || bloomCanvas.height !== canvasHeight) {
    bloomCanvas.width = canvasWidth
    bloomCanvas.height = canvasHeight
  }

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.imageSmoothingEnabled = false
  context.clearRect(0, 0, canvasWidth, canvasHeight)

  for (const area of series) {
    if (!area.areaPath || area.areaBottom <= area.areaTop) continue
    const swatch = wrapper.querySelector<HTMLElement>(
      `.dither-area-chart__swatch[data-provider="${area.provider}"]`,
    )
    if (!swatch) continue
    const color = window.getComputedStyle(swatch).color
    const top = offsetY + area.areaTop * chartScale
    const bottom = offsetY + area.areaBottom * chartScale
    const left = offsetX + plotLeft * chartScale
    const right = offsetX + plotRight * chartScale
    const firstColumn = Math.floor(left / cellSize)
    const lastColumn = Math.ceil(right / cellSize)
    const firstRow = Math.floor(top / cellSize)
    const lastRow = Math.ceil(bottom / cellSize)

    context.save()
    context.setTransform(
      pixelRatio * chartScale,
      0,
      0,
      pixelRatio * chartScale,
      offsetX * pixelRatio,
      offsetY * pixelRatio,
    )
    context.clip(new Path2D(area.areaPath))
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.fillStyle = color
    context.globalAlpha = 0.82

    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = row * cellSize
      const progress = Math.min(1, Math.max(0, (y + cellSize / 2 - top) / (bottom - top)))
      const density = MAX_DENSITY + (MIN_DENSITY - MAX_DENSITY) * progress
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        if (BAYER[row & 3]![column & 3]! > density) continue
        context.fillRect(column * cellSize + dotInset, y + dotInset, dotSize, dotSize)
      }
    }
    context.restore()
  }

  bloomContext.setTransform(1, 0, 0, 1, 0, 0)
  bloomContext.imageSmoothingEnabled = false
  bloomContext.clearRect(0, 0, canvasWidth, canvasHeight)
  bloomContext.drawImage(canvas, 0, 0)
}

export function DitherAreaChart(props: {
  series: readonly DitherAreaSeries[]
  viewBoxWidth: number
  viewBoxHeight: number
  plotLeft: number
  plotRight: number
  cell?: number
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const ditherRef = useRef<HTMLCanvasElement>(null)
  const bloomRef = useRef<HTMLCanvasElement>(null)
  const seriesRef = useRef(props.series)
  const controllerRef = useRef<DitherAreaChartController | null>(null)

  useEffect(() => {
    seriesRef.current = props.series
    controllerRef.current?.paint()
  }, [props.series])

  useEffect(() => {
    const wrapper = wrapperRef.current
    const dither = ditherRef.current
    const bloom = bloomRef.current
    if (!wrapper || !dither || !bloom) return

    const paint = () => {
      paintDitherAreas(
        dither,
        bloom,
        wrapper,
        seriesRef.current,
        props.viewBoxWidth,
        props.viewBoxHeight,
        props.plotLeft,
        props.plotRight,
        props.cell ?? 4,
      )
    }
    const controller: DitherAreaChartController = { paint }
    controllerRef.current = controller

    paint()
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(paint)
    resizeObserver?.observe(wrapper)
    const themeObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            if (records.some((record) => record.type === 'attributes')) paint()
          })
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    })
    window.addEventListener('resize', paint)

    return () => {
      resizeObserver?.disconnect()
      themeObserver?.disconnect()
      window.removeEventListener('resize', paint)
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [props.cell, props.plotLeft, props.plotRight, props.viewBoxHeight, props.viewBoxWidth])

  return (
    <div ref={wrapperRef} className="dither-area-chart" aria-hidden>
      <canvas ref={ditherRef} className="dither-area-chart__canvas dither-area-chart__texture" />
      <canvas ref={bloomRef} className="dither-area-chart__canvas dither-area-chart__bloom" />
      <span className="dither-area-chart__palette">
        {props.series.map((area) => (
          <i
            className="dither-area-chart__swatch"
            data-provider={area.provider}
            key={area.provider}
          />
        ))}
      </span>
    </div>
  )
}
