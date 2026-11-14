/**
 * Script-driven motion for the new design. Used where an animation moves
 * text: it's stepped by whole pixels from here, because the browser draws
 * text on whole pixels while boxes land on fractions, and anything moved by
 * fractions (or by a transform on its own layer) shudders or blurs until it
 * stops.
 */

/** A CSS cubic-bezier() as a function of progress (0–1). */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  return (x: number) => {
    let lo = 0
    let hi = 1
    let t = x
    for (let i = 0; i < 24; i++) {
      t = (lo + hi) / 2
      if (at(x1, x2, t) < x) lo = t
      else hi = t
    }
    return at(y1, y2, t)
  }
}

/**
 * Runs a number from `from` to `to` over `duration` ms, calling onFrame
 * every frame (round there if it drives pixels) and onDone at the end.
 * Returns a cancel function that stops it where it is, without onDone.
 */
export function tween(
  from: number,
  to: number,
  duration: number,
  ease: (t: number) => number,
  onFrame: (value: number) => void,
  onDone?: () => void,
): () => void {
  const start = performance.now()
  let frame = 0
  const step = (now: number) => {
    const p = Math.min(1, Math.max(0, (now - start) / duration))
    onFrame(from + (to - from) * ease(p))
    if (p < 1) frame = requestAnimationFrame(step)
    else onDone?.()
  }
  onFrame(from)
  frame = requestAnimationFrame(step)
  return () => cancelAnimationFrame(frame)
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
