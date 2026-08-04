import { useEffect, useRef } from 'react'

const LIGHT = [237, 237, 237] as const
const MAX_PIXEL_RATIO = 2
const DOT_FILL = 0.42
const SPOT_INNER_RADIUS = 20
const SPOT_OUTER_RADIUS = 60
const FADE_IN_MS = 150
const FADE_OUT_MS = 140

type PointerPosition = {
  clientX: number
  clientY: number
}

type StrengthAnimation = {
  start: number
  duration: number
  from: number
  to: number
}

type DitherController = {
  setActive: (active: boolean) => void
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function smoothstep(progress: number): number {
  return progress * progress * (3 - 2 * progress)
}

function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3
}

function noiseThreshold(x: number, y: number): number {
  let hash = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263)
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177)
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296
}

function paintDither(
  canvas: HTMLCanvasElement,
  bloomCanvas: HTMLCanvasElement,
  width: number,
  height: number,
  cell: number,
  pointer: { x: number; y: number } | null,
  strength: number,
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

  const pointerX = pointer ? pointer.x * pixelRatio : Number.POSITIVE_INFINITY
  const pointerY = pointer ? pointer.y * pixelRatio : Number.POSITIVE_INFINITY
  const innerRadius = SPOT_INNER_RADIUS * pixelRatio
  const outerRadius = SPOT_OUTER_RADIUS * pixelRatio

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const threshold = noiseThreshold(x, y)
      const cellCenterX = x * cellSize + cellSize / 2
      const cellCenterY = y * cellSize + cellSize / 2
      const distance = Math.hypot(cellCenterX - pointerX, cellCenterY - pointerY)
      const radialProgress = smoothstep(
        clamp01((outerRadius - distance) / Math.max(1, outerRadius - innerRadius)),
      )
      const spotDensity = radialProgress * strength * 0.5
      const isBright = threshold <= spotDensity
      if (!isBright && threshold > 0.5) continue

      const alpha = Math.min(1, 0.025 + (isBright ? strength * 0.88 : 0))
      context.fillStyle = `rgba(${LIGHT[0]},${LIGHT[1]},${LIGHT[2]},${alpha})`
      context.fillRect(x * cellSize + dotInset, y * cellSize + dotInset, dotSize, dotSize)
    }
  }

  bloomContext.clearRect(0, 0, canvasWidth, canvasHeight)
  bloomContext.drawImage(canvas, 0, 0)
}

export function DitherSlider({ active, cell = 4 }: { active: boolean; cell?: number }) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const ditherRef = useRef<HTMLCanvasElement>(null)
  const bloomRef = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(active)
  const controllerRef = useRef<DitherController | null>(null)

  useEffect(() => {
    activeRef.current = active
    controllerRef.current?.setActive(active)
  }, [active])

  useEffect(() => {
    const wrapper = wrapperRef.current
    const dither = ditherRef.current
    const bloom = bloomRef.current
    if (!wrapper || !dither || !bloom) return

    const interactionSurface = wrapper.closest<HTMLElement>('.model-selector__slider')
    const mediaQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
    let reducedMotion = Boolean(mediaQuery?.matches)
    let pointer: PointerPosition | null = null
    let strength = 0
    let strengthAnimation: StrengthAnimation | null = null
    let animationFrame: number | null = null

    const useAnimationFrame =
      typeof window.requestAnimationFrame === 'function' &&
      /\[native code\]/.test(String(window.requestAnimationFrame))
    const requestFrame = (callback: FrameRequestCallback) =>
      useAnimationFrame
        ? window.requestAnimationFrame(callback)
        : window.setTimeout(() => callback(performance.now()), 16)
    const cancelFrame = (handle: number) => {
      if (useAnimationFrame) {
        window.cancelAnimationFrame(handle)
      } else {
        window.clearTimeout(handle)
      }
    }

    const getLocalPointer = () => {
      if (!pointer) return null
      const rect = wrapper.getBoundingClientRect()
      return {
        x: pointer.clientX - rect.left,
        y: pointer.clientY - rect.top,
      }
    }

    const paint = () => {
      paintDither(
        dither,
        bloom,
        wrapper.clientWidth,
        wrapper.clientHeight,
        cell,
        getLocalPointer(),
        strength,
      )
    }

    const sampleStrength = (now: number) => {
      if (!strengthAnimation) return
      const progress = clamp01((now - strengthAnimation.start) / strengthAnimation.duration)
      const easedProgress = easeOutCubic(progress)
      strength =
        strengthAnimation.from + (strengthAnimation.to - strengthAnimation.from) * easedProgress
      if (progress === 1) {
        strength = strengthAnimation.to
        strengthAnimation = null
      }
    }

    const scheduleFrame = () => {
      if (animationFrame !== null) return
      animationFrame = requestFrame((now) => {
        animationFrame = null
        sampleStrength(now)
        paint()
        if (strengthAnimation) {
          scheduleFrame()
        }
      })
    }

    const stopAnimationFrame = () => {
      if (animationFrame === null) return
      cancelFrame(animationFrame)
      animationFrame = null
    }

    const isPointerNear = () => {
      if (!pointer) return false
      const rect = wrapper.getBoundingClientRect()
      const distanceX =
        pointer.clientX < rect.left
          ? rect.left - pointer.clientX
          : Math.max(0, pointer.clientX - rect.right)
      const distanceY =
        pointer.clientY < rect.top
          ? rect.top - pointer.clientY
          : Math.max(0, pointer.clientY - rect.bottom)
      return Math.hypot(distanceX, distanceY) <= SPOT_OUTER_RADIUS
    }

    const setStrengthTarget = (target: number) => {
      const now = performance.now()
      sampleStrength(now)
      if (reducedMotion) {
        strengthAnimation = null
        strength = target
        stopAnimationFrame()
        paint()
        return
      }

      if (strengthAnimation?.to === target || (!strengthAnimation && strength === target)) {
        scheduleFrame()
        return
      }

      strengthAnimation = {
        start: now,
        duration: target > strength ? FADE_IN_MS : FADE_OUT_MS,
        from: strength,
        to: target,
      }
      scheduleFrame()
    }

    const updateStrengthTarget = () => {
      setStrengthTarget(activeRef.current || isPointerNear() ? 1 : 0)
    }

    const handlePointer = (event: PointerEvent) => {
      pointer = {
        clientX: event.clientX,
        clientY: event.clientY,
      }
      updateStrengthTarget()
    }

    const handlePointerExit = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return
      pointer = null
      setStrengthTarget(0)
    }

    const handleWindowBlur = () => {
      pointer = null
      setStrengthTarget(0)
    }

    const handleGeometryChange = () => {
      updateStrengthTarget()
      scheduleFrame()
    }

    const controller: DitherController = {
      setActive() {
        updateStrengthTarget()
      },
    }
    controllerRef.current = controller

    const handleMotionChange = () => {
      reducedMotion = Boolean(mediaQuery?.matches)
      strengthAnimation = null
      strength = activeRef.current || isPointerNear() ? 1 : 0
      stopAnimationFrame()
      paint()
    }

    paint()

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleGeometryChange)
    observer?.observe(wrapper)
    window.addEventListener('pointermove', handlePointer, { passive: true })
    window.addEventListener('pointerdown', handlePointer, { passive: true })
    window.addEventListener('pointerout', handlePointerExit)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('resize', handleGeometryChange)
    interactionSurface?.addEventListener('pointerenter', handlePointer, { passive: true })
    if (typeof mediaQuery?.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleMotionChange)
    } else {
      mediaQuery?.addListener?.(handleMotionChange)
    }

    return () => {
      observer?.disconnect()
      window.removeEventListener('pointermove', handlePointer)
      window.removeEventListener('pointerdown', handlePointer)
      window.removeEventListener('pointerout', handlePointerExit)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('resize', handleGeometryChange)
      interactionSurface?.removeEventListener('pointerenter', handlePointer)
      if (typeof mediaQuery?.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMotionChange)
      } else {
        mediaQuery?.removeListener?.(handleMotionChange)
      }
      stopAnimationFrame()
      if (controllerRef.current === controller) {
        controllerRef.current = null
      }
    }
  }, [cell])

  return (
    <div ref={wrapperRef} aria-hidden className={`dither-slider${active ? ' is-active' : ''}`}>
      <canvas ref={ditherRef} className="dither-slider__canvas dither-slider__texture" />
      <canvas ref={bloomRef} className="dither-slider__canvas dither-slider__bloom" />
    </div>
  )
}
