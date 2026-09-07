import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

type NoticePresenceProps = {
  visible: boolean
  className: string
  role: 'alert' | 'status'
  children: ReactNode
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
    >
      {snapshot.current.children}
    </div>
  )
}
