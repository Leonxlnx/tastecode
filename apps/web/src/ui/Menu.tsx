import { useEffect, useRef, useState, type ReactNode } from 'react'

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
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
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

  return (
    <div className="menuwrap" ref={wrap}>
      <button
        className="menutrigger"
        onClick={() => setOpen(!open)}
        disabled={props.disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        {...(props.label ? { 'aria-label': props.label } : {})}
      >
        {props.trigger(open)}
      </button>

      {open ? (
        <div
          className={`menu menu--${props.drop ?? 'up'} menu--${props.align ?? 'left'}`}
          role="menu"
        >
          {props.children(() => setOpen(false))}
        </div>
      ) : null}
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
      <span className="menu__name">{props.title}</span>
      {props.detail ? <span className="menu__desc">{props.detail}</span> : null}
    </button>
  )
}
