import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'

type Drop = 'up' | 'down'

type MenuPosition = {
  left: number
  top: number
  drop: Drop
}

const MENU_GAP = 6
const VIEWPORT_GUTTER = 8

/**
 * One dropdown implementation for the whole app, so every menu opens, closes
 * and animates identically. Menus that behave differently from each other are
 * the fastest way to make an app feel assembled rather than designed.
 */
export function Menu(props: {
  trigger: (open: boolean) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  drop?: 'up' | 'down'
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition>()
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!wrap.current?.contains(target) && !panel.current?.contains(target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const triggerBounds = trigger.current?.getBoundingClientRect()
      const menuBounds = panel.current?.getBoundingClientRect()
      if (!triggerBounds || !menuBounds) return

      const preferredDrop = props.drop ?? 'up'
      const spaceAbove = triggerBounds.top - MENU_GAP - VIEWPORT_GUTTER
      const spaceBelow = window.innerHeight - triggerBounds.bottom - MENU_GAP - VIEWPORT_GUTTER
      let drop = preferredDrop

      if (drop === 'down' && menuBounds.height > spaceBelow && spaceAbove > spaceBelow) {
        drop = 'up'
      } else if (drop === 'up' && menuBounds.height > spaceAbove && spaceBelow > spaceAbove) {
        drop = 'down'
      }

      const preferredLeft =
        props.align === 'right' ? triggerBounds.right - menuBounds.width : triggerBounds.left
      const maxLeft = Math.max(
        VIEWPORT_GUTTER,
        window.innerWidth - menuBounds.width - VIEWPORT_GUTTER,
      )
      const left = Math.min(Math.max(preferredLeft, VIEWPORT_GUTTER), maxLeft)

      const preferredTop =
        drop === 'down'
          ? triggerBounds.bottom + MENU_GAP
          : triggerBounds.top - MENU_GAP - menuBounds.height
      const maxTop = Math.max(
        VIEWPORT_GUTTER,
        window.innerHeight - menuBounds.height - VIEWPORT_GUTTER,
      )
      const top = Math.min(Math.max(preferredTop, VIEWPORT_GUTTER), maxTop)
      const next = { left, top, drop }

      setPosition((current) =>
        current?.left === next.left && current.top === next.top && current.drop === next.drop
          ? current
          : next,
      )
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, props.align, props.drop])

  return (
    <div className="menuwrap" ref={wrap}>
      <button
        ref={trigger}
        className="menutrigger"
        onClick={() => {
          setPosition(undefined)
          setOpen((current) => !current)
        }}
        disabled={props.disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        {...(props.label ? { 'aria-label': props.label } : {})}
      >
        {props.trigger(open)}
      </button>

      {open
        ? createPortal(
            <div
              ref={panel}
              className={`menu menu--${position?.drop ?? props.drop ?? 'up'}${position ? ' is-positioned' : ''}`}
              role="menu"
              style={
                position
                  ? { left: position.left, top: position.top }
                  : { left: 0, top: 0, visibility: 'hidden' }
              }
            >
              {props.children(() => setOpen(false))}
            </div>,
            // Scrollable app regions clip positioned descendants, so the panel
            // has to live at the viewport level and follow its trigger.
            document.body,
          )
        : null}
    </div>
  )
}

export function MenuItem(props: {
  onClick: () => void
  active?: boolean
  title: string
  detail?: string | undefined
}) {
  return (
    <button
      className={`menu__item ${props.active ? 'is-active' : ''}`}
      onClick={props.onClick}
      role="menuitem"
    >
      <span className="menu__name">
        {props.title}
        {props.active ? <Check size={13} aria-hidden /> : null}
      </span>
      {props.detail ? <span className="menu__desc">{props.detail}</span> : null}
    </button>
  )
}
