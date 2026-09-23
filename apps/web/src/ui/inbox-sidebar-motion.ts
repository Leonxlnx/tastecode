import { useLayoutEffect, useRef, type RefObject } from 'react'

const MOTION_MS = 150
const MAX_ANIMATED_ROWS = 40
const MAX_ENTRY_OFFSET = 40
const EASING = 'cubic-bezier(0.23, 1, 0.32, 1)'

/**
 * Slides rows to their new place when the thread order changes (settle, wake,
 * pin, a new thread). Positions are read only on commits whose `orderKey`
 * changed, so status and clock updates never measure layout. Rows and section
 * headings are the list's `[data-motion-key]` descendants; a key that changes
 * (a card becoming a settled row) fades in where it lands instead of sliding.
 */
export function useListMotion(list: RefObject<HTMLElement | null>, orderKey: string): void {
  const positions = useRef(new Map<string, number>())
  const previousKey = useRef<string | undefined>(undefined)
  const previousList = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    // A remounted list (after search) has nothing on screen to move from.
    const first = previousList.current !== element
    if (!first && previousKey.current === orderKey) return
    previousList.current = element
    previousKey.current = orderKey

    const rows = element.querySelectorAll<HTMLElement>('[data-motion-key]')
    const next = new Map<string, number>()
    for (const row of rows) next.set(row.dataset['motionKey']!, row.offsetTop)
    const previous = positions.current
    positions.current = next
    if (first || previous.size === 0 || reducedMotion()) return

    const moves: Array<{ row: HTMLElement; from: number; fade: boolean }> = []
    let entryOffset: number | undefined
    for (const row of rows) {
      const key = row.dataset['motionKey']!
      const top = next.get(key)!
      const before = previous.get(key)
      if (before === undefined) {
        moves.push({ row, from: 0, fade: true })
        continue
      }
      const delta = before - top
      if (delta !== 0) {
        moves.push({ row, from: delta, fade: false })
        entryOffset ??= delta
      }
    }
    if (moves.length === 0 || moves.length > MAX_ANIMATED_ROWS) return

    // New rows travel with their neighbours, so an arriving block reads as one move.
    const arrival = Math.max(-MAX_ENTRY_OFFSET, Math.min(MAX_ENTRY_OFFSET, entryOffset ?? 8))
    for (const { row, from, fade } of moves) {
      row.animate?.(
        fade
          ? [
              { opacity: 0, transform: `translateY(${arrival}px)` },
              { opacity: 1, transform: 'translateY(0)' },
            ]
          : [{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
        { duration: MOTION_MS, easing: EASING },
      )
    }
  })
}

function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
