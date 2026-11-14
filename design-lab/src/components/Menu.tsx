/**
 * Dropdown menus for the copy of the current app, using the original app's
 * own markup and class names (apps/web/src/ui/Menu.tsx: .menu, .menu__item,
 * .menu__name, .menu__label, .menu__meta, .menu__desc, .menu__rule,
 * .menu__group). Styles: src/styles/menu.css, ported from the app.
 */
import { IconCheck } from '@tabler/icons-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export function Menu(props: {
  label: string
  /** Which way the panel opens from its trigger, as in the app. */
  drop: 'down' | 'up'
  align?: 'start' | 'end'
  triggerClassName: string
  panelClassName?: string
  trigger: (open: boolean) => ReactNode
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)

  // Close on a click outside or Escape, as the app's menus do.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span className="menuanchor" ref={root}>
      <button
        type="button"
        className={`menutrigger ${props.triggerClassName}${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.label}
        onClick={() => setOpen((o) => !o)}
      >
        {props.trigger(open)}
      </button>
      {open && (
        <div
          className={`menu popup menu--${props.drop}${props.align === 'end' ? ' menu--end' : ''}${
            props.panelClassName ? ` ${props.panelClassName}` : ''
          }`}
          role="menu"
          aria-label={props.label}
        >
          {props.children(() => setOpen(false))}
        </div>
      )}
    </span>
  )
}

export function MenuItem(props: {
  onClick: () => void
  checked?: boolean
  title: string
  detail?: string
  icon?: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      className={`menu__item${props.className ? ` ${props.className}` : ''}${props.checked ? ' is-active' : ''}`}
      onClick={props.onClick}
      role={props.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={props.checked}
    >
      <span className="menu__name">
        <span className="menu__label">
          {props.icon}
          <span title={props.title}>{props.title}</span>
        </span>
        {props.checked ? (
          <span className="menu__meta">
            <IconCheck size={13} aria-hidden />
          </span>
        ) : null}
      </span>
      {props.detail ? (
        <span className="menu__desc" title={props.detail}>
          {props.detail}
        </span>
      ) : null}
    </button>
  )
}

export function MenuRule() {
  return <div className="menu__rule" role="separator" />
}
