import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { reportStartupMilestone } from '../bridge.js'

type NoticePresenceProps = {
  visible: boolean
  className: string
  role: 'alert' | 'status'
  children: ReactNode
  onDismiss?: () => void
  autoDismissPaused?: boolean
  dismissKey?: unknown
}

type NoticePhase = 'open' | 'closing'

const DOCKED_COMPOSER = '.stage__conversation:not(.is-new-session) > .composer'
/** Clears the Jump to latest pill: 14px above the composer, 34px tall, plus 8px. */
export const NOTICE_COMPOSER_CLEARANCE = 56
const NOTICE_EDGE = 12

/**
 * Toasts are fixed to the window corner, which is where the docked composer
 * keeps Send. While a toast is open it sits above that composer instead,
 * right-aligned with the composer box. The values land on the toast itself,
 * so measuring never restyles the rest of the document.
 */
export function placeNoticeAboveComposer(notice: HTMLElement): void {
  const composer = document.querySelector<HTMLElement>(DOCKED_COMPOSER)
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

function keepNoticeAboveComposer(notice: HTMLElement): () => void {
  const place = () => placeNoticeAboveComposer(notice)
  place()
  const composer = document.querySelector<HTMLElement>(DOCKED_COMPOSER)
  const ResizeObserverConstructor = globalThis.ResizeObserver
  const observer =
    composer && ResizeObserverConstructor ? new ResizeObserverConstructor(place) : undefined
  if (composer) observer?.observe(composer)
  if (composer?.parentElement) observer?.observe(composer.parentElement)
  window.addEventListener('resize', place)
  return () => {
    observer?.disconnect()
    window.removeEventListener('resize', place)
  }
}

export function NoticePresence(props: NoticePresenceProps) {
  const snapshot = useRef({
    className: props.className,
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
  useLayoutEffect(() => {
    const element = root.current
    if (!mounted || !element) return
    return keepNoticeAboveComposer(element)
  }, [mounted])
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
