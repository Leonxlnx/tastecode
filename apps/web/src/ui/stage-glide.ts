import { useLayoutEffect, useRef, type RefObject } from 'react'

import '../styles/stage-glide.css'

/** --dur-slow and --ease-rail: the clock the rail and the side panel move on. */
export const STAGE_GLIDE_MS = 260
export const STAGE_GLIDE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
export const STAGE_GLIDE_ANIMATION_ID = 'harness-stage-glide'

/** Below this width the chat pane is hidden behind an expanded or narrow-layout
 *  panel, so there is nothing to carry across. */
const MIN_PANE_WIDTH = 240

type PaneBox = { left: number; center: number; width: number }

function paneBox(stage: HTMLElement): PaneBox {
  const rect = stage.getBoundingClientRect()
  // getBoundingClientRect includes a running glide; remember the laid-out box.
  const left = rect.left - liveOffset(stage)
  return { left, center: left + rect.width / 2, width: rect.width }
}

/** How far a running glide has moved an element from its laid-out place. */
function liveOffset(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform
  if (!transform || transform === 'none') return 0
  try {
    return new DOMMatrixReadOnly(transform).m41
  } catch {
    return 0
  }
}

function slide(element: HTMLElement, from: number): Animation | null {
  if (Math.abs(from) < 1) return null
  const animation = element.animate(
    [{ transform: `translate3d(${from}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
    { duration: STAGE_GLIDE_MS, easing: STAGE_GLIDE_EASING },
  )
  animation.id = STAGE_GLIDE_ANIMATION_ID
  return animation
}

/**
 * Folding the sidebar and opening or hiding the side panel change the chat
 * pane's box in one layout step; the grid tracks deliberately do not animate.
 * Before this, everything in the pane jumped on the first frame while the rail
 * or panel beside it was still sliding: the pane's edge and its header by the
 * rail's width, the centred chat column by half of it.
 *
 * This starts both where they were and slides them to their new places on the
 * rail's own clock, by transform only, so nothing relays out per frame: the
 * pane rides the rail's edge (its left edge moves), and the conversation inside
 * it covers the rest of the way to its new centre. A side panel moves only the
 * pane's right edge, so there only the conversation travels.
 *
 * `layout` changes exactly when one of those toggles commits. Window resizes
 * and edge drags only refresh the remembered box: they track the pointer and
 * must not glide.
 */
export function useStageGlide(stage: RefObject<HTMLElement | null>, layout: string): void {
  const box = useRef<PaneBox | undefined>(undefined)
  const glides = useRef<Animation[]>([])

  useLayoutEffect(() => {
    const element = stage.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      box.current = paneBox(element)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      settle(glides.current, element)
      glides.current = []
    }
  }, [stage])

  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const previous = box.current
    // React commits this before the browser renders the change and before the
    // ResizeObserver above reports it, so `previous` is still the old layout.
    // Without a split, the split view's pane wrappers take no box, so the one
    // conversation is laid out as the body's own column. In a split each pane
    // centres its own column and only the pane's edge glides.
    const conversation = element.querySelector<HTMLElement>(
      ':scope > .stage__body > .stage__conversation, :scope > .stage__body:not(.is-split) > .split > .split__pane > .stage__conversation',
    )
    // A second toggle mid-glide continues from where things are on screen.
    const paneShift = liveOffset(element)
    const columnShift = conversation ? liveOffset(conversation) : 0
    settle(glides.current, element)
    glides.current = []
    const next = paneBox(element)
    box.current = next

    if (!previous || typeof element.animate !== 'function') return
    if (previous.width < MIN_PANE_WIDTH || next.width < MIN_PANE_WIDTH) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    const edge = previous.left + paneShift - next.left
    const centre = previous.center + paneShift + columnShift - next.center
    const started = [slide(element, edge), conversation ? slide(conversation, centre - edge) : null]
    const running = started.filter((animation): animation is Animation => animation !== null)
    if (running.length === 0) return
    glides.current = running
    const body = element.closest('.shell__body')
    body?.setAttribute('data-stage-gliding', '')
    void Promise.all(running.map((animation) => animation.finished))
      .catch(() => undefined)
      .then(() => {
        // A newer toggle owns the clip once it has replaced these glides.
        if (glides.current !== running) return
        glides.current = []
        body?.removeAttribute('data-stage-gliding')
      })
  }, [stage, layout])
}

/** Ends running glides and the clip that exists only while they run. */
function settle(running: readonly Animation[], stage: HTMLElement): void {
  for (const animation of running) animation.cancel()
  stage.closest('.shell__body')?.removeAttribute('data-stage-gliding')
}
