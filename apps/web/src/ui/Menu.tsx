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
import { IconCheck as Check } from '@tabler/icons-react'

type Drop = 'up' | 'down'

type MenuPosition = {
  left: number
  top?: number
  bottom?: number
  drop: Drop
  originX: 'left' | 'right'
  originY: 'top' | 'bottom'
}

type MenuOpenRequest = {
  modality: 'keyboard' | 'pointer'
  focus: 'first' | 'last'
  returnFocus: HTMLElement | null
  contextPoint?: { x: number; y: number } | undefined
}

type MenuBaseProps = {
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
  onOpen?: (() => void) | undefined
  onTriggerIntent?: (() => void) | undefined
  shortcutAria?: string | undefined
  contextMenuTargetRef?: RefObject<HTMLElement | null>
}

type MenuProps = MenuBaseProps &
  (
    | {
        trigger: (open: boolean) => ReactNode
        contextMenuOnly?: false | undefined
      }
    | {
        /** Register only the delegated context-menu target. No dormant trigger DOM is mounted. */
        contextMenuOnly: true
        contextMenuTargetRef: RefObject<HTMLElement | null>
        trigger?: never
      }
  )

type ContextMenuRegistration = {
  modality: 'keyboard' | 'pointer'
  show: (request: MenuOpenRequest) => void
}

const contextMenuRegistrations = new Map<HTMLElement, ContextMenuRegistration>()
let contextMenuEvents: AbortController | undefined

function registeredContextMenuTarget(
  event: Event,
): { target: HTMLElement; registration: ContextMenuRegistration } | undefined {
  let element =
    event.target instanceof Element
      ? event.target
      : event.target instanceof Node
        ? event.target.parentElement
        : null
  while (element) {
    if (element instanceof HTMLElement) {
      const registration = contextMenuRegistrations.get(element)
      if (registration) return { target: element, registration }
    }
    element = element.parentElement
  }
  return undefined
}

function ensureContextMenuEvents(): void {
  if (contextMenuEvents) return
  contextMenuEvents = new AbortController()
  const signal = contextMenuEvents.signal
  document.addEventListener(
    'contextmenu',
    (event) => {
      const match = registeredContextMenuTarget(event)
      if (!match) return
      event.preventDefault()
      const bounds = match.target.getBoundingClientRect()
      match.registration.show({
        modality: match.registration.modality,
        focus: 'first',
        returnFocus: match.target,
        contextPoint:
          match.registration.modality === 'keyboard'
            ? { x: bounds.left, y: bounds.bottom }
            : { x: event.clientX, y: event.clientY },
      })
      match.registration.modality = 'pointer'
    },
    { signal },
  )
  document.addEventListener(
    'pointerdown',
    (event) => {
      const match = registeredContextMenuTarget(event)
      if (match) match.registration.modality = 'pointer'
    },
    { signal },
  )
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'ContextMenu' && (event.key !== 'F10' || !event.shiftKey)) return
      const match = registeredContextMenuTarget(event)
      if (match) match.registration.modality = 'keyboard'
    },
    { signal },
  )
}

function registerContextMenuTarget(
  target: HTMLElement,
  show: ContextMenuRegistration['show'],
): () => void {
  const registration: ContextMenuRegistration = { modality: 'pointer', show }
  contextMenuRegistrations.set(target, registration)
  ensureContextMenuEvents()
  return () => {
    if (contextMenuRegistrations.get(target) === registration) {
      contextMenuRegistrations.delete(target)
    }
    if (contextMenuRegistrations.size !== 0) return
    contextMenuEvents?.abort()
    contextMenuEvents = undefined
  }
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
export function Menu(props: MenuProps) {
  const [runtime, setRuntime] = useState<{
    open: boolean
    request?: MenuOpenRequest | undefined
  }>({ open: false })
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const triggerId = `${id}-trigger`
  const panelId = `${id}-panel`

  const showMenu = useCallback(
    (request: MenuOpenRequest) => {
      props.onOpen?.()
      setRuntime({ open: true, request })
    },
    [props.onOpen],
  )

  const closeMenu = useCallback(() => {
    setRuntime((current) => (current.open ? { ...current, open: false } : current))
  }, [])

  useLayoutEffect(() => {
    const target = props.contextMenuTargetRef?.current
    if (!target) return
    return registerContextMenuTarget(target, showMenu)
  }, [props.contextMenuTargetRef, showMenu])

  const controller = runtime.request ? (
    <MenuController
      {...props}
      open={runtime.open}
      request={runtime.request}
      wrap={wrap}
      triggerRef={trigger}
      triggerId={triggerId}
      panelId={panelId}
      closeMenu={closeMenu}
    />
  ) : null

  if (props.contextMenuOnly) return controller

  return (
    <div className="menuwrap" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        id={triggerId}
        className={`menutrigger${props.triggerClassName ? ` ${props.triggerClassName}` : ''}`}
        onPointerEnter={() => {
          if (!props.disabled) props.onTriggerIntent?.()
        }}
        onFocus={() => {
          if (!props.disabled) props.onTriggerIntent?.()
        }}
        onKeyDown={(event) => {
          if (!runtime.open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            showMenu({
              modality: 'keyboard',
              focus: event.key === 'ArrowUp' ? 'last' : 'first',
              returnFocus: trigger.current,
            })
          }
        }}
        onClick={(event) => {
          if (runtime.open) closeMenu()
          else {
            showMenu({
              modality: event.detail > 0 ? 'pointer' : 'keyboard',
              focus: 'first',
              returnFocus: trigger.current,
            })
          }
        }}
        disabled={props.disabled}
        aria-expanded={runtime.open}
        aria-haspopup={props.panelRole ?? 'menu'}
        aria-controls={runtime.open ? panelId : undefined}
        aria-keyshortcuts={props.shortcutAria}
        {...(props.label ? { 'aria-label': props.label } : {})}
      >
        {props.trigger(runtime.open)}
      </button>

      {controller}
    </div>
  )
}

/** Closed menus only mount the trigger above. The controller is paid for once,
 * on first use, then stays warm so later opens keep the same instant path. */
function MenuController(
  props: MenuProps & {
    open: boolean
    request: MenuOpenRequest
    wrap: RefObject<HTMLDivElement | null>
    triggerRef: RefObject<HTMLButtonElement | null>
    triggerId: string
    panelId: string
    closeMenu: () => void
  },
) {
  const [position, setPosition] = useState<MenuPosition>()
  const panel = useRef<HTMLDivElement>(null)
  const initialFocus = useRef<'first' | 'last'>(props.request.focus)
  const restoreTarget = useRef<HTMLElement | undefined>(props.request.returnFocus ?? undefined)
  const typeahead = useRef('')
  const typeaheadTimer = useRef<number | undefined>(undefined)
  const panelRole = props.panelRole ?? 'menu'
  const panelLabel = props.panelLabel ?? (props.contextMenuOnly ? props.label : undefined)

  const closeMenu = useCallback(() => {
    if (typeaheadTimer.current !== undefined) window.clearTimeout(typeaheadTimer.current)
    typeahead.current = ''
    props.closeMenu()
  }, [props.closeMenu])

  useLayoutEffect(() => {
    setPosition(undefined)
    initialFocus.current = props.request.focus
    restoreTarget.current = props.request.returnFocus ?? undefined
  }, [props.request])

  useEffect(() => {
    if (!props.open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!props.wrap.current?.contains(target) && !panel.current?.contains(target)) closeMenu()
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
  }, [closeMenu, props.open, props.wrap])

  useLayoutEffect(() => {
    if (!props.open) {
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
  }, [panelRole, position, props.open])

  useLayoutEffect(() => {
    if (!props.open) return

    const updatePosition = () => {
      const triggerBounds = props.triggerRef.current?.getBoundingClientRect()
      const currentPanel = panel.current
      const menuBounds = currentPanel?.getBoundingClientRect()
      if ((!triggerBounds && !props.request.contextPoint) || !currentPanel || !menuBounds) return

      // The opening animation scales the visual bounds. Layout dimensions
      // stay stable, so right-aligned menus do not drift while it runs.
      const menuWidth = currentPanel.offsetWidth || menuBounds.width
      const menuHeight = currentPanel.offsetHeight || menuBounds.height

      // Panels that want to sit flush with their trigger (the account popup)
      // read this; everyone else keeps their intrinsic width.
      if (triggerBounds) {
        currentPanel.style.setProperty('--menu-trigger-w', `${triggerBounds.width}px`)
      }

      const preferredDrop = props.drop ?? 'up'
      const gap = props.request.contextPoint ? 0 : (props.gap ?? MENU_GAP)
      const anchorTop = props.request.contextPoint?.y ?? triggerBounds?.top ?? 0
      const anchorBottom = props.request.contextPoint?.y ?? triggerBounds?.bottom ?? 0
      const spaceAbove = anchorTop - gap - VIEWPORT_GUTTER
      const spaceBelow = window.innerHeight - anchorBottom - gap - VIEWPORT_GUTTER
      let drop = preferredDrop

      if (drop === 'down' && menuHeight > spaceBelow && spaceAbove > spaceBelow) {
        drop = 'up'
      } else if (drop === 'up' && menuHeight > spaceAbove && spaceBelow > spaceAbove) {
        drop = 'down'
      }

      const preferredLeft = props.request.contextPoint
        ? props.request.contextPoint.x
        : props.align === 'right'
          ? (triggerBounds?.right ?? 0) - menuWidth
          : (triggerBounds?.left ?? 0)
      const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - menuWidth - VIEWPORT_GUTTER)
      const left = Math.min(Math.max(preferredLeft, VIEWPORT_GUTTER), maxLeft)
      const anchorX = props.request.contextPoint
        ? props.request.contextPoint.x
        : props.align === 'right'
          ? (triggerBounds?.right ?? 0)
          : (triggerBounds?.left ?? 0)

      const preferredTop = drop === 'down' ? anchorBottom + gap : anchorTop - gap - menuHeight
      const maxTop = Math.max(VIEWPORT_GUTTER, window.innerHeight - menuHeight - VIEWPORT_GUTTER)
      const top = Math.min(Math.max(preferredTop, VIEWPORT_GUTTER), maxTop)
      const next: MenuPosition = {
        left,
        drop,
        originX: anchorX <= left + menuWidth / 2 ? 'left' : 'right',
        originY: drop === 'up' ? 'bottom' : 'top',
        ...(drop === 'up' ? { bottom: window.innerHeight - top - menuHeight } : { top }),
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
    const resizeObserver = globalThis.ResizeObserver
      ? new globalThis.ResizeObserver(updatePosition)
      : undefined
    if (panel.current) resizeObserver?.observe(panel.current)
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', onScroll, true)
      resizeObserver?.disconnect()
    }
  }, [props.align, props.drop, props.gap, props.open, props.request, props.triggerRef])

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

  return props.open
    ? createPortal(
        <div
          ref={panel}
          id={props.panelId}
          className={`menu menu--${position?.drop ?? props.drop ?? 'up'}${position ? ' is-positioned' : ''}${props.panelClassName ? ` ${props.panelClassName}` : ''}`}
          role={panelRole}
          {...(panelLabel ? { 'aria-label': panelLabel } : {})}
          {...(!panelLabel ? { 'aria-labelledby': props.triggerId } : {})}
          aria-modal={panelRole === 'dialog' ? true : undefined}
          data-input-modality={props.request.modality}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          onFocus={(event) => {
            if (panelRole !== 'menu') return
            const item =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>(MENU_ITEM_SELECTOR)
                : null
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
                  ...(position.drop === 'up' ? { bottom: position.bottom } : { top: position.top }),
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
    : null
}

export function MenuItem(props: {
  onClick: () => void
  active?: boolean
  checked?: boolean
  disabled?: boolean
  title: string
  detail?: string | undefined
  icon: ReactNode
  className?: string
  shortcutAria?: string | undefined
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
