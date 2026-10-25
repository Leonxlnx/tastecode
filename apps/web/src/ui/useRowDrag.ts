import { useLayoutEffect, useRef, type MouseEvent, type PointerEvent } from 'react'
import { performAppHaptic, prepareAppHaptics } from '../haptics.js'

type Item = { id: string; node: HTMLElement; top: number; height: number; offset: number }
type Drag = {
  id: string
  pointerId: number
  startY: number
  source: number
  target: number
  items: Item[]
  gap: number
  parent: HTMLElement
  scroller: HTMLElement | undefined
  /** Viewport edges of the scroller at pick-up; it does not resize mid-drag. */
  scrollerTop: number
  scrollerBottom: number
  scrollTop: number
  lastY: number
  started: boolean
  autoScroll: number | undefined
}

export type RowDragOptions = {
  /** Rows the dragged one may trade places with, in document order, itself included. */
  rows: (sourceId: string) => HTMLElement[]
  /** Attribute carrying a row's id. */
  attribute: string
  onReorder:
    ((sourceId: string, targetId: string, position: 'before' | 'after') => void) | undefined
  /** A pointer-down inside a match never starts a drag (row actions, menus). */
  ignore?: string
}

export type RowDrag = {
  onPointerDown: (id: string, event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
  onPointerCancel: () => void
  onLostPointerCapture: () => void
  /** Put on the list so the release that ends a drag does not select a row. */
  onClickCapture: (event: MouseEvent) => void
}

const START_DISTANCE = 5
const SCROLL_ZONE = 28
const SCROLL_SPEED = 14

function scrollParent(node: HTMLElement | null): HTMLElement | undefined {
  for (let el = node; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if (overflowY === 'auto' || overflowY === 'scroll') return el
  }
  return undefined
}

function settle(node: HTMLElement, delta: number) {
  if (!node.animate || Math.abs(delta) < 0.5) return
  const style = getComputedStyle(node)
  node.animate([{ translate: `0 ${delta}px` }, { translate: '0 0' }], {
    duration: Number.parseFloat(style.getPropertyValue('--dur-slow')) || 260,
    easing: style.getPropertyValue('--ease-rail').trim() || 'ease-out',
    composite: 'add',
  })
}

/**
 * Pointer-driven reordering of a vertical list. The held row follows the
 * pointer while the others slide aside to open its slot; the data order
 * changes only on release. Rows preview with `translate`, which composes with
 * the `transform` a virtualized row already uses for its position.
 */
export function useRowDrag(options: RowDragOptions): RowDrag {
  const latest = useRef(options)
  latest.current = options
  const drag = useRef<Drag | undefined>(undefined)
  const suppressClick = useRef(false)
  // Visual tops captured before a commit; the layout effect after it settles
  // whatever the real layout disagrees with the preview about.
  const pending = useRef<Map<string, number> | undefined>(undefined)
  const pendingHost = useRef<HTMLElement | undefined>(undefined)
  const finishRef = useRef<(commit: boolean) => void>(() => undefined)

  const handlers = useRef<RowDrag | undefined>(undefined)
  if (!handlers.current) {
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const stopAutoScroll = (current: Drag) => {
      if (current.autoScroll !== undefined) cancelAnimationFrame(current.autoScroll)
      current.autoScroll = undefined
    }

    const update = (current: Drag, clientY: number) => {
      current.lastY = clientY
      const shift = (current.scroller?.scrollTop ?? 0) - current.scrollTop
      let delta = clientY + shift - current.startY
      if (!current.started && Math.abs(delta) < START_DISTANCE) return
      if (!current.started) {
        current.started = true
        suppressClick.current = true
        current.parent.classList.add('is-row-reordering')
        // Pick the row up where it lies instead of jumping by the threshold.
        current.startY = clientY + shift
        delta = 0
        current.items[current.source]!.node.classList.add('is-row-dragging')
      }
      const { items, source: sourceIndex, gap } = current
      const source = items[sourceIndex]!
      const first = items[0]!
      const last = items.at(-1)!
      const y = Math.max(
        first.top - source.top,
        Math.min(last.top + last.height - source.height - source.top, delta),
      )
      const center = source.top + y + source.height / 2
      let target = sourceIndex
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        if (i < sourceIndex && center <= item.top + item.height / 2) {
          target = i
          break
        }
        if (i > sourceIndex && center >= item.top + item.height / 2) target = i
      }
      if (target !== current.target) performAppHaptic('alignment')
      current.target = target
      const order = [...items]
      order.splice(sourceIndex, 1)
      order.splice(target, 0, source)
      let top = first.top
      for (const item of order) {
        const offset = item === source ? y : top - item.top
        if (offset !== item.offset) {
          item.offset = offset
          item.node.classList.add(item === source ? 'is-row-dragging' : 'is-row-shifting')
          item.node.style.translate = `0 ${offset}px`
        }
        top += item.height + gap
      }
    }

    const autoScroll = (current: Drag) => {
      const { scroller } = current
      if (!scroller || !current.started) return
      const above = current.lastY - current.scrollerTop
      const below = current.scrollerBottom - current.lastY
      const speed =
        above < SCROLL_ZONE
          ? -((SCROLL_ZONE - Math.max(above, 0)) / SCROLL_ZONE) * SCROLL_SPEED
          : below < SCROLL_ZONE
            ? ((SCROLL_ZONE - Math.max(below, 0)) / SCROLL_ZONE) * SCROLL_SPEED
            : 0
      if (speed === 0) return stopAutoScroll(current)
      if (current.autoScroll !== undefined) return
      const step = () => {
        if (drag.current !== current) return
        const before = scroller.scrollTop
        scroller.scrollTop += speed
        if (scroller.scrollTop === before) return stopAutoScroll(current)
        update(current, current.lastY)
        current.autoScroll = requestAnimationFrame(step)
      }
      current.autoScroll = requestAnimationFrame(step)
    }

    const finish = (commit: boolean) => {
      const current = drag.current
      if (!current) return
      drag.current = undefined
      stopAutoScroll(current)
      if (!current.started) return
      const before = current.items.map((item) => item.node.getBoundingClientRect().top)
      for (const item of current.items) {
        item.node.style.translate = ''
        item.node.classList.remove('is-row-dragging', 'is-row-shifting')
      }
      current.parent.classList.remove('is-row-reordering')
      const moved = commit && current.target !== current.source
      if (moved && latest.current.onReorder) {
        if (!reduced()) {
          pending.current = new Map(current.items.map((item, index) => [item.id, before[index]!]))
          pendingHost.current = current.parent
          // The commit renders before the next frame; a reorder the owner
          // rejected must not settle a later, unrelated render.
          requestAnimationFrame(() => {
            pending.current = undefined
          })
        }
        const target = current.items[current.target]!
        latest.current.onReorder(
          current.id,
          target.id,
          current.target > current.source ? 'after' : 'before',
        )
        return
      }
      if (reduced()) return
      for (const [index, item] of current.items.entries()) {
        settle(item.node, before[index]! - item.node.getBoundingClientRect().top)
      }
    }

    handlers.current = {
      onClickCapture: (event) => {
        if (!suppressClick.current) return
        suppressClick.current = false
        event.preventDefault()
        event.stopPropagation()
      },
      onPointerDown: (id, event) => {
        const { rows, attribute, onReorder, ignore } = latest.current
        if (!onReorder || event.button !== 0 || drag.current) return
        if (ignore && (event.target as HTMLElement).closest(ignore)) return
        suppressClick.current = false
        const nodes = rows(id)
        const items = nodes.map((node) => {
          const bounds = node.getBoundingClientRect()
          return {
            id: node.getAttribute(attribute)!,
            node,
            top: bounds.top,
            height: bounds.height,
            offset: 0,
          }
        })
        const source = items.findIndex((item) => item.id === id)
        const parent = items[source]?.node.parentElement
        if (source < 0 || !parent) return
        const scroller = scrollParent(parent)
        const scrollerBounds = scroller?.getBoundingClientRect()
        const gap =
          items.length > 1 ? Math.max(0, items[1]!.top - items[0]!.top - items[0]!.height) : 0
        drag.current = {
          id,
          pointerId: event.pointerId,
          startY: event.clientY,
          source,
          target: source,
          items,
          gap,
          parent,
          scroller,
          scrollerTop: scrollerBounds?.top ?? 0,
          scrollerBottom: scrollerBounds?.bottom ?? 0,
          scrollTop: scroller?.scrollTop ?? 0,
          lastY: event.clientY,
          started: false,
          autoScroll: undefined,
        }
        ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
        prepareAppHaptics()
      },
      onPointerMove: (event) => {
        const current = drag.current
        if (!current || current.pointerId !== event.pointerId) return
        update(current, event.clientY)
        if (current.started) {
          event.preventDefault()
          autoScroll(current)
        }
      },
      onPointerUp: (event) => {
        if (drag.current?.pointerId === event.pointerId) finish(true)
      },
      onPointerCancel: () => finish(false),
      onLostPointerCapture: () => finish(false),
    }
    finishRef.current = finish
  }

  useLayoutEffect(() => {
    const previous = pending.current
    const host = pendingHost.current
    if (!previous || !host) return
    pending.current = undefined
    const { attribute } = latest.current
    for (const node of host.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
      const from = previous.get(node.getAttribute(attribute)!)
      if (from !== undefined) settle(node, from - node.getBoundingClientRect().top)
    }
  })

  useLayoutEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishRef.current(false)
    }
    const blur = () => finishRef.current(false)
    window.addEventListener('keydown', cancel)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', cancel)
      window.removeEventListener('blur', blur)
      finishRef.current(false)
    }
  }, [])

  return handlers.current
}
