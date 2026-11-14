/**
 * The chat list's organize menu: group, sort, order and filter, each a
 * segmented control whose thumb slides between options. It opens to the
 * right of its trigger, beside the sidebar, and stays open while you change
 * things so you can watch the list re-sort next to it.
 *
 * The panel is portalled into the .nd root (so it keeps the design's tokens)
 * and placed with position: fixed, so the scrolling rail can't clip it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { defaultOptions, type ListOptions, type Organize, type Show, type SortKey } from './chat-list'
import { placeBeside } from './placement'
import { SortIcon } from './NavIcons'

/** The panel's padding: its title lines up with the trigger. */
const INSET = 12

export function OrganizeMenu(props: { options: ListOptions; onChange: (next: Partial<ListOptions>) => void }) {
  const { options, onChange } = props
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<{ left: number; top: number; flipped: boolean } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closing = useRef(false)

  /** Fades out, then unmounts. */
  const close = useCallback((returnFocus: boolean) => {
    const box = panel.current
    if (!box || closing.current) return
    closing.current = true
    box
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-out', fill: 'forwards' })
      .finished.catch(() => undefined)
      .then(() => {
        closing.current = false
        setOpen(false)
        if (returnFocus) trigger.current?.focus()
      })
  }, [])

  // Beside the trigger, kept on screen; follows it as the rail scrolls.
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const box = panel.current
      if (anchor && box) setPlace(placeBeside(anchor, box.offsetWidth, box.offsetHeight, INSET))
    }
    update()
    const scroller = trigger.current?.closest('.nd-chats')
    window.addEventListener('resize', update)
    scroller?.addEventListener('scroll', update, { passive: true })
    return () => {
      window.removeEventListener('resize', update)
      scroller?.removeEventListener('scroll', update)
    }
  }, [open])

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const host = open ? (trigger.current?.closest('.nd') as HTMLElement | null) : null
  const byName = options.sort === 'name'
  const isDefault = (Object.keys(defaultOptions) as (keyof ListOptions)[]).every(
    (key) => options[key] === defaultOptions[key],
  )

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="nd-sect__action"
        aria-label="Organize chats"
        title="Organize chats"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) close(false)
          else {
            setPlace(null)
            setOpen(true)
          }
        }}
      >
        <SortIcon />
      </button>
      {host &&
        createPortal(
          <div
            ref={panel}
            className="nd-menu"
            role="dialog"
            aria-label="Organize chats"
            data-flipped={place?.flipped ?? false}
            style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
          >
            <div className="nd-menu__head">
              <span>Organize</span>
              <button
                type="button"
                className="nd-menu__reset"
                data-hidden={isDefault}
                tabIndex={isDefault ? -1 : 0}
                onClick={() => onChange(defaultOptions)}
              >
                Reset
              </button>
            </div>
            <Segmented<Organize>
              label="Group by"
              value={options.organize}
              onChange={(organize) => onChange({ organize })}
              options={[
                { value: 'project', label: 'Project' },
                { value: 'inbox', label: 'Inbox' },
                { value: 'date', label: 'Date' },
                { value: 'list', label: 'None' },
              ]}
            />
            <Segmented<SortKey>
              label="Sort by"
              value={options.sort}
              onChange={(sort) => onChange({ sort })}
              options={[
                { value: 'updated', label: 'Updated' },
                { value: 'created', label: 'Created' },
                { value: 'name', label: 'Name' },
              ]}
            />
            <Segmented<'natural' | 'reversed'>
              label="Order"
              value={options.reversed ? 'reversed' : 'natural'}
              onChange={(order) => onChange({ reversed: order === 'reversed' })}
              options={[
                { value: 'natural', label: byName ? 'A to Z' : 'Newest first' },
                { value: 'reversed', label: byName ? 'Z to A' : 'Oldest first' },
              ]}
            />
            <div className="nd-menu__rule" role="separator" />
            <Segmented<Show>
              label="Show"
              value={options.show}
              onChange={(show) => onChange({ show })}
              options={[
                { value: 'all', label: 'All' },
                { value: 'unread', label: 'Unread' },
                { value: 'running', label: 'Running' },
              ]}
            />
          </div>,
          host,
        )}
    </>
  )
}

function Segmented<T extends string>(props: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const index = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.value),
  )
  return (
    <div className="nd-field">
      <span className="nd-field__label">{props.label}</span>
      <div
        className="nd-seg"
        role="radiogroup"
        aria-label={props.label}
        style={{ '--n': props.options.length, '--i': index } as CSSProperties}
      >
        <span className="nd-seg__thumb" aria-hidden />
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === props.value}
            className="nd-seg__opt"
            onClick={() => props.onChange(option.value)}
          >
            <span className="nd-seg__text">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
