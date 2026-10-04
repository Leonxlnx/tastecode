import { useLayoutEffect, useRef, type PointerEvent, type RefObject } from 'react'
import { performAppHaptic, prepareAppHaptics } from '../../haptics.js'

type Item = { id: string; node: HTMLElement; left: number; width: number }
type Drag = {
  id: string
  pointerId: number
  startX: number
  source: number
  target: number
  items: Item[]
  node: HTMLElement
  started: boolean
  scrollLeft: number
}

/** Preview order with transforms; commit the data order only when released. */
export function useTabDrag(
  host: RefObject<HTMLDivElement | null>,
  onReorder: ((source: string, target: string) => void) | undefined,
  positions: RefObject<Map<string, number>>,
  animations: RefObject<Map<string, Animation>>,
) {
  const drag = useRef<Drag | undefined>(undefined)
  const slot = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false)

  const finish = (commit: boolean) => {
    const current = drag.current
    if (!current) return
    drag.current = undefined
    if (!current.started) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const before = current.items.map((item) => item.node.getBoundingClientRect().left)
    for (const [index, item] of current.items.entries()) {
      item.node.style.transition = 'none'
      item.node.style.transform = ''
      item.node.classList.remove('is-tab-dragging', 'is-tab-shifting')
      positions.current.set(item.id, before[index]!)
    }
    host.current?.classList.remove('is-tab-reordering')
    if (slot.current) slot.current.hidden = true
    if (commit && current.target !== current.source) {
      onReorder?.(current.id, current.items[current.target]!.id)
    } else {
      for (const [index, item] of current.items.entries()) {
        const delta = before[index]! - item.node.getBoundingClientRect().left
        positions.current.set(item.id, item.node.getBoundingClientRect().left)
        if (!reduced && item.node.animate && Math.abs(delta) > 0.5) {
          const style = getComputedStyle(item.node)
          const animation = item.node.animate(
            [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
            {
              duration: Number.parseFloat(style.getPropertyValue('--dur-fast')) || 180,
              easing: style.getPropertyValue('--ease-out').trim() || 'ease-out',
            },
          )
          animations.current.set(item.id, animation)
          void animation.finished
            .then(() => {
              if (animations.current.get(item.id) === animation) animations.current.delete(item.id)
            })
            .catch(() => undefined)
        }
      }
    }
    for (const item of current.items) item.node.style.transition = ''
  }
  const finishRef = useRef(finish)
  finishRef.current = finish
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
      drag.current = undefined
    }
  }, [])

  return {
    slot,
    onClickCapture: (event: React.MouseEvent) => {
      if (!suppressClick.current) return
      suppressClick.current = false
      event.preventDefault()
      event.stopPropagation()
    },
    onPointerDown: (id: string, event: PointerEvent<HTMLDivElement>) => {
      if (
        !onReorder ||
        event.button !== 0 ||
        drag.current ||
        (event.target as HTMLElement).closest('.workspace-tabs__close')
      )
        return
      suppressClick.current = false
      const nodes = Array.from(host.current!.querySelectorAll<HTMLElement>('.workspace-tabs__tab'))
      if (nodes.some((node) => node.inert)) return
      for (const animation of animations.current.values()) animation.cancel()
      animations.current.clear()
      const items = nodes.map((node) => ({
        id: node.dataset['tabMotionId']!,
        node,
        left: node.getBoundingClientRect().left,
        width: node.getBoundingClientRect().width,
      }))
      const source = items.findIndex((item) => item.id === id)
      drag.current = {
        id,
        source,
        target: source,
        items,
        node: event.currentTarget,
        pointerId: event.pointerId,
        startX: event.clientX,
        started: false,
        scrollLeft: host.current!.scrollLeft,
      }
      ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
      prepareAppHaptics()
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const current = drag.current
      const container = host.current
      if (!current || !container || current.pointerId !== event.pointerId) return
      const delta = event.clientX - current.startX + container.scrollLeft - current.scrollLeft
      if (!current.started && Math.abs(delta) < 5) return
      current.started = true
      suppressClick.current = true
      event.preventDefault()
      container.classList.add('is-tab-reordering')
      const source = current.items[current.source]!
      const last = current.items.at(-1)!
      const x = Math.max(
        current.items[0]!.left - source.left,
        Math.min(last.left + last.width - source.width - source.left, delta),
      )
      const center = source.left + delta + source.width / 2
      let target = current.source
      for (let i = 0; i < current.items.length; i++) {
        const item = current.items[i]!
        if (i < current.source && center <= item.left + item.width / 2) {
          target = i
          break
        }
        if (i > current.source && center >= item.left + item.width / 2) target = i
      }
      if (target !== current.target) performAppHaptic('alignment')
      current.target = target
      const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0
      const order = [...current.items]
      order.splice(current.source, 1)
      order.splice(target, 0, source)
      let left = current.items[0]!.left
      for (const item of order) {
        if (item === source) {
          item.node.classList.add('is-tab-dragging')
          item.node.style.transform = `translateX(${x}px)`
          if (slot.current) {
            slot.current.hidden = false
            slot.current.style.width = `${source.width}px`
            slot.current.style.transform = `translateX(${left - container.getBoundingClientRect().left + container.scrollLeft}px)`
          }
        } else {
          item.node.classList.add('is-tab-shifting')
          item.node.style.transform = `translateX(${left - item.left}px)`
        }
        left += item.width + gap
      }
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.pointerId === event.pointerId) finish(true)
    },
    onPointerCancel: () => finish(false),
    onLostPointerCapture: () => finish(false),
  }
}
