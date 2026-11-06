import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { reportStartupMilestone } from '../bridge.js'
import type { NoticeTone } from './Notice.js'

type NoticePresenceProps = {
  visible: boolean
  className: string
  /** Colours the notice's icon (styles/notice.css); info when absent. */
  tone?: NoticeTone
  role: 'alert' | 'status'
  children: ReactNode
  onDismiss?: () => void
  autoDismissPaused?: boolean
  dismissKey?: unknown
  /**
   * False for a notice whose own CSS pins it away from the window corner: it
   * never meets a composer, so nothing is measured or watched while it is up.
   */
  followComposer?: boolean
}

type NoticePhase = 'open' | 'closing'

// In a split, the focused pane's composer: the other one is dormant.
const DOCKED_COMPOSER = '.stage__conversation:not(.is-new-session) > .composer:not(.is-dormant)'
/** Clears the Jump to latest pill: 14px above the composer, 34px tall, plus 8px. */
export const NOTICE_COMPOSER_CLEARANCE = 56
const NOTICE_EDGE = 12

// A split whose focused pane holds a new chat (its composer centred in that
// pane) leaves the window corner to the right pane's composer, which stays
// docked there, dormant but visible.
const CORNER_COMPOSER =
  '.split__pane.is-end > .stage__conversation:not(.is-new-session) > .composer'

function dockedComposer(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(DOCKED_COMPOSER) ??
    document.querySelector<HTMLElement>(CORNER_COMPOSER)
  )
}

/**
 * Toasts are fixed to the window corner, which is where the docked composer
 * keeps Send. While a toast is open it sits above that composer instead,
 * right-aligned with the composer box. The values land on the toast itself,
 * so measuring never restyles the rest of the document.
 */
export function placeNoticeAboveComposer(notice: HTMLElement): void {
  placeNoticeAbove(notice, dockedComposer())
}

function placeNoticeAbove(notice: HTMLElement, composer: HTMLElement | null): void {
  const rect = composer?.getBoundingClientRect()
  if (!composer || !rect || rect.height <= 0) {
    notice.style.removeProperty('--notice-bottom')
    notice.style.removeProperty('--notice-right')
    return
  }
  // Layout offsets, not the box's rect: the dock FLIP transforms the box.
  const box = composer.querySelector<HTMLElement>(':scope > .composer__box')
  const right = box ? rect.left + box.offsetLeft + box.offsetWidth : rect.right
  const bottom = window.innerHeight - rect.top + NOTICE_COMPOSER_CLEARANCE
  notice.style.setProperty('--notice-bottom', `${Math.round(bottom)}px`)
  notice.style.setProperty(
    '--notice-right',
    `${Math.max(NOTICE_EDGE, Math.round(window.innerWidth - right))}px`,
  )
}

// Which composer is docked changes only with a class on one of these, or with
// one of them coming or going.
const DOCK_PARTS = '.stage__body, .split, .split__pane, .stage__conversation, .composer'

function isDockPart(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(DOCK_PARTS)
}

/**
 * Streamed text rewrites the transcript many times a second while a notice
 * can be open, so a mutation costs one `matches` per changed node, and only a
 * change to the dock itself measures anything.
 */
function movesDock(record: MutationRecord): boolean {
  if (record.type === 'attributes') return isDockPart(record.target)
  for (const node of record.addedNodes) if (isDockPart(node)) return true
  for (const node of record.removedNodes) if (isDockPart(node)) return true
  return false
}

/**
 * The dock can change under an open notice: a notice that opened over a new
 * chat stays up while a chat opens, a split opens beside it, focus moves to
 * the other pane, or the stage comes back from another view. The notice
 * follows whichever composer is docked now.
 */
function keepNoticeAboveComposer(notice: HTMLElement): () => void {
  let composer: HTMLElement | null = null
  const ResizeObserverConstructor = globalThis.ResizeObserver
  const MutationObserverConstructor = globalThis.MutationObserver
  const follow = () => {
    const next = dockedComposer()
    if (next !== composer) {
      composer = next
      resize?.disconnect()
      if (composer) resize?.observe(composer)
      if (composer?.parentElement) resize?.observe(composer.parentElement)
    }
    placeNoticeAbove(notice, composer)
  }
  const resize = ResizeObserverConstructor ? new ResizeObserverConstructor(follow) : undefined
  const dock = MutationObserverConstructor
    ? new MutationObserverConstructor((records) => {
        if (records.some(movesDock)) follow()
      })
    : undefined
  follow()
  dock?.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  })
  window.addEventListener('resize', follow)
  return () => {
    dock?.disconnect()
    resize?.disconnect()
    window.removeEventListener('resize', follow)
  }
}

export function NoticePresence(props: NoticePresenceProps) {
  const snapshot = useRef({
    className: props.className,
    tone: props.tone ?? 'info',
    role: props.role,
    children: props.children,
  })
  const root = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(props.visible)
  const [phase, setPhase] = useState<NoticePhase>('open')
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const onDismiss = useRef(props.onDismiss)
  useLayoutEffect(() => {
    onDismiss.current = props.onDismiss
  })
  useLayoutEffect(() => {
    if (!mounted) return
    reportStartupMilestone('notice-open')
    return () => reportStartupMilestone('notice-closed')
  }, [mounted])
  const followComposer = props.followComposer ?? true
  useLayoutEffect(() => {
    const element = root.current
    if (!mounted || !element || !followComposer) return
    return keepNoticeAboveComposer(element)
  }, [mounted, followComposer])
  const canDismiss = Boolean(props.onDismiss)
  useEffect(() => {
    if (!props.visible || !canDismiss || props.autoDismissPaused || hovered) return
    // Removing the focused control (an action that hides itself once pressed)
    // fires no blur, so the focus flag alone would hold the notice forever.
    if (focused && root.current?.contains(document.activeElement)) return
    const timeout = globalThis.setTimeout(() => onDismiss.current?.(), 5_000)
    return () => globalThis.clearTimeout(timeout)
  }, [props.visible, canDismiss, props.autoDismissPaused, props.dismissKey, hovered, focused])

  if (props.visible) {
    snapshot.current = {
      className: props.className,
      tone: props.tone ?? 'info',
      role: props.role,
      children: props.children,
    }
  }

  useEffect(() => {
    if (props.visible) {
      setMounted(true)
      setPhase('open')
      return
    }

    setHovered(false)
    setFocused(false)
    setPhase((current) => (mounted ? 'closing' : current))
  }, [mounted, props.visible])

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return

    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== element || event.propertyName !== 'opacity') return
      if (props.visible || phase !== 'closing') return
      setMounted(false)
    }

    const finishHiddenExit = () => {
      if (!props.visible && phase === 'closing' && document.visibilityState === 'hidden') {
        setMounted(false)
      }
    }
    document.addEventListener('visibilitychange', finishHiddenExit)
    finishHiddenExit()
    element.addEventListener('transitionend', handleTransitionEnd)
    let disposed = false
    if (!props.visible && phase === 'closing' && typeof element.getAnimations === 'function') {
      // An occluded window can finish/cancel its transition without delivering
      // transitionend. Do not retain the invisible notice in that case.
      const transitions = element.getAnimations()
      void Promise.allSettled(transitions.map((animation) => animation.finished)).then(() => {
        if (!disposed) setMounted(false)
      })
    }
    return () => {
      disposed = true
      element.removeEventListener('transitionend', handleTransitionEnd)
      document.removeEventListener('visibilitychange', finishHiddenExit)
    }
  }, [mounted, phase, props.visible])

  if (!mounted) return null

  return (
    <div
      ref={root}
      className={snapshot.current.className}
      data-notice-tone={snapshot.current.tone}
      role={snapshot.current.role}
      data-state={phase}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      {snapshot.current.children}
    </div>
  )
}
