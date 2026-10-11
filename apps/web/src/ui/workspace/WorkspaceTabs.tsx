import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTabDrag } from './useTabDrag.js'
import { performAppHaptic } from '../../haptics.js'
import { IconX } from '@tabler/icons-react'

export type WorkspaceTabLabel = { id: string; title: string; icon: ReactNode }

/** Characters a shrinking label always keeps before its ellipsis. */
const READABLE_PREFIX = 5

/**
 * Chromium never elides the first character of a line, so a tail that starts
 * with a real letter would show that letter and a clipped ellipsis. A word
 * joiner has no width and no glyph, so leading the tail with one lets the
 * ellipsis stand in for the whole tail.
 */
const ELLIPSIS_ANCHOR = '\u2060'

/**
 * A long title is split after a fixed prefix so only the rest can give way to
 * an ellipsis: a shrinking tab never reads as one letter. Shorter titles stay
 * whole. The tab's aria-label carries the title, so the split never changes
 * its accessible name.
 */
function TabLabel(props: { title: string }) {
  const characters = Array.from(props.title)
  if (characters.length <= READABLE_PREFIX + 2) {
    return <span className="workspace-tabs__label">{props.title}</span>
  }
  return (
    <span className="workspace-tabs__label workspace-tabs__label--split">
      <span className="workspace-tabs__label-head">
        {characters.slice(0, READABLE_PREFIX).join('')}
      </span>
      <span className="workspace-tabs__label-tail">
        {ELLIPSIS_ANCHOR + characters.slice(READABLE_PREFIX).join('')}
      </span>
    </span>
  )
}

/** Animate live tabs and their neighbours without resizing text or repainting widths. */
export function WorkspaceTabs(props: {
  tabs: WorkspaceTabLabel[]
  activeId?: string | undefined
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder?: (sourceId: string, targetId: string) => void
  children: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, number>())
  const animations = useRef(new Map<string, Animation>())
  const drag = useTabDrag(host, props.onReorder, positions, animations)
  const exits = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [closing, setClosing] = useState(new Set<string>())
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  useLayoutEffect(() => {
    const container = host.current
    if (!container) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const present = new Set(props.tabs.map((tab) => tab.id))
    const removed = new Set<string>()
    for (const [id, timeout] of exits.current) {
      if (present.has(id)) continue
      clearTimeout(timeout)
      exits.current.delete(id)
      animations.current.get(id)?.cancel()
      animations.current.delete(id)
      removed.add(id)
    }
    if (removed.size)
      setClosing((current) => new Set([...current].filter((id) => !removed.has(id))))
    const next = new Map<string, number>()
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-motion-id]'))
    const before = new Map<string, number>()
    for (const node of nodes) {
      const id = node.dataset['tabMotionId']!
      const previous = positions.current.get(id)
      const transform = getComputedStyle(node).transform
      const offset = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m41 : 0
      if (previous !== undefined) before.set(id, previous + offset)
      if (!exits.current.has(id)) animations.current.get(id)?.cancel()
    }
    const style = getComputedStyle(container)
    const duration = Number.parseFloat(style.getPropertyValue('--dur-fast')) || 180
    const easing = style.getPropertyValue('--ease-out').trim() || 'ease-out'
    for (const node of nodes) {
      const id = node.dataset['tabMotionId']!
      const left = node.getBoundingClientRect().left
      next.set(id, left)
      if (reduced || !node.animate || exits.current.has(id)) continue
      const previous = before.get(id)
      const delta = previous === undefined ? 0 : previous - left
      if (previous !== undefined && Math.abs(delta) < 0.5) continue
      const animation = node.animate(
        previous === undefined
          ? [
              { opacity: 0, transform: 'translateY(4px)' },
              { opacity: 1, transform: 'translateY(0)' },
            ]
          : [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
        { duration, easing },
      )
      animations.current.set(id, animation)
      void animation.finished
        .then(() => {
          if (animations.current.get(id) === animation) animations.current.delete(id)
        })
        .catch(() => undefined)
    }
    positions.current = next
  }, [props.tabs])

  useLayoutEffect(
    () => () => {
      for (const animation of animations.current.values()) animation.cancel()
      for (const timeout of exits.current.values()) clearTimeout(timeout)
    },
    [],
  )

  const close = (id: string) => {
    if (exits.current.has(id)) return
    const node = Array.from(
      host.current?.querySelectorAll<HTMLElement>('[data-tab-motion-id]') ?? [],
    ).find((element) => element.dataset['tabMotionId'] === id)
    if (!node?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose.current(id)
      return
    }
    const style = getComputedStyle(node)
    const transform = style.transform === 'none' ? 'translateY(0)' : style.transform
    const opacity = style.opacity || '1'
    animations.current.get(id)?.cancel()
    setClosing((current) => new Set(current).add(id))
    const animation = node.animate(
      [
        { opacity, transform },
        { opacity: 0, transform: 'translateY(4px)' },
      ],
      {
        duration: Number.parseFloat(style.getPropertyValue('--dur-reveal')) || 160,
        easing: style.getPropertyValue('--ease-out').trim() || 'ease-out',
        fill: 'forwards',
      },
    )
    animations.current.set(id, animation)
    const finish = () => {
      const timeout = exits.current.get(id)
      if (timeout === undefined) return
      clearTimeout(timeout)
      exits.current.delete(id)
      animations.current.delete(id)
      setClosing((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      onClose.current(id)
    }
    exits.current.set(id, setTimeout(finish, 240))
    void animation.finished.then(finish, finish)
  }

  return (
    <div ref={host} className="workspace-tabs" role="tablist" aria-label="Tool tabs">
      <div ref={drag.slot} className="workspace-tabs__landing" hidden aria-hidden />
      {props.tabs.map((tab) => (
        <div
          key={tab.id}
          data-tab-motion-id={tab.id}
          className={`workspace-tabs__tab${tab.id === props.activeId ? ' is-active' : ''}`}
          onPointerDown={(event) => drag.onPointerDown(tab.id, event)}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerCancel}
          onLostPointerCapture={drag.onLostPointerCapture}
          onClickCapture={drag.onClickCapture}
          onDragStart={(event) => event.preventDefault()}
          inert={closing.has(tab.id) ? true : undefined}
          aria-hidden={closing.has(tab.id) ? true : undefined}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault()
              close(tab.id)
            }
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === props.activeId}
            aria-label={tab.title}
            title={tab.title}
            onClick={() => props.onSelect(tab.id)}
            onKeyDown={(event) => {
              if (!event.altKey || !props.onReorder) return
              const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
              if (!direction) return
              event.preventDefault()
              const target =
                props.tabs[props.tabs.findIndex((item) => item.id === tab.id) + direction]
              if (!target || closing.has(target.id)) return
              props.onReorder(tab.id, target.id)
              performAppHaptic('alignment')
            }}
          >
            {tab.icon}
            <TabLabel title={tab.title} />
          </button>
          <button
            type="button"
            className="workspace-tabs__close"
            aria-label={`Close ${tab.title}`}
            onClick={() => close(tab.id)}
          >
            <IconX size={13} aria-hidden />
          </button>
        </div>
      ))}
      <div data-tab-motion-id="add" className="workspace-tabs__add">
        {props.children}
      </div>
    </div>
  )
}
