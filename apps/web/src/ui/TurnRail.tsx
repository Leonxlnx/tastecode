import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { turnAt, type TurnRailEntry } from './turn-rail.js'
import '../styles/turn-rail.css'

/** A pointer crossing the rail on its way elsewhere opens nothing. */
const PREVIEW_DELAY_MS = 90

export type VisibleRows = { first: number; last: number }

export interface TurnRailProps {
  entries: readonly TurnRailEntry[]
  scroller: { current: HTMLElement | null }
  /** The first and last rows the reader can see; needs a stable identity. */
  visibleRows: () => VisibleRows | undefined
  /** The opening of a turn's answer, read when its preview opens. */
  replyOf: (turnId: string) => string
  onJump: (index: number) => void
  /** A wheel over the rail scrolls the chat beside it. */
  onWheel: (event: ReactWheelEvent) => void
}

type Preview = { turnId: string; via: 'pointer' | 'focus' }

/**
 * One tick per prompt down the chat's left edge. It shows where each exchange
 * sits in the chat and which ones are on screen; hovering a tick shows that
 * exchange, and clicking it goes there.
 */
export const TurnRail = memo(function TurnRail({
  entries,
  scroller,
  visibleRows,
  replyOf,
  onJump,
  onWheel,
}: TurnRailProps) {
  const cardId = useId()
  const rootRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState<{ from: number; to: number } | undefined>()
  const [preview, setPreview] = useState<Preview | undefined>()
  const [focused, setFocused] = useState<string | undefined>()
  const previewRef = useRef(preview)
  previewRef.current = preview
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The tick under the pointer, so moving within one tick does nothing. */
  const pointerTurn = useRef<string | undefined>(undefined)
  /** The tick just clicked: its preview stays closed until the pointer moves on. */
  const dismissed = useRef<string | undefined>(undefined)

  useEffect(() => () => clearTimeout(openTimer.current), [])

  // Which exchanges are on screen, read once per frame while the chat scrolls.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    let frame: number | undefined
    const measure = () => {
      frame = undefined
      const rows = entries.length > 0 ? visibleRows() : undefined
      const next = rows && { from: turnAt(entries, rows.first), to: turnAt(entries, rows.last) }
      setInView((current) =>
        current?.from === next?.from && current?.to === next?.to ? current : next,
      )
    }
    const schedule = () => {
      frame ??= window.requestAnimationFrame(measure)
    }
    measure()
    element.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      element.removeEventListener('scroll', schedule)
      observer.disconnect()
    }
  }, [entries, scroller, visibleRows])

  // A rail with more ticks than fit keeps the ones on screen in view.
  const inViewRef = useRef(inView)
  inViewRef.current = inView
  const keepInView = useCallback(() => {
    const list = listRef.current
    const range = inViewRef.current
    if (!list || !range || list.scrollHeight <= list.clientHeight) return
    const first = list.children[range.from] as HTMLElement | undefined
    const last = list.children[range.to] as HTMLElement | undefined
    if (!first || !last) return
    const margin = first.offsetHeight * 4
    if (first.offsetTop - margin < list.scrollTop) list.scrollTop = first.offsetTop - margin
    else if (last.offsetTop + last.offsetHeight + margin > list.scrollTop + list.clientHeight) {
      list.scrollTop = last.offsetTop + last.offsetHeight + margin - list.clientHeight
    }
  }, [])
  useLayoutEffect(keepInView, [inView, entries, keepInView])
  // So does a rail the window just made shorter.
  const shown = entries.length >= 2
  useEffect(() => {
    const list = listRef.current
    if (!shown || !list) return
    const observer = new ResizeObserver(keepInView)
    observer.observe(list)
    return () => observer.disconnect()
  }, [shown, keepInView])

  const previewed = preview ? entries.findIndex((entry) => entry.turnId === preview.turnId) : -1
  const previewEntry = previewed >= 0 ? entries[previewed] : undefined

  // The card sits beside its tick, kept inside the rail's own height.
  useLayoutEffect(() => {
    const root = rootRef.current
    const list = listRef.current
    const card = cardRef.current
    const tick = list?.children[previewed] as HTMLElement | undefined
    if (!root || !list || !card || !tick) return
    const center = list.offsetTop + tick.offsetTop - list.scrollTop + tick.offsetHeight / 2
    const room = Math.max(0, root.clientHeight - card.offsetHeight)
    card.style.transform = `translateY(${Math.min(Math.max(center - card.offsetHeight / 2, 0), room)}px)`
  }, [previewed, previewEntry])

  const open = useCallback((turnId: string, via: Preview['via']) => {
    clearTimeout(openTimer.current)
    setPreview((current) =>
      current?.turnId === turnId && current.via === via ? current : { turnId, via },
    )
  }, [])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'touch') return
      const turnId = (event.target as Element).closest<HTMLElement>('[data-turn]')?.dataset.turn
      if (turnId === undefined || turnId === pointerTurn.current) return
      pointerTurn.current = turnId
      if (dismissed.current === turnId) return
      dismissed.current = undefined
      if (previewRef.current) {
        open(turnId, 'pointer')
        return
      }
      clearTimeout(openTimer.current)
      openTimer.current = setTimeout(() => {
        if (pointerTurn.current) open(pointerTurn.current, 'pointer')
      }, PREVIEW_DELAY_MS)
    },
    [open],
  )
  const onPointerLeave = useCallback(() => {
    clearTimeout(openTimer.current)
    pointerTurn.current = undefined
    dismissed.current = undefined
    setPreview((current) => (current?.via === 'pointer' ? undefined : current))
  }, [])

  const onFocus = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      const tick = (event.target as Element).closest<HTMLElement>('[data-turn]')
      const turnId = tick?.dataset.turn
      if (turnId === undefined) return
      setFocused(turnId)
      // A click focuses the tick too; only the keyboard opens a preview by focus.
      if (focusVisible(tick!)) open(turnId, 'focus')
    },
    [open],
  )
  const onBlur = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setFocused(undefined)
    setPreview((current) => (current?.via === 'focus' ? undefined : current))
  }, [])

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const list = listRef.current
      if (!list) return
      if (event.key === 'Escape') {
        if (!previewRef.current) return
        event.preventDefault()
        setPreview(undefined)
        return
      }
      const at = [...list.children].indexOf(
        (event.target as Element).closest('[data-turn]') as Element,
      )
      const target =
        event.key === 'ArrowUp'
          ? at - 1
          : event.key === 'ArrowDown'
            ? at + 1
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? entries.length - 1
                : undefined
      if (target === undefined) return
      event.preventDefault()
      const tick = list.children[Math.min(Math.max(target, 0), entries.length - 1)] as
        HTMLElement | undefined
      tick?.focus()
      if (tick?.dataset.turn) open(tick.dataset.turn, 'focus')
    },
    [entries.length, open],
  )

  const jump = useCallback(
    (entry: TurnRailEntry) => {
      clearTimeout(openTimer.current)
      dismissed.current = entry.turnId
      setPreview(undefined)
      onJump(entry.index)
    },
    [onJump],
  )

  if (!shown) return null
  const tabbable = focused ?? entries[inView?.from ?? entries.length - 1]?.turnId
  const reply = previewEntry ? replyOf(previewEntry.turnId) : ''

  return (
    <nav className="turn-rail" aria-label="Chat turns" ref={rootRef}>
      <div
        className="turn-rail__ticks"
        ref={listRef}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
      >
        {entries.map((entry, at) => (
          <button
            key={entry.turnId}
            type="button"
            className="turn-rail__tick"
            data-turn={entry.turnId}
            data-in-view={inView && at >= inView.from && at <= inView.to ? '' : undefined}
            data-previewed={at === previewed ? '' : undefined}
            aria-current={inView?.from === at ? 'location' : undefined}
            aria-describedby={at === previewed && reply ? cardId : undefined}
            aria-label={entry.prompt}
            tabIndex={entry.turnId === tabbable ? 0 : -1}
            onClick={() => jump(entry)}
          />
        ))}
      </div>
      {previewEntry ? (
        <div className="turn-rail__preview" ref={cardRef} aria-hidden>
          <div className="turn-rail__prompt">{previewEntry.prompt}</div>
          {reply ? (
            <div className="turn-rail__reply" id={cardId}>
              {reply}
            </div>
          ) : null}
        </div>
      ) : null}
    </nav>
  )
})

function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    // An engine without the selector cannot tell keyboard focus apart.
    return false
  }
}
