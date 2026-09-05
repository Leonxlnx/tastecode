import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconSearch as Search,
} from '@tabler/icons-react'
import { usePopupPresence } from './use-popup-presence.js'

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
  originX: 'left' | 'right'
}

type SelectSearch = {
  label: string
  placeholder?: string
  emptyMessage?: string
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

function normalizeSearch(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
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
  search?: SelectSearch
}) {
  const [open, setOpen] = useState(false)
  const [modality, setModality] = useState<'keyboard' | 'pointer'>('keyboard')
  const [activeValue, setActiveValue] = useState<Value>()
  const [searchQuery, setSearchQuery] = useState('')
  const [position, setPosition] = useState<SelectPosition>()
  const trigger = useRef<HTMLButtonElement>(null)
  const listbox = useRef<HTMLDivElement>(null)
  const present = usePopupPresence(open, listbox)
  const searchInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const listboxId = `${id}-listbox`
  const selectedIndex = props.options.findIndex((option) => option.value === props.value)
  const selected = props.options[selectedIndex]
  const searchEnabled = props.search !== undefined
  const normalizedQuery = normalizeSearch(searchQuery.trim())
  const visibleOptions = useMemo(
    () =>
      props.options
        .map((option, index) => ({ option, index }))
        .filter(
          ({ option }) =>
            normalizedQuery.length === 0 || normalizeSearch(option.label).includes(normalizedQuery),
        ),
    [normalizedQuery, props.options],
  )
  const visibleEnabledIndexes = useMemo(
    () => visibleOptions.filter(({ option }) => !option.disabled).map(({ index }) => index),
    [visibleOptions],
  )
  const requestedActiveIndex = props.options.findIndex((option) => option.value === activeValue)
  const activeIndex =
    open && searchEnabled && !visibleEnabledIndexes.includes(requestedActiveIndex)
      ? (visibleEnabledIndexes[0] ?? -1)
      : requestedActiveIndex

  const updateActiveIndex = (index: number) => {
    setActiveValue(props.options[index]?.value)
  }

  const firstVisibleIndex = (direction: 1 | -1) =>
    direction === 1 ? (visibleEnabledIndexes[0] ?? -1) : (visibleEnabledIndexes.at(-1) ?? -1)

  const nextVisibleIndex = (current: number, direction: 1 | -1) => {
    if (visibleEnabledIndexes.length === 0) return -1
    const currentPosition = visibleEnabledIndexes.indexOf(current)
    if (currentPosition < 0) return firstVisibleIndex(direction)
    const nextPosition =
      (currentPosition + direction + visibleEnabledIndexes.length) % visibleEnabledIndexes.length
    return visibleEnabledIndexes[nextPosition] ?? -1
  }

  const updateSearchQuery = (query: string) => {
    setSearchQuery(query)
    const normalized = normalizeSearch(query.trim())
    const firstMatch =
      normalized.length === 0 && selectedIndex >= 0 && !props.options[selectedIndex]?.disabled
        ? selectedIndex
        : props.options.findIndex(
            (option) => !option.disabled && normalizeSearch(option.label).includes(normalized),
          )
    updateActiveIndex(firstMatch)
  }

  const openListbox = (direction: 1 | -1 = 1, input: 'keyboard' | 'pointer' = 'keyboard') => {
    const initial =
      selectedIndex >= 0 && !props.options[selectedIndex]?.disabled
        ? selectedIndex
        : enabledIndex(props.options, direction === 1 ? 0 : props.options.length - 1, direction)
    setSearchQuery('')
    updateActiveIndex(initial)
    setModality(input)
    setOpen(true)
  }

  const closeListbox = (restoreFocus = false) => {
    setOpen(false)
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
      const anchorX = props.align === 'right' ? triggerBounds.right : triggerBounds.left
      const originX = anchorX <= left + panelWidth / 2 ? 'left' : 'right'
      const next: SelectPosition = { drop, left, top, originX }

      setPosition((current) =>
        current?.drop === next.drop &&
        current.left === next.left &&
        current.top === next.top &&
        current.originX === next.originX
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

  useEffect(() => {
    if (open && searchEnabled) searchInput.current?.focus()
  }, [open, searchEnabled])

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (props.disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (!open) openListbox(direction)
      else {
        updateActiveIndex(
          props.search
            ? nextVisibleIndex(activeIndex, direction)
            : nextEnabledIndex(props.options, activeIndex, direction),
        )
      }
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open) return
      event.preventDefault()
      const direction = event.key === 'Home' ? 1 : -1
      updateActiveIndex(
        props.search
          ? firstVisibleIndex(direction)
          : enabledIndex(props.options, direction === 1 ? 0 : props.options.length - 1, direction),
      )
      return
    }
    const spaceChoosesOption = event.key === ' ' && (!props.search || !open || !searchQuery)
    if (event.key === 'Enter' || spaceChoosesOption) {
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
    } else if (
      props.search &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key.length === 1 || (open && event.key === 'Backspace'))
    ) {
      event.preventDefault()
      const currentQuery = open ? searchQuery : ''
      const nextQuery =
        event.key === 'Backspace' ? currentQuery.slice(0, -1) : currentQuery + event.key
      if (!open) openListbox()
      updateSearchQuery(nextQuery)
    }
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      updateActiveIndex(nextVisibleIndex(activeIndex, direction))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(activeIndex)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeListbox(true)
      return
    }
    if (event.key === 'Tab') {
      event.stopPropagation()
      closeListbox(true)
    }
  }

  const optionNodes = visibleOptions.map(({ option, index }) => (
    <div
      key={option.value}
      id={`${id}-option-${index}`}
      className={`app-select__option${index === activeIndex ? ' is-active' : ''}${option.value === props.value ? ' is-selected' : ''}`}
      role="option"
      aria-selected={option.value === props.value}
      aria-disabled={option.disabled || undefined}
      data-index={index}
      onMouseEnter={() => {
        if (!option.disabled) updateActiveIndex(index)
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => choose(index)}
    >
      <span>{option.label}</span>
      {option.value === props.value ? <Check size={13} aria-hidden /> : null}
    </div>
  ))

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
        onClick={(event) => {
          if (open) closeListbox()
          else openListbox(1, event.detail > 0 ? 'pointer' : 'keyboard')
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="app-select__value">{selected?.label ?? props.value}</span>
        <ChevronDown className="app-select__chevron" size={14} aria-hidden />
      </button>

      {present
        ? createPortal(
            <div
              ref={listbox}
              id={props.search ? `${listboxId}-panel` : listboxId}
              className={`app-select__listbox popup app-select__listbox--${position?.drop ?? props.drop ?? 'down'}${position ? ' is-positioned' : ''}`}
              data-popup-state={open && position ? 'open' : 'closed'}
              data-input-modality={modality}
              aria-hidden={!open || undefined}
              inert={!open}
              role={props.search ? undefined : 'listbox'}
              aria-label={props.search ? undefined : props.ariaLabel}
              style={
                position
                  ? {
                      left: position.left,
                      top: position.top,
                      transformOrigin: `${position.originX} ${position.drop === 'up' ? 'bottom' : 'top'}`,
                    }
                  : { left: 0, top: 0, visibility: 'hidden' }
              }
            >
              {props.search ? (
                <div className="app-select__search">
                  <Search size={14} aria-hidden />
                  <input
                    ref={searchInput}
                    type="search"
                    aria-label={props.search.label}
                    aria-controls={listboxId}
                    aria-autocomplete="list"
                    aria-activedescendant={
                      activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined
                    }
                    placeholder={props.search.placeholder ?? props.search.label}
                    value={searchQuery}
                    onChange={(event) => updateSearchQuery(event.currentTarget.value)}
                    onKeyDown={onSearchKeyDown}
                  />
                </div>
              ) : null}
              {props.search ? (
                <div
                  id={listboxId}
                  className="app-select__options"
                  role="listbox"
                  aria-label={props.ariaLabel}
                >
                  {optionNodes}
                </div>
              ) : (
                optionNodes
              )}
              {props.search && visibleOptions.length === 0 ? (
                <p className="app-select__empty" role="status">
                  {props.search.emptyMessage ?? 'No matching options'}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
