import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTabDrag } from './useTabDrag.js'
import { performAppHaptic } from '../../haptics.js'
import { IconX } from '@tabler/icons-react'

export type WorkspaceTabLabel = {
  id: string
  title: string
  icon: ReactNode
  /** Hover text when it says more than the title, e.g. a page's full URL. */
  tooltip?: string | undefined
  /** Accessible name when the title alone is ambiguous, e.g. "Browser: Docs". */
  accessibleName?: string | undefined
}

/** Characters a shrinking label always keeps before its ellipsis. */
const READABLE_PREFIX = 5

/**
 * A long title is split after a fixed prefix so only the rest can give way to
 * an ellipsis: a shrinking tab never reads as one letter. Shorter titles stay
 * whole. The split keeps the tab's text the plain title (the stylesheet adds
 * the tail's ellipsis anchor as generated content), and the tab's aria-label
 * carries the title too, so its accessible name never changes.
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
        {characters.slice(READABLE_PREFIX).join('')}
      </span>
    </span>
  )
}

export type WorkspaceTabsFit = 'labels' | 'compact'

/**
 * Chooses how a tab strip fits and records it on the strip's data-fit:
 * "labels" while every tab fits with at least its readable prefix, otherwise
 * "compact", where inactive tabs keep only their icon; only a compact strip
 * that still overflows scrolls. The labelled layout is what gets measured, in
 * either mode, so the choice depends on the strip's width and tabs alone and
 * cannot flip back and forth at a boundary. A compact strip is measured by
 * switching it to labels for one synchronous layout, before anything paints;
 * the attribute only ends up changed when the mode does.
 */
export function fitWorkspaceTabs(strip: HTMLElement): WorkspaceTabsFit {
  if (strip.dataset['fit'] === 'compact') strip.dataset['fit'] = 'labels'
  // A pixel of slack absorbs subpixel rounding in scrollWidth.
  const fit: WorkspaceTabsFit = strip.scrollWidth - strip.clientWidth > 1 ? 'compact' : 'labels'
  if (strip.dataset['fit'] !== fit) strip.dataset['fit'] = fit
  return fit
}

/**
 * Scrolls an overflowing strip just far enough to show the active tab whole,
 * and the add button too when the active tab is the last one, which is where
 * a newly opened tab lands. A strip that fits is left alone.
 */
export function revealActiveTab(strip: HTMLElement): void {
  if (strip.scrollWidth <= strip.clientWidth) return
  const active = strip.querySelector<HTMLElement>('.workspace-tabs__tab.is-active')
  if (!active) return
  const next = active.nextElementSibling
  const last =
    next instanceof HTMLElement && next.classList.contains('workspace-tabs__add') ? next : active
  const style = getComputedStyle(strip)
  const start = active.offsetLeft - (Number.parseFloat(style.paddingLeft) || 0)
  const end = last.offsetLeft + last.offsetWidth + (Number.parseFloat(style.paddingRight) || 0)
  if (start < strip.scrollLeft) strip.scrollLeft = start
  else if (end > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = end - strip.clientWidth
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

  // Stable, so the observer below is created once per mount. It runs when the
  // strip resizes or its tabs change, never per streamed message: the tab list
  // is memoized on the panel's tabs.
  const fit = useCallback(() => {
    if (!host.current) return
    fitWorkspaceTabs(host.current)
    revealActiveTab(host.current)
  }, [])
  useLayoutEffect(() => {
    const strip = host.current
    if (!strip || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [fit])
  // Before the motion effect below, so tabs animate into the chosen mode. The
  // active tab matters for what is revealed, not for the mode.
  useLayoutEffect(fit, [fit, props.tabs, props.activeId])

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

  const tabNode = (id: string | undefined) =>
    Array.from(host.current?.querySelectorAll<HTMLElement>('[data-tab-motion-id]') ?? []).find(
      (element) => element.dataset['tabMotionId'] === id,
    )

  const close = (id: string) => {
    if (exits.current.has(id)) return
    const node = tabNode(id)
    // The closing tab turns inert (or leaves at once), which drops focus on
    // its close button to the document body. Hand focus to the tab that is
    // selected afterwards; the panel falls back to its last tab.
    if (node?.contains(document.activeElement)) {
      const remaining = props.tabs.filter((tab) => tab.id !== id && !closing.has(tab.id))
      const next =
        id === props.activeId
          ? remaining.at(-1)
          : remaining.find((tab) => tab.id === props.activeId)
      tabNode(next?.id)?.querySelector<HTMLElement>('[role="tab"]')?.focus()
    }
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
            aria-label={tab.accessibleName ?? tab.title}
            title={tab.tooltip ?? tab.title}
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
            aria-label={`Close ${tab.accessibleName ?? tab.title}`}
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
