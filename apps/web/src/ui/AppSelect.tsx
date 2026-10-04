import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { IconCheck as Check, IconChevronDown as ChevronDown } from '@tabler/icons-react'
import { SkeletonRows, SkeletonStatus } from './Skeleton.js'
import { usePopupPresence } from './use-popup-presence.js'

// Label widths for placeholder options; the listbox sizes to its trigger.
const SELECT_SKELETON_WIDTHS = [104, 76, 128, 92]

export type AppSelectOption<Value extends string = string> = {
  value: Value
  label: string
  disabled?: boolean
  /** A heading the option sits under; consecutive options share one. */
  group?: string | undefined
  /** A font-family to set a short sample in beside the label, for font pickers. */
  sampleFont?: string
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
// A searchable list keeps one height while it filters, so the panel never
// jumps under the pointer. Rows and group headings are fixed heights for it.
const SEARCH_ROW_H = 28
const SEARCH_GROUP_H = 26
const SEARCH_LIST_MAX_H = 296
const SEARCH_LOADING_ROWS = 6

type SampleStyle = CSSProperties & { '--app-select-sample': string }

function sampleStyle(font: string | undefined): SampleStyle | undefined {
  return font ? { '--app-select-sample': font } : undefined
}

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
 * The options a query keeps, best matches first: a label that starts with the
 * query, then one with a word that does, then any other containing it. Groups
 * keep their order, so headings never repeat.
 */
function matchOptions<Value extends string>(
  options: readonly AppSelectOption<Value>[],
  query: string,
): { option: AppSelectOption<Value>; index: number }[] {
  const entries = options.map((option, index) => ({ option, index }))
  if (query.length === 0) return entries
  const groups = new Map<string | undefined, number>()
  const ranked: { option: AppSelectOption<Value>; index: number; group: number; rank: number }[] =
    []
  for (const entry of entries) {
    const label = normalizeSearch(entry.option.label)
    const at = label.indexOf(query)
    if (at < 0) continue
    if (!groups.has(entry.option.group)) groups.set(entry.option.group, groups.size)
    const rank = at === 0 ? 0 : /[\s\-_.]/u.test(label[at - 1] ?? '') ? 1 : 2
    ranked.push({ ...entry, group: groups.get(entry.option.group) ?? 0, rank })
  }
  return ranked
    .sort((a, b) => a.group - b.group || a.rank - b.rank || a.index - b.index)
    .map(({ option, index }) => ({ option, index }))
}

/**
 * TasteCode-owned replacement for native selects. The trigger stays in the
 * layout while the listbox is portalled above scroll containers and dialogs.
 */
export function AppSelect<Value extends string>(props: {
  value: Value
  options: readonly AppSelectOption<Value>[]
  onChange: (value: Value) => void
  allowReselect?: boolean
  ariaLabel: string
  className?: string
  disabled?: boolean
  drop?: Drop
  align?: 'left' | 'right'
  search?: SelectSearch
  loadingMessage?: string | undefined
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [modality, setModality] = useState<'keyboard' | 'pointer'>('keyboard')
  const [activeValue, setActiveValue] = useState<Value>()
  const [searchQuery, setSearchQuery] = useState('')
  const [position, setPosition] = useState<SelectPosition>()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const listbox = useRef<HTMLDivElement>(null)
  // How the active option last changed. A hover must not scroll the list, or
  // resting the pointer on a half-hidden row would pull it into view.
  const activeSource = useRef<'open' | 'keyboard' | 'pointer'>('open')
  const present = usePopupPresence(open, listbox)
  const searchInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const listboxId = `${id}-listbox`
  const selectedIndex = props.options.findIndex((option) => option.value === props.value)
  const selected = props.options[selectedIndex]
  const searchEnabled = props.search !== undefined
  const normalizedQuery = normalizeSearch(searchQuery.trim())
  const visibleOptions = useMemo(
    () => (props.loadingMessage ? [] : matchOptions(props.options, normalizedQuery)),
    [normalizedQuery, props.options, props.loadingMessage],
  )
  const visibleEnabledIndexes = useMemo(
    () => visibleOptions.filter(({ option }) => !option.disabled).map(({ index }) => index),
    [visibleOptions],
  )
  const requestedActiveIndex = props.options.findIndex((option) => option.value === activeValue)
  const activeIndex = props.loadingMessage
    ? -1
    : open && searchEnabled && !visibleEnabledIndexes.includes(requestedActiveIndex)
      ? (visibleEnabledIndexes[0] ?? -1)
      : requestedActiveIndex

  const updateActiveIndex = (index: number, source: 'keyboard' | 'pointer' = 'keyboard') => {
    activeSource.current = source
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
        : (matchOptions(props.options, normalized).find(({ option }) => !option.disabled)?.index ??
          -1)
    updateActiveIndex(firstMatch)
  }

  const openListbox = (direction: 1 | -1 = 1, input: 'keyboard' | 'pointer' = 'keyboard') => {
    props.onOpen?.()
    const initial =
      selectedIndex >= 0 && !props.options[selectedIndex]?.disabled
        ? selectedIndex
        : enabledIndex(props.options, direction === 1 ? 0 : props.options.length - 1, direction)
    setSearchQuery('')
    updateActiveIndex(initial)
    activeSource.current = 'open'
    setModality(input)
    setOpen(true)
  }

  const closeListbox = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }

  const choose = (index: number) => {
    if (props.loadingMessage) return
    const option = props.options[index]
    if (!option || option.disabled) return
    if (option.value !== props.value || props.allowReselect) props.onChange(option.value)
    closeListbox(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!root.current?.contains(target) && !listbox.current?.contains(target)) {
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
    if (!open || activeIndex < 0 || activeSource.current === 'pointer') return
    const option = listbox.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    // Opening centres the chosen option; the keyboard then scrolls only as far as it must.
    option?.scrollIntoView?.({ block: activeSource.current === 'open' ? 'center' : 'nearest' })
  }, [activeIndex, open])

  useEffect(() => {
    if (open && searchEnabled) searchInput.current?.focus({ preventScroll: true })
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

  const optionNodes = visibleOptions.flatMap(({ option, index }, position) => {
    const node = (
      <div
        key={option.value}
        id={`${id}-option-${index}`}
        className={`app-select__option${index === activeIndex ? ' is-active' : ''}${option.value === props.value ? ' is-selected' : ''}`}
        role="option"
        aria-selected={option.value === props.value}
        aria-disabled={option.disabled || undefined}
        data-index={index}
        data-sample={option.sampleFont ? true : undefined}
        style={sampleStyle(option.sampleFont)}
        onMouseMove={() => {
          if (!option.disabled && index !== activeIndex) updateActiveIndex(index, 'pointer')
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(index)}
      >
        <span>{option.label}</span>
        {option.value === props.value ? <Check size={13} aria-hidden /> : null}
      </div>
    )
    const group = option.group
    if (!group || group === visibleOptions[position - 1]?.option.group) return [node]
    return [
      <div key={`group:${group}`} className="app-select__group" role="presentation">
        {group}
      </div>,
      node,
    ]
  })
  const groupCount = new Set(props.options.map((option) => option.group).filter(Boolean)).size
  const searchListHeight = Math.min(
    SEARCH_LIST_MAX_H,
    (props.loadingMessage ? SEARCH_LOADING_ROWS : Math.max(props.options.length, 1)) *
      SEARCH_ROW_H +
      (props.loadingMessage ? 0 : groupCount * SEARCH_GROUP_H) +
      8,
  )

  return (
    <div
      ref={root}
      className={`app-select${open ? ' is-open' : ''}${open && props.search ? ' is-searching' : ''}${props.className ? ` ${props.className}` : ''}`}
    >
      <button
        ref={trigger}
        type="button"
        className="app-select__trigger"
        role="combobox"
        aria-label={props.ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-busy={Boolean(props.loadingMessage) || undefined}
        aria-haspopup="listbox"
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        disabled={props.disabled}
        onClick={(event) => {
          if (open) closeListbox()
          else openListbox(1, event.detail > 0 ? 'pointer' : 'keyboard')
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {/* While typing, the hidden value carries the query so the trigger keeps the field's width. */}
        <span className="app-select__value">
          {(open && props.search && searchQuery) || (selected?.label ?? props.value)}
        </span>
        <ChevronDown className="app-select__chevron" size={14} aria-hidden />
      </button>
      {open && props.search ? (
        // A searchable picker is typed into where its value stands: the value
        // gives way to a field, and the list below holds only the options.
        <input
          ref={searchInput}
          className="app-select__query"
          type="search"
          aria-label={props.search.label}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          placeholder={selected?.label ?? props.search.placeholder ?? props.search.label}
          autoComplete="off"
          spellCheck={false}
          value={searchQuery}
          onChange={(event) => updateSearchQuery(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
        />
      ) : null}

      {present
        ? createPortal(
            <div
              ref={listbox}
              id={props.search ? `${listboxId}-panel` : listboxId}
              className={`app-select__listbox popup app-select__listbox--${position?.drop ?? props.drop ?? 'down'}${props.search ? ' app-select__listbox--search' : ''}${position ? ' is-positioned' : ''}`}
              data-popup-state={open && position ? 'open' : 'closed'}
              data-input-modality={modality}
              aria-hidden={!open || undefined}
              inert={!open}
              role={props.search ? undefined : 'listbox'}
              aria-label={props.search ? undefined : props.ariaLabel}
              aria-busy={Boolean(props.loadingMessage) || undefined}
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
                <>
                  <div
                    id={listboxId}
                    className="app-select__options"
                    role="listbox"
                    aria-label={props.ariaLabel}
                    aria-busy={Boolean(props.loadingMessage) || undefined}
                    style={{ height: searchListHeight }}
                  >
                    {optionNodes}
                    {props.loadingMessage ? (
                      <SkeletonStatus label={props.loadingMessage}>
                        <SkeletonRows rows={4} widths={SELECT_SKELETON_WIDTHS} />
                      </SkeletonStatus>
                    ) : visibleOptions.length === 0 ? (
                      <p className="app-select__empty" role="status">
                        {props.search.emptyMessage ?? 'No matching options'}
                      </p>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  {optionNodes}
                  {props.loadingMessage ? (
                    <SkeletonStatus label={props.loadingMessage}>
                      <SkeletonRows rows={4} widths={SELECT_SKELETON_WIDTHS} />
                    </SkeletonStatus>
                  ) : null}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
