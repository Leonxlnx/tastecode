/** Where the new design's menus open. */

const GAP = 6
/** A dropdown panel's padding plus its border: how far its first row sits from its top. */
export const PANEL_INSET = 5

/**
 * Beside a rect: to its right with top edges lined up (less `inset`, so the
 * panel's first row lines up instead of its border), or to its left when
 * there's no room. At a point: down and to the right of it, or to the left.
 * Always kept on screen.
 */
export function placeBeside(
  anchor: DOMRect | { x: number; y: number },
  width: number,
  height: number,
  inset = PANEL_INSET,
) {
  let left: number
  let top: number
  let flipped = false
  if (anchor instanceof DOMRect) {
    left = anchor.right + GAP
    top = anchor.top - inset
    if (left + width > innerWidth - 8) {
      left = anchor.left - GAP - width
      flipped = true
    }
  } else {
    left = anchor.x
    top = anchor.y
    if (left + width > innerWidth - 8) {
      left = anchor.x - width
      flipped = true
    }
  }
  return {
    left: Math.max(8, left),
    top: Math.max(8, Math.min(top, innerHeight - height - 8)),
    flipped,
  }
}
