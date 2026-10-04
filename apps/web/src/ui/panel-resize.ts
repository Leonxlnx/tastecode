import { appHapticsEnabled, performAppHaptic, ResizeHaptics } from '../haptics.js'

type PanelResizeOptions = {
  axis: 'clientX' | 'clientY'
  initialSize: number
  minSize: number
  maxSize: number
  style: CSSStyleDeclaration | undefined
  property: string
  onResize?: (size: number) => void
  onFinish: (size: number, commit: boolean) => void
}

/** Track a right or bottom panel once per frame; disposal cancels unpainted work. */
export function beginPanelResize(
  event: Pick<PointerEvent, 'clientX' | 'clientY' | 'timeStamp'>,
  options: PanelResizeOptions,
): () => void {
  const start = event[options.axis]
  const haptics = appHapticsEnabled()
    ? new ResizeHaptics({
        startValue: options.initialSize,
        startTime: event.timeStamp,
        minValue: options.minSize,
        maxValue: options.maxSize,
      })
    : undefined
  let size = options.initialSize
  let frame: number | undefined
  let pending: { rawValue: number; value: number; time: number } | undefined
  let active = true

  const applyPending = () => {
    frame = undefined
    const sample = pending
    pending = undefined
    if (!sample) return
    const changed = sample.value !== size
    if (changed) {
      size = sample.value
      options.onResize?.(size)
      options.style?.setProperty(options.property, `${size}px`)
    }
    const feedback = haptics?.sample({ ...sample, tracking: !!options.style && changed })
    if (feedback) performAppHaptic(feedback)
  }
  const move = (next: PointerEvent) => {
    const rawValue = options.initialSize + start - next[options.axis]
    const value = Math.min(options.maxSize, Math.max(options.minSize, rawValue))
    pending = { rawValue, value, time: next.timeStamp }
    if (frame === undefined) frame = requestAnimationFrame(applyPending)
  }
  const cleanup = (commit: boolean) => {
    if (!active) return
    active = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    window.removeEventListener('blur', finish)
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    if (commit) applyPending()
    else pending = undefined
    options.onFinish(size, commit)
  }
  const finish = () => cleanup(true)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish, { once: true })
  window.addEventListener('pointercancel', finish, { once: true })
  window.addEventListener('blur', finish, { once: true })
  return () => cleanup(false)
}
