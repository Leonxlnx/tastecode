import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

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
  const canDismiss = Boolean(props.onDismiss)
  useEffect(() => {
    if (!props.visible || !canDismiss || props.autoDismissPaused || hovered || focused) return
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

    element.addEventListener('transitionend', handleTransitionEnd)
    return () => element.removeEventListener('transitionend', handleTransitionEnd)
  }, [phase, props.visible])

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
