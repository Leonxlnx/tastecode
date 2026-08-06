import { useEffect, useRef } from 'react'

const LIGHT = [237, 237, 237] as const
const MAX_PIXEL_RATIO = 2
const DOT_FILL = 0.5

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((value) => (value + 0.5) / 16))

type DitherWaveformController = {
  paint: () => void
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function smoothedLevel(levels: readonly number[], index: number): number {
  const current = levels[index] ?? 0
  const previous = levels[index - 1] ?? current
  const next = levels[index + 1] ?? current
  return previous * 0.2 + current * 0.6 + next * 0.2
}

function paintDitherWaveform(
  canvas: HTMLCanvasElement,
  bloomCanvas: HTMLCanvasElement,
  width: number,
  height: number,
  levels: readonly number[],
  cell: number,
) {
  const context = canvas.getContext('2d')
  const bloomContext = bloomCanvas.getContext('2d')
  if (!context || !bloomContext || width <= 0 || height <= 0) return

  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
  const canvasWidth = Math.max(1, Math.round(width * pixelRatio))
  const canvasHeight = Math.max(1, Math.round(height * pixelRatio))
  const cellSize = Math.max(1, Math.round(cell * pixelRatio))
  const columns = Math.max(4, Math.ceil(canvasWidth / cellSize))
  const rows = Math.max(4, Math.ceil(canvasHeight / cellSize))
  const dotSize = Math.max(1, Math.round(cellSize * DOT_FILL))
  const dotInset = Math.round((cellSize - dotSize) / 2)

  if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
    canvas.width = canvasWidth
    canvas.height = canvasHeight
  }
  if (bloomCanvas.width !== canvasWidth || bloomCanvas.height !== canvasHeight) {
    bloomCanvas.width = canvasWidth
    bloomCanvas.height = canvasHeight
  }

  context.imageSmoothingEnabled = false
  bloomContext.imageSmoothingEnabled = false
  context.clearRect(0, 0, canvasWidth, canvasHeight)

  const visibleLevels = levels.slice(-columns)
  const firstLevelColumn = columns - visibleLevels.length
  const centerY = canvasHeight / 2

  for (let x = 0; x < columns; x += 1) {
    const levelIndex = x - firstLevelColumn
    const hasLevel = levelIndex >= 0
    const level = hasLevel
      ? Math.pow(clamp01(smoothedLevel(visibleLevels, levelIndex) * 1.6), 0.72)
      : 0
    const envelopeRadius = cellSize * (0.7 + level * Math.max(0.5, rows / 2 - 0.8))

    for (let y = 0; y < rows; y += 1) {
      const cellCenterY = y * cellSize + cellSize / 2
      const distanceFromCenter = Math.abs(cellCenterY - centerY)
      const baselineDensity = distanceFromCenter <= cellSize * 0.34 ? 0.18 : 0
      const envelopeDensity = hasLevel
        ? clamp01(1 - distanceFromCenter / Math.max(1, envelopeRadius)) * (0.48 + level * 0.52)
        : 0
      const density = Math.max(baselineDensity, envelopeDensity)
      const threshold = BAYER[y & 3]![x & 3]!
      if (density <= threshold) continue

      const alpha = hasLevel ? Math.min(1, 0.16 + envelopeDensity * 0.7 + level * 0.14) : 0.08
      context.fillStyle = `rgba(${LIGHT[0]},${LIGHT[1]},${LIGHT[2]},${alpha})`
      context.fillRect(x * cellSize + dotInset, y * cellSize + dotInset, dotSize, dotSize)
    }
  }

  bloomContext.clearRect(0, 0, canvasWidth, canvasHeight)
  bloomContext.drawImage(canvas, 0, 0)
}

export function DitherWaveform({ levels, cell = 4 }: { levels: readonly number[]; cell?: number }) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const ditherRef = useRef<HTMLCanvasElement>(null)
  const bloomRef = useRef<HTMLCanvasElement>(null)
  const levelsRef = useRef(levels)
  const controllerRef = useRef<DitherWaveformController | null>(null)

  useEffect(() => {
    levelsRef.current = levels
    controllerRef.current?.paint()
  }, [levels])

  useEffect(() => {
    const wrapper = wrapperRef.current
    const dither = ditherRef.current
    const bloom = bloomRef.current
    if (!wrapper || !dither || !bloom) return

    const paint = () => {
      paintDitherWaveform(
        dither,
        bloom,
        wrapper.clientWidth,
        wrapper.clientHeight,
        levelsRef.current,
        cell,
      )
    }
    const controller: DitherWaveformController = { paint }
    controllerRef.current = controller

    paint()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(paint)
    observer?.observe(wrapper)
    window.addEventListener('resize', paint)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', paint)
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [cell])

  return (
    <div ref={wrapperRef} className="dither-waveform" aria-hidden>
      <canvas className="dither-waveform__canvas dither-waveform__texture" ref={ditherRef} />
      <canvas className="dither-waveform__canvas dither-waveform__bloom" ref={bloomRef} />
    </div>
  )
}
