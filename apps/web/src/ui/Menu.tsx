import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, type LucideIcon } from 'lucide-react'
import { ShortcutHint } from './ShortcutHint.js'

type Drop = 'up' | 'down'

type MenuPosition = {
  left: number
  top?: number
  bottom?: number
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
  centerOnSmallScreens?: boolean
  wrapperClassName?: string
  triggerClassName?: string
  panelRole?: 'menu' | 'dialog'
  panelLabel?: string
  panelClassName?: string
  shortcutAria?: string
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
      const menuElement = panel.current
      const menuBounds = menuElement?.getBoundingClientRect()
      if (!triggerBounds || !menuElement || !menuBounds) return

      // The opening animation transforms the visual bounds. Layout dimensions
      // stay stable, so they keep centered menus from drifting mid-animation.
      const menuWidth = menuElement.offsetWidth || menuBounds.width
      const menuHeight = menuElement.offsetHeight || menuBounds.height

      const preferredDrop = props.drop ?? 'up'
      const spaceAbove = triggerBounds.top - MENU_GAP - VIEWPORT_GUTTER
      const spaceBelow = window.innerHeight - triggerBounds.bottom - MENU_GAP - VIEWPORT_GUTTER
      let drop = preferredDrop

      if (drop === 'down' && menuHeight > spaceBelow && spaceAbove > spaceBelow) {
        drop = 'up'
      } else if (drop === 'up' && menuHeight > spaceAbove && spaceBelow > spaceAbove) {
        drop = 'down'
      }

      const centered = props.centerOnSmallScreens && window.innerWidth <= 700
      const preferredLeft = centered
        ? (window.innerWidth - menuWidth) / 2
        : props.align === 'right'
          ? triggerBounds.right - menuWidth
          : triggerBounds.left
      const horizontalGutter = centered ? 0 : VIEWPORT_GUTTER
      const maxLeft = Math.max(horizontalGutter, window.innerWidth - menuWidth - horizontalGutter)
      const left =
        !centered && props.align === 'right' && preferredLeft < VIEWPORT_GUTTER
          ? maxLeft
          : Math.min(Math.max(preferredLeft, horizontalGutter), maxLeft)

      const preferredTop =
        drop === 'down'
          ? triggerBounds.bottom + MENU_GAP
          : triggerBounds.top - MENU_GAP - menuHeight
      const maxTop = Math.max(VIEWPORT_GUTTER, window.innerHeight - menuHeight - VIEWPORT_GUTTER)
      const top = Math.min(Math.max(preferredTop, VIEWPORT_GUTTER), maxTop)
      const next =
        drop === 'up'
          ? { left, bottom: window.innerHeight - top - menuHeight, drop }
          : { left, top, drop }

      setPosition((current) =>
        current?.left === next.left &&
        current.top === next.top &&
        current.bottom === next.bottom &&
        current.drop === next.drop
          ? current
          : next,
      )
    }

    updatePosition()
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updatePosition)
    if (panel.current) resizeObserver?.observe(panel.current)
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
      resizeObserver?.disconnect()
    }
  }, [open, props.align, props.centerOnSmallScreens, props.drop])

  return (
    <div
      className={`menuwrap${props.wrapperClassName ? ` ${props.wrapperClassName}` : ''}`}
      ref={wrap}
    >
      <button
        ref={trigger}
        className={`menutrigger${props.triggerClassName ? ` ${props.triggerClassName}` : ''}`}
        onClick={() => {
          setPosition(undefined)
          setOpen((current) => !current)
        }}
        disabled={props.disabled}
        aria-expanded={open}
        aria-haspopup={props.panelRole ?? 'menu'}
        aria-keyshortcuts={props.shortcutAria}
        {...(props.label ? { 'aria-label': props.label } : {})}
      >
        {props.trigger(open)}
      </button>

      {open
        ? createPortal(
            <div
              ref={panel}
              className={`menu menu--${position?.drop ?? props.drop ?? 'up'}${position ? ' is-positioned' : ''}${props.panelClassName ? ` ${props.panelClassName}` : ''}`}
              role={props.panelRole ?? 'menu'}
              {...(props.panelLabel ? { 'aria-label': props.panelLabel } : {})}
              style={
                position
                  ? {
                      left: position.left,
                      ...(position.drop === 'up'
                        ? { bottom: position.bottom }
                        : { top: position.top }),
                    }
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
  icon: LucideIcon
  active?: boolean
  title: string
  detail?: string | undefined
  shortcut?: string
  shortcutAria?: string
}) {
  const Icon = props.icon

  return (
    <button
      className={`menu__item ${props.active ? 'is-active' : ''}`}
      onClick={props.onClick}
      role="menuitem"
      aria-keyshortcuts={props.shortcutAria}
    >
      <Icon className="menu__icon" size={12} aria-hidden />
      <span className="menu__copy">
        <span className="menu__name">
          <span>{props.title}</span>
          <span className="menu__meta">
            {props.active ? <Check size={13} aria-hidden /> : null}
            {props.shortcut ? <ShortcutHint>{props.shortcut}</ShortcutHint> : null}
          </span>
        </span>
        {props.detail ? <span className="menu__desc">{props.detail}</span> : null}
      </span>
    </button>
  )
}
