import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'

type Drop = 'up' | 'down'

type MenuPosition = {
  left: number
  top?: number
  bottom?: number
  drop: Drop
  originX: 'left' | 'right'
  originY: 'top' | 'bottom'
}

const MENU_GAP = 6
const VIEWPORT_GUTTER = 8
const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]'
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function menuItems(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (item) => !item.matches(':disabled, [aria-disabled="true"]'),
  )
}

function focusMenuItem(panel: HTMLElement, index: number) {
  const items = menuItems(panel)
  if (items.length === 0) {
    panel.focus()
    return
  }
  const nextIndex = (index + items.length) % items.length
  items.forEach((item, itemIndex) => {
    item.tabIndex = itemIndex === nextIndex ? 0 : -1
  })
  items[nextIndex]?.focus()
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (item) => !item.closest('[hidden], [inert], [aria-hidden="true"]'),
  )
}

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
  gap?: number
  disabled?: boolean
  label?: string
  triggerClassName?: string
  panelRole?: 'menu' | 'dialog'
  panelLabel?: string
  panelClassName?: string
  shortcutAria?: string
  contextMenuTargetRef?: RefObject<HTMLElement | null>
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition>()
  const [contextPoint, setContextPoint] = useState<{ x: number; y: number }>()
  const [inputModality, setInputModality] = useState<'keyboard' | 'pointer'>('keyboard')
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const initialFocus = useRef<'first' | 'last'>('first')
  const restoreTarget = useRef<HTMLElement | undefined>(undefined)
  const typeahead = useRef('')
  const typeaheadTimer = useRef<number | undefined>(undefined)
  const triggerId = useId()
  const panelId = useId()
  const panelRole = props.panelRole ?? 'menu'

  const showMenu = useCallback(
    (
      modality: 'keyboard' | 'pointer',
      focus: 'first' | 'last',
      returnFocus: HTMLElement | null,
    ) => {
      setPosition(undefined)
      setInputModality(modality)
      initialFocus.current = focus
      restoreTarget.current = returnFocus ?? undefined
      setOpen(true)
    },
    [],
  )

  const closeMenu = useCallback(() => {
    if (typeaheadTimer.current !== undefined) window.clearTimeout(typeaheadTimer.current)
    typeahead.current = ''
    setOpen(false)
  }, [])

  useEffect(() => {
    const target = props.contextMenuTargetRef?.current
    if (!target) return
    let contextModality: 'keyboard' | 'pointer' = 'pointer'
    const contextEvents = new AbortController()

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      const bounds = target.getBoundingClientRect()
      setContextPoint(
        contextModality === 'keyboard'
          ? { x: bounds.left, y: bounds.bottom }
          : { x: event.clientX, y: event.clientY },
      )
      showMenu(contextModality, 'first', target)
      contextModality = 'pointer'
    }
    const onPointerDown = () => (contextModality = 'pointer')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        contextModality = 'keyboard'
      }
    }
    target.addEventListener('contextmenu', onContextMenu, { signal: contextEvents.signal })
    target.addEventListener('pointerdown', onPointerDown, { signal: contextEvents.signal })
    target.addEventListener('keydown', onKeyDown, { signal: contextEvents.signal })
    return () => contextEvents.abort()
  }, [props.contextMenuTargetRef, showMenu])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!wrap.current?.contains(target) && !panel.current?.contains(target)) closeMenu()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
      }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [closeMenu, open])

  useLayoutEffect(() => {
    if (!open) {
      const target = restoreTarget.current
      if (!target) return
      const active = document.activeElement
      if (!active || active === document.body || !document.contains(active)) target.focus()
      restoreTarget.current = undefined
      return
    }

    const currentPanel = panel.current
    if (!currentPanel || !position || currentPanel.contains(document.activeElement)) return
    if (panelRole === 'menu') {
      focusMenuItem(currentPanel, initialFocus.current === 'last' ? -1 : 0)
    } else {
      ;(focusableElements(currentPanel)[0] ?? currentPanel).focus()
    }
  }, [open, panelRole, position])

  useLayoutEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const triggerBounds = trigger.current?.getBoundingClientRect()
      const menuBounds = panel.current?.getBoundingClientRect()
      if ((!triggerBounds && !contextPoint) || !menuBounds) return

      // Panels that want to sit flush with their trigger (the account popup)
      // read this; everyone else keeps their intrinsic width.
      if (triggerBounds && panel.current) {
        panel.current.style.setProperty('--menu-trigger-w', `${triggerBounds.width}px`)
      }

      const preferredDrop = props.drop ?? 'up'
      const gap = contextPoint ? 0 : (props.gap ?? MENU_GAP)
      const anchorTop = contextPoint?.y ?? triggerBounds?.top ?? 0
      const anchorBottom = contextPoint?.y ?? triggerBounds?.bottom ?? 0
      const spaceAbove = anchorTop - gap - VIEWPORT_GUTTER
      const spaceBelow = window.innerHeight - anchorBottom - gap - VIEWPORT_GUTTER
      let drop = preferredDrop

      if (drop === 'down' && menuBounds.height > spaceBelow && spaceAbove > spaceBelow) {
        drop = 'up'
      } else if (drop === 'up' && menuBounds.height > spaceAbove && spaceBelow > spaceAbove) {
        drop = 'down'
      }

      const preferredLeft = contextPoint
        ? contextPoint.x
        : props.align === 'right'
          ? (triggerBounds?.right ?? 0) - menuBounds.width
          : (triggerBounds?.left ?? 0)
      const maxLeft = Math.max(
        VIEWPORT_GUTTER,
        window.innerWidth - menuBounds.width - VIEWPORT_GUTTER,
      )
      const left = Math.min(Math.max(preferredLeft, VIEWPORT_GUTTER), maxLeft)
      const anchorX = contextPoint
        ? contextPoint.x
        : props.align === 'right'
          ? (triggerBounds?.right ?? 0)
          : (triggerBounds?.left ?? 0)

      const preferredTop =
        drop === 'down' ? anchorBottom + gap : anchorTop - gap - menuBounds.height
      const maxTop = Math.max(
        VIEWPORT_GUTTER,
        window.innerHeight - menuBounds.height - VIEWPORT_GUTTER,
      )
      const top = Math.min(Math.max(preferredTop, VIEWPORT_GUTTER), maxTop)
      const next: MenuPosition = {
        left,
        drop,
        originX: anchorX <= left + menuBounds.width / 2 ? 'left' : 'right',
        originY: drop === 'up' ? 'bottom' : 'top',
        ...(drop === 'up' ? { bottom: window.innerHeight - top - menuBounds.height } : { top }),
      }

      setPosition((current) =>
        current?.left === next.left &&
        current.top === next.top &&
        current.bottom === next.bottom &&
        current.drop === next.drop &&
        current.originX === next.originX &&
        current.originY === next.originY
          ? current
          : next,
      )
    }

    updatePosition()
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return
      updatePosition()
    }
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updatePosition)
    if (panel.current) resizeObserver?.observe(panel.current)
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', onScroll, true)
      resizeObserver?.disconnect()
    }
  }, [contextPoint, open, props.align, props.drop, props.gap])

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }

    const currentPanel = event.currentTarget
    if (panelRole === 'dialog') {
      if (event.key !== 'Tab') return
      const focusable = focusableElements(currentPanel)
      const currentIndex = focusable.findIndex((item) => item === document.activeElement)
      const atBoundary =
        currentIndex < 0 ||
        (event.shiftKey ? currentIndex === 0 : currentIndex === focusable.length - 1)
      if (atBoundary) {
        event.preventDefault()
        ;(focusable[event.shiftKey ? focusable.length - 1 : 0] ?? currentPanel).focus()
      }
      return
    }

    if (event.key === 'Tab') {
      const tabbable = focusableElements(document.body).filter(
        (item) => !currentPanel.contains(item),
      )
      const anchor = restoreTarget.current
      const anchorIndex = anchor ? tabbable.indexOf(anchor) : -1
      const next = anchorIndex < 0 ? undefined : tabbable[anchorIndex + (event.shiftKey ? -1 : 1)]
      restoreTarget.current = undefined
      if (!next) anchor?.focus()
      closeMenu()
      if (next) {
        event.preventDefault()
        next.focus()
      }
      return
    }
    const items = menuItems(currentPanel)
    if (items.length === 0) return
    const currentIndex = items.findIndex((item) => item === document.activeElement)
    let nextIndex: number | undefined
    if (event.key === 'ArrowDown') nextIndex = currentIndex + 1
    else if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? -1 : currentIndex - 1
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = -1
    else if (event.key === 'Enter' && currentIndex >= 0) {
      event.preventDefault()
      items[currentIndex]?.click()
      return
    }

    if (nextIndex !== undefined) {
      event.preventDefault()
      focusMenuItem(currentPanel, nextIndex)
      return
    }

    const modified = event.ctrlKey || event.metaKey || event.altKey
    if (event.key.length !== 1 || event.key.trim() === '' || modified) {
      return
    }
    event.preventDefault()
    const key = event.key.toLocaleLowerCase()
    typeahead.current += key
    if (typeaheadTimer.current !== undefined) window.clearTimeout(typeaheadTimer.current)
    typeaheadTimer.current = window.setTimeout(() => (typeahead.current = ''), 500)
    const ordered = [...items.slice(currentIndex + 1), ...items.slice(0, currentIndex + 1)]
    const match = ordered.find((item) =>
      (item.getAttribute('aria-label') ?? item.textContent ?? '')
        .trim()
        .toLocaleLowerCase()
        .startsWith(typeahead.current),
    )
    if (match) focusMenuItem(currentPanel, items.indexOf(match))
  }

  return (
    <div className="menuwrap" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        id={triggerId}
        className={`menutrigger${props.triggerClassName ? ` ${props.triggerClassName}` : ''}`}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            setContextPoint(undefined)
            showMenu('keyboard', event.key === 'ArrowUp' ? 'last' : 'first', trigger.current)
          }
        }}
        onClick={(event) => {
          setContextPoint(undefined)
          if (open) closeMenu()
          else {
            showMenu(event.detail > 0 ? 'pointer' : 'keyboard', 'first', trigger.current)
          }
        }}
        disabled={props.disabled}
        aria-expanded={open}
        aria-haspopup={panelRole}
        aria-controls={open ? panelId : undefined}
        aria-keyshortcuts={props.shortcutAria}
        {...(props.label ? { 'aria-label': props.label } : {})}
      >
        {props.trigger(open)}
      </button>

      {open
        ? createPortal(
            <div
              ref={panel}
              id={panelId}
              className={`menu menu--${position?.drop ?? props.drop ?? 'up'}${position ? ' is-positioned' : ''}${props.panelClassName ? ` ${props.panelClassName}` : ''}`}
              role={panelRole}
              {...(props.panelLabel ? { 'aria-label': props.panelLabel } : {})}
              {...(!props.panelLabel ? { 'aria-labelledby': triggerId } : {})}
              aria-modal={panelRole === 'dialog' ? true : undefined}
              data-input-modality={inputModality}
              tabIndex={-1}
              onKeyDown={onPanelKeyDown}
              onFocus={(event) => {
                if (panelRole !== 'menu') return
                const item = (event.target as HTMLElement).closest<HTMLElement>(MENU_ITEM_SELECTOR)
                if (!item || !event.currentTarget.contains(item)) return
                menuItems(event.currentTarget).forEach((candidate) => {
                  candidate.tabIndex = candidate === item ? 0 : -1
                })
              }}
              style={
                position
                  ? {
                      left: position.left,
                      transformOrigin: `${position.originX} ${position.originY}`,
                      ...(position.drop === 'up'
                        ? { bottom: position.bottom }
                        : { top: position.top }),
                    }
                  : panelRole === 'dialog'
                    ? { left: 0, top: 0, opacity: 0, pointerEvents: 'none' }
                    : { left: 0, top: 0, visibility: 'hidden' }
              }
            >
              {props.children(closeMenu)}
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
  checked?: boolean
  disabled?: boolean
  title: string
  detail?: string | undefined
  icon?: ReactNode
  className?: string
  shortcutAria?: string
}) {
  return (
    <button
      type="button"
      className={`menu__item${props.className ? ` ${props.className}` : ''}${props.active ? ' is-active' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      role={props.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={props.checked}
      tabIndex={-1}
      aria-keyshortcuts={props.shortcutAria}
    >
      <span className="menu__name">
        <span className="menu__label">
          {props.icon}
          <span>{props.title}</span>
        </span>
        {props.active ? (
          <span className="menu__meta">
            <Check size={13} aria-hidden />
          </span>
        ) : null}
      </span>
      {props.detail ? <span className="menu__desc">{props.detail}</span> : null}
    </button>
  )
}
