import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { IconAlertCircle } from '@tabler/icons-react'

/** A row keeps its compact size while its error can escape the containing card. */
export function RowIssue(props: {
  message: string
  tip?: string | undefined
  announce?: boolean | undefined
  label?: string
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hovered = useRef(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  const cancelClose = useCallback(() => {
    clearTimeout(closeTimer.current)
    closeTimer.current = undefined
  }, [])
  const enter = (event: PointerEvent) => {
    if (
      event.pointerType === 'touch' ||
      !window.matchMedia('(hover: hover) and (pointer: fine)').matches
    )
      return
    hovered.current = true
    cancelClose()
    setOpen(true)
  }
  const leave = () => {
    hovered.current = false
    cancelClose()
    closeTimer.current = setTimeout(() => {
      if (!hovered.current && document.activeElement !== trigger.current) setOpen(false)
    }, 100)
  }
  useEffect(() => cancelClose, [cancelClose])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const tooltip = bubble.current?.getBoundingClientRect()
      if (!anchor || !tooltip) return
      const gap = 8
      const left = Math.max(
        gap,
        Math.min(anchor.right - tooltip.width, window.innerWidth - tooltip.width - gap),
      )
      const above = anchor.top - tooltip.height - gap
      const below = anchor.bottom + gap
      const top = Math.max(
        gap,
        Math.min(above >= gap ? above : below, window.innerHeight - tooltip.height - gap),
      )
      setPosition((previous) =>
        previous.left === left && previous.top === top ? previous : { left, top },
      )
    }
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        cancelClose()
        setOpen(false)
      }
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('keydown', dismiss, true)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (trigger.current) observer?.observe(trigger.current)
    if (bubble.current) observer?.observe(bubble.current)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('keydown', dismiss, true)
    }
  }, [open, props.message, props.tip, cancelClose])

  return (
    <span className="row-issue" onPointerEnter={enter} onPointerLeave={leave}>
      {props.announce ? (
        <span className="visually-hidden" role="alert">
          {props.message}
        </span>
      ) : null}
      <button
        ref={trigger}
        type="button"
        className="row-issue__dot"
        aria-label={props.label ?? `Problem: ${props.message}`}
        aria-describedby={open ? id : undefined}
        onFocus={() => {
          cancelClose()
          setOpen(true)
        }}
        onBlur={() => {
          if (!hovered.current) setOpen(false)
        }}
      >
        <IconAlertCircle size={14} aria-hidden />
      </button>
      {open
        ? createPortal(
            <span
              ref={bubble}
              id={id}
              role="tooltip"
              className="row-issue__bubble row-issue__bubble--fixed"
              style={position}
              onPointerEnter={enter}
              onPointerLeave={leave}
            >
              {props.message}
              {props.tip ? <span className="row-issue__tip">{props.tip}</span> : null}
            </span>,
            document.body,
          )
        : null}
    </span>
  )
}
