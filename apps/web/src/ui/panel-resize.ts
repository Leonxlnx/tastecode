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
  // A saved size can exceed the space now available, where CSS draws the panel clamped;
  // the drag starts from that drawn size so the first movement already resizes.
  const startSize = Math.min(options.maxSize, Math.max(options.minSize, options.initialSize))
  const haptics = appHapticsEnabled()
    ? new ResizeHaptics({
        startValue: startSize,
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
    const rawValue = startSize + start - next[options.axis]
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

/**
 * Eases a right or bottom panel from the size it is drawn at to another one,
 * writing the same inline property a drag writes once per frame, then calls
 * onFinish. Reduced motion jumps straight there. Disposal stops it where it is.
 */
export function settlePanelSize(options: {
  from: number
  to: number
  style: CSSStyleDeclaration | undefined
  property: string
  onFinish: () => void
}): () => void {
  const duration = 200
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced || !options.style || Math.abs(options.to - options.from) < 1) {
    options.style?.setProperty(options.property, `${options.to}px`)
    options.onFinish()
    return () => {}
  }
  const style = options.style
  let start: number | undefined
  let frame = requestAnimationFrame(function step(now) {
    start ??= now
    const progress = Math.min(1, (now - start) / duration)
    // Ease out: most of the travel early, settling gently at the end.
    const eased = 1 - (1 - progress) ** 3
    style.setProperty(
      options.property,
      `${Math.round(options.from + (options.to - options.from) * eased)}px`,
    )
    if (progress < 1) frame = requestAnimationFrame(step)
    else options.onFinish()
  })
  return () => cancelAnimationFrame(frame)
}
