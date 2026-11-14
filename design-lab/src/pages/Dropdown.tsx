/**
 * The new design's dropdown menu. Opens beside its anchor (or at the pointer
 * for a right-click), with submenus, letter shortcuts, full keyboard support,
 * and one highlight that glides to whichever row you're on, by pointer or
 * keys. It fades out on close; a choice runs at once so the list can start
 * moving while the menu leaves.
 *
 * Panels are portalled into the .nd root (so they keep the design's tokens)
 * and placed with position: fixed. Styles: dropdown.css.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import '../styles/dropdown.css'
import { CheckIcon, ChevronIcon } from './NavIcons'
import { PANEL_INSET, placeBeside } from './placement'

export type MenuEntry =
  | {
      kind: 'item'
      label: string
      /** One letter; pressing it while the menu is open picks the item. */
      shortcut?: string
      danger?: boolean
      checked?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | { kind: 'submenu'; label: string; entries: MenuEntry[] }
  | { kind: 'separator' }

export type MenuAnchor = { element: HTMLElement } | { x: number; y: number }

const INSET = PANEL_INSET

export function Dropdown(props: {
  label: string
  anchor: MenuAnchor
  entries: MenuEntry[]
  /** Opened from the keyboard: start on the first item. */
  focusFirst?: boolean
  onClose: () => void
}) {
  const { anchor, onClose } = props
  const anchorEl = 'element' in anchor ? anchor.element : null
  const host = (anchorEl?.closest('.nd') ?? document.querySelector('.nd')) as HTMLElement | null
  const id = useId()
  const closing = useRef(false)

  /** Fades this menu's panels (a submenu too), then unmounts. */
  const close = useCallback(
    (returnFocus: boolean) => {
      if (closing.current) return
      closing.current = true
      const panels = host ? [...host.querySelectorAll<HTMLElement>(`.nd-dd[data-menu="${CSS.escape(id)}"]`)] : []
      const fades = panels.map(
        (panel) =>
          panel.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 120,
            easing: 'ease-out',
            fill: 'forwards',
          }).finished,
      )
      void Promise.all(fades)
        .catch(() => undefined)
        .then(() => {
          onClose()
          if (returnFocus) anchorEl?.focus({ preventScroll: true })
        })
    },
    [host, onClose, anchorEl, id],
  )

  // A click anywhere else, a resize or scrolling the list closes it. The
  // trigger handles its own clicks (it toggles).
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (target?.closest('.nd-dd')) return
      if (anchorEl?.contains(target)) return
      close(false)
    }
    const onAway = () => close(false)
    const list = anchorEl?.closest('.nd-chats')
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('resize', onAway)
    window.addEventListener('blur', onAway)
    list?.addEventListener('scroll', onAway, { passive: true })
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('resize', onAway)
      window.removeEventListener('blur', onAway)
      list?.removeEventListener('scroll', onAway)
    }
  }, [anchorEl, close])

  if (!host) return null
  const at = anchorEl ? anchorEl.getBoundingClientRect() : (anchor as { x: number; y: number })
  return (
    <Panel
      menu={id}
      host={host}
      label={props.label}
      entries={props.entries}
      at={at}
      inset={anchorEl ? INSET : 0}
      level={0}
      focusFirst={Boolean(props.focusFirst)}
      onChoose={(entry) => {
        entry.onSelect()
        close(false)
      }}
      onEscape={() => close(true)}
    />
  )
}

type Item = Extract<MenuEntry, { kind: 'item' }>

function Panel(props: {
  /** Tags every panel of one menu, so closing it fades only its own. */
  menu: string
  host: HTMLElement
  label: string
  entries: MenuEntry[]
  at: DOMRect | { x: number; y: number }
  inset: number
  level: number
  focusFirst: boolean
  onChoose: (entry: Item) => void
  /** Escape at the top level. */
  onEscape: () => void
  /** Leave this submenu for its parent (Left, Escape). */
  onBack?: () => void
  /** The pointer reached this submenu: the parent keeps it open. */
  onReach?: () => void
}) {
  const { entries, level } = props
  const panel = useRef<HTMLDivElement>(null)
  const highlight = useRef<HTMLSpanElement>(null)
  const items = useRef<(HTMLDivElement | null)[]>([])
  const shown = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const [place, setPlace] = useState<{ left: number; top: number; flipped: boolean } | null>(null)
  const [active, setActive] = useState<number | null>(null)
  const [sub, setSub] = useState<{ index: number; focusFirst: boolean } | null>(null)

  const usable = entries.flatMap((entry, i) =>
    entry.kind === 'separator' || (entry.kind === 'item' && entry.disabled) ? [] : [i],
  )

  useLayoutEffect(() => {
    const box = panel.current
    if (!box) return
    setPlace(placeBeside(props.at, box.offsetWidth, box.offsetHeight, props.inset))
    // A submenu opened by hovering leaves the keyboard with its parent.
    if (level === 0 || props.focusFirst) box.focus({ preventScroll: true })
    if (props.focusFirst && usable.length) setActive(usable[0]!)
    // Placed once, where it opened.
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  // The highlight glides to the active row. The first time it appears it
  // starts in place instead of sliding in from the top.
  useLayoutEffect(() => {
    const glow = highlight.current
    if (!glow) return
    const item = active === null ? null : items.current[active]
    if (!item) {
      glow.style.opacity = '0'
      shown.current = false
      return
    }
    const entry = entries[active!]
    glow.dataset['danger'] = String(entry?.kind === 'item' && Boolean(entry.danger))
    const move = `translateY(${item.offsetTop}px)`
    if (!shown.current) {
      glow.style.transition = 'none'
      glow.style.transform = move
      glow.style.height = `${item.offsetHeight}px`
      void glow.offsetWidth
      glow.style.transition = ''
    }
    glow.style.transform = move
    glow.style.height = `${item.offsetHeight}px`
    glow.style.opacity = '1'
    shown.current = true
  }, [active, entries])

  const pick = (index: number, fromKeys: boolean) => {
    const entry = entries[index]
    if (!entry || entry.kind === 'separator') return
    if (entry.kind === 'submenu') {
      clearTimeout(timer.current)
      setSub({ index, focusFirst: fromKeys })
      return
    }
    if (!entry.disabled) props.onChoose(entry)
  }

  // Hovering a submenu row opens it after a beat; hovering another row closes
  // an open submenu after a longer one, so a diagonal move into the submenu
  // doesn't snap it shut on the way.
  const hover = (index: number) => {
    setActive(index)
    clearTimeout(timer.current)
    const entry = entries[index]
    if (entry?.kind === 'submenu') {
      if (sub?.index === index) return
      timer.current = window.setTimeout(() => setSub({ index, focusFirst: false }), 90)
    } else if (sub) {
      timer.current = window.setTimeout(() => setSub(null), 220)
    }
  }

  const step = (by: number) => {
    if (!usable.length) return
    const at = active === null ? -1 : usable.indexOf(active)
    const next = at === -1 ? (by > 0 ? 0 : usable.length - 1) : (at + by + usable.length) % usable.length
    setActive(usable[next]!)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys from an open submenu bubble here through the portal; it handles its own.
    if (e.target !== e.currentTarget) return
    const entry = active === null ? undefined : entries[active]
    let handled = true
    if (e.key === 'ArrowDown') step(1)
    else if (e.key === 'ArrowUp') step(-1)
    else if (e.key === 'Home') setActive(usable[0] ?? null)
    else if (e.key === 'End') setActive(usable[usable.length - 1] ?? null)
    else if (e.key === 'ArrowRight' && entry?.kind === 'submenu') pick(active!, true)
    else if (e.key === 'ArrowLeft' && level > 0) props.onBack?.()
    else if ((e.key === 'Enter' || e.key === ' ') && active !== null) pick(active, true)
    else if (e.key === 'Escape') (level > 0 ? props.onBack : props.onEscape)?.()
    else if (e.key === 'Tab') props.onEscape()
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const index = entries.findIndex(
        (item) => item.kind === 'item' && !item.disabled && item.shortcut?.toLowerCase() === e.key.toLowerCase(),
      )
      if (index === -1) handled = false
      else pick(index, true)
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const subEntry = sub ? entries[sub.index] : undefined
  const subAt = sub ? items.current[sub.index]?.getBoundingClientRect() : undefined

  return createPortal(
    <>
      <div
        ref={panel}
        className="nd-dd"
        data-menu={props.menu}
        role="menu"
        aria-label={props.label}
        tabIndex={-1}
        data-flipped={place?.flipped ?? false}
        // Unplaced it's transparent, not hidden: hidden elements can't take focus.
        style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, opacity: 0 }}
        onKeyDown={onKeyDown}
        onPointerEnter={() => props.onReach?.()}
        onPointerLeave={() => {
          if (!sub) setActive(null)
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span ref={highlight} className="nd-dd__hl" aria-hidden />
        {entries.map((entry, i) => {
          if (entry.kind === 'separator') return <div key={i} className="nd-dd__sep" role="separator" />
          const isSub = entry.kind === 'submenu'
          const item = entry.kind === 'item' ? entry : undefined
          return (
            <div
              key={i}
              ref={(el) => {
                items.current[i] = el
              }}
              className={`nd-dd__item${item?.danger ? ' is-danger' : ''}`}
              role={item?.checked !== undefined ? 'menuitemradio' : 'menuitem'}
              aria-checked={item?.checked}
              aria-disabled={item?.disabled || undefined}
              aria-haspopup={isSub ? 'menu' : undefined}
              aria-expanded={isSub ? sub?.index === i : undefined}
              aria-keyshortcuts={item?.shortcut}
              data-active={active === i}
              onPointerEnter={() => hover(i)}
              onClick={() => pick(i, false)}
            >
              <span className="nd-dd__label">{entry.label}</span>
              {item?.checked && <CheckIcon />}
              {item?.shortcut && <kbd className="nd-dd__key">{item.shortcut}</kbd>}
              {isSub && <ChevronIcon className="nd-dd__chevron" />}
            </div>
          )
        })}
      </div>
      {subEntry?.kind === 'submenu' && subAt && (
        <Panel
          key={`${sub!.index}:${sub!.focusFirst}`}
          menu={props.menu}
          host={props.host}
          label={subEntry.label}
          entries={subEntry.entries}
          at={subAt}
          inset={INSET}
          level={level + 1}
          focusFirst={sub!.focusFirst}
          onChoose={props.onChoose}
          onEscape={props.onEscape}
          onBack={() => {
            setSub(null)
            panel.current?.focus({ preventScroll: true })
          }}
          onReach={() => {
            clearTimeout(timer.current)
            setActive(sub!.index)
          }}
        />
      )}
    </>,
    props.host,
  )
}
