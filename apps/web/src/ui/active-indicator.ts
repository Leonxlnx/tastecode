/**
 * One active-chat indicator that slides from row to row.
 *
 * Only the active row renders the pill. When the active chat changes, the old
 * pill detaches (React's mutation phase) and the new one attaches (the layout
 * phase) inside the same commit, so the new pill can start where the old one
 * stood and glide home on a compositor-only transform. Layout is read only at
 * that hand-over, never while an answer streams.
 */
const SLIDE_MS = 220
/** --ease-rail */
const SLIDE_EASING = 'cubic-bezier(.32, .72, 0, 1)'

let handOver: DOMRect | undefined

/** A ref callback with a stable identity, so React never re-runs it on a re-render. */
export function activeIndicatorRef(node: HTMLElement | null): (() => void) | undefined {
  if (!node) return undefined
  const from = handOver
  handOver = undefined
  if (from) slideFrom(node, from)

  return () => {
    const rect = node.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    handOver = rect
    // Only a hand-over inside this commit counts. A row that leaves a virtual
    // list and scrolls back later must not fly in from where it left.
    queueMicrotask(() => {
      if (handOver === rect) handOver = undefined
    })
  }
}

function slideFrom(node: HTMLElement, from: DOMRect): void {
  if (typeof node.animate !== 'function') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const to = node.getBoundingClientRect()
  if (to.width === 0 || to.height === 0) return
  const dx = from.left - to.left
  const dy = from.top - to.top
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
  node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
    duration: SLIDE_MS,
    easing: SLIDE_EASING,
  })
}
