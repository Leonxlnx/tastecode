import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck as Check, IconChevronDown as ChevronDown } from '@tabler/icons-react'

export type AppSelectOption<Value extends string = string> = {
  value: Value
  label: string
  disabled?: boolean
}

type Drop = 'up' | 'down'

type SelectPosition = {
  drop: Drop
  left: number
  top: number
}

const SELECT_GAP = 3
const VIEWPORT_GUTTER = 8

function enabledIndex<Value extends string>(
  options: readonly AppSelectOption<Value>[],
  start: number,
  direction: 1 | -1,
) {
  if (options.length === 0) return -1
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (start + offset * direction + options.length) % options.length
    if (!options[index]?.disabled) return index
  }
  return -1
}

function nextEnabledIndex<Value extends string>(
  options: readonly AppSelectOption<Value>[],
  current: number,
  direction: 1 | -1,
) {
  if (options.length === 0) return -1
  const start = current < 0 ? (direction === 1 ? 0 : options.length - 1) : current + direction
  return enabledIndex(options, start, direction)
}

/**
 * TasteCode-owned replacement for native selects. The trigger stays in the
 * layout while the listbox is portalled above scroll containers and dialogs.
 */
export function AppSelect<Value extends string>(props: {
  value: Value
  options: readonly AppSelectOption<Value>[]
  onChange: (value: Value) => void
  ariaLabel: string
  className?: string
  disabled?: boolean
  drop?: Drop
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [position, setPosition] = useState<SelectPosition>()
  const trigger = useRef<HTMLButtonElement>(null)
  const listbox = useRef<HTMLDivElement>(null)
  const id = useId()
  const listboxId = `${id}-listbox`
  const selectedIndex = props.options.findIndex((option) => option.value === props.value)
  const selected = props.options[selectedIndex]

  const openListbox = (direction: 1 | -1 = 1) => {
    const initial =
      selectedIndex >= 0 && !props.options[selectedIndex]?.disabled
        ? selectedIndex
        : enabledIndex(props.options, direction === 1 ? 0 : props.options.length - 1, direction)
    setActiveIndex(initial)
    setPosition(undefined)
    setOpen(true)
  }

  const closeListbox = (restoreFocus = false) => {
    setOpen(false)
    setPosition(undefined)
    if (restoreFocus) trigger.current?.focus()
  }

  const choose = (index: number) => {
    const option = props.options[index]
    if (!option || option.disabled) return
    if (option.value !== props.value) props.onChange(option.value)
    closeListbox(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!trigger.current?.contains(target) && !listbox.current?.contains(target)) {
        closeListbox()
      }
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeListbox(true)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const triggerElement = trigger.current
      const triggerBounds = triggerElement?.getBoundingClientRect()
      const panel = listbox.current
      if (!triggerElement || !triggerBounds || !panel) return

      panel.style.setProperty('--app-select-trigger-w', `${triggerBounds.width}px`)
      const triggerStyle = window.getComputedStyle(triggerElement)
      panel.style.fontFamily = triggerStyle.fontFamily
      panel.style.fontSize = triggerStyle.fontSize
      panel.style.fontWeight = triggerStyle.fontWeight
      panel.style.letterSpacing = triggerStyle.letterSpacing
      const panelBounds = panel.getBoundingClientRect()
      const panelWidth = panel.offsetWidth || panelBounds.width
      const panelHeight = panel.offsetHeight || panelBounds.height
      const spaceAbove = triggerBounds.top - SELECT_GAP - VIEWPORT_GUTTER
      const spaceBelow = window.innerHeight - triggerBounds.bottom - SELECT_GAP - VIEWPORT_GUTTER
      let drop = props.drop ?? 'down'

      if (drop === 'down' && panelHeight > spaceBelow && spaceAbove > spaceBelow) {
        drop = 'up'
      } else if (drop === 'up' && panelHeight > spaceAbove && spaceBelow > spaceAbove) {
        drop = 'down'
      }

      const preferredLeft =
        props.align === 'right' ? triggerBounds.right - panelWidth : triggerBounds.left
      const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - panelWidth - VIEWPORT_GUTTER)
      const left = Math.min(Math.max(preferredLeft, VIEWPORT_GUTTER), maxLeft)
      const preferredTop =
        drop === 'down'
          ? triggerBounds.bottom + SELECT_GAP
          : triggerBounds.top - SELECT_GAP - panelHeight
      const maxTop = Math.max(VIEWPORT_GUTTER, window.innerHeight - panelHeight - VIEWPORT_GUTTER)
      const top = Math.min(Math.max(preferredTop, VIEWPORT_GUTTER), maxTop)
      const next = { drop, left, top }

      setPosition((current) =>
        current?.drop === next.drop && current.left === next.left && current.top === next.top
          ? current
          : next,
      )
    }

    updatePosition()
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && listbox.current?.contains(event.target)) return
      updatePosition()
    }
    const resizeObserver = globalThis.ResizeObserver
      ? new globalThis.ResizeObserver(updatePosition)
      : undefined
    if (listbox.current) resizeObserver?.observe(listbox.current)
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, props.align, props.drop])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const option = listbox.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    option?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open])

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (props.disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (!open) openListbox(direction)
      else setActiveIndex((current) => nextEnabledIndex(props.options, current, direction))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open) return
      event.preventDefault()
      const direction = event.key === 'Home' ? 1 : -1
      setActiveIndex(
        enabledIndex(props.options, direction === 1 ? 0 : props.options.length - 1, direction),
      )
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) choose(activeIndex)
      else openListbox()
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      closeListbox(true)
    } else if (event.key === 'Tab' && open) {
      closeListbox()
    }
  }

  return (
    <div
      className={`app-select${open ? ' is-open' : ''}${props.className ? ` ${props.className}` : ''}`}
    >
      <button
        ref={trigger}
        type="button"
        className="app-select__trigger"
        role="combobox"
        aria-label={props.ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        disabled={props.disabled}
        onClick={() => {
          if (open) closeListbox()
          else openListbox()
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="app-select__value">{selected?.label ?? props.value}</span>
        <ChevronDown className="app-select__chevron" size={14} aria-hidden />
      </button>

      {open
        ? createPortal(
            <div
              ref={listbox}
              id={listboxId}
              className={`app-select__listbox app-select__listbox--${position?.drop ?? props.drop ?? 'down'}${position ? ' is-positioned' : ''}`}
              role="listbox"
              aria-label={props.ariaLabel}
              style={
                position
                  ? { left: position.left, top: position.top }
                  : { left: 0, top: 0, visibility: 'hidden' }
              }
            >
              {props.options.map((option, index) => (
                <div
                  key={option.value}
                  id={`${id}-option-${index}`}
                  className={`app-select__option${index === activeIndex ? ' is-active' : ''}${option.value === props.value ? ' is-selected' : ''}`}
                  role="option"
                  aria-selected={option.value === props.value}
                  aria-disabled={option.disabled || undefined}
                  data-index={index}
                  onMouseEnter={() => {
                    if (!option.disabled) setActiveIndex(index)
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <span>{option.label}</span>
                  {option.value === props.value ? <Check size={13} aria-hidden /> : null}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
