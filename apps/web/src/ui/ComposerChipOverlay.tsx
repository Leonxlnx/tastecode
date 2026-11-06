import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import { BrowserCommentCard } from './BrowserCommentCard.js'
import { browserComment } from './browser-comments.js'
import { chipIcon } from './chip-icons.js'
import {
  composerChipSegments,
  type ComposerChipSegment,
  type ComposerChipTextStore,
} from './composer-chips.js'
import '../styles/chips.css'

/**
 * Draws the draft behind the textarea while it holds chips: the same
 * characters in the same font, so every line and caret position matches, with
 * each chip's icon in the room its em space keeps and its name in the accent
 * colour. The textarea's own text turns transparent above it (chips.css), so
 * caret, selection and input stay the textarea's.
 */
export const ComposerChipOverlay = memo(function ComposerChipOverlay(props: {
  store: ComposerChipTextStore
  area: RefObject<HTMLTextAreaElement | null>
}) {
  const text = useSyncExternalStore(props.store.subscribe, props.store.get)
  const overlay = useRef<HTMLDivElement>(null)
  const segments = useMemo(() => composerChipSegments(text), [text])
  const shown = text !== ''
  const holdsComment = segments.some(
    (segment) => segment.type === 'chip' && segment.kind === 'browser',
  )
  const [hovered, setHovered] = useState<{ id: string; anchor: DOMRect }>()

  // Same scroll position, and the same width once a scrollbar narrows the text.
  useLayoutEffect(() => followTextarea(props.area.current, overlay.current))

  useEffect(() => {
    const area = props.area.current
    if (!shown || !area) return
    const follow = () => followTextarea(area, overlay.current)
    area.addEventListener('scroll', follow, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(follow)
    observer?.observe(area)
    return () => {
      area.removeEventListener('scroll', follow)
      observer?.disconnect()
    }
  }, [props.area, shown])

  // The textarea lies over the chips and takes the pointer, so a chip is found by
  // looking under it. Only a draft that holds a comment pays for this.
  useEffect(() => {
    const area = props.area.current
    if (!holdsComment || !area) {
      setHovered(undefined)
      return
    }
    const move = (event: MouseEvent) => {
      const chip = document
        .elementsFromPoint(event.clientX, event.clientY)
        .find((element) => element instanceof HTMLElement && element.dataset['commentId'])
      const id = chip instanceof HTMLElement ? chip.dataset['commentId'] : undefined
      setHovered((current) =>
        current?.id === id
          ? current
          : id && chip
            ? { id, anchor: chip.getBoundingClientRect() }
            : undefined,
      )
    }
    const leave = () => setHovered(undefined)
    area.addEventListener('mousemove', move, { passive: true })
    area.addEventListener('mouseleave', leave)
    return () => {
      area.removeEventListener('mousemove', move)
      area.removeEventListener('mouseleave', leave)
    }
  }, [props.area, holdsComment])

  const card = hovered ? browserComment(hovered.id) : undefined
  if (!shown) return null
  return (
    <div ref={overlay} className="composer__chips" aria-hidden>
      {segments.map((segment, index) =>
        segment.type === 'chip' ? (
          <OverlayChip key={index} chip={segment} active={segment.commentId === hovered?.id} />
        ) : (
          segment.text
        ),
      )}
      {/* A trailing line break only gets a line box when something follows it. */}
      {text.endsWith('\n') ? '​' : null}
      {card && hovered ? (
        <BrowserCommentCard comment={card} image={card.image} anchor={hovered.anchor} />
      ) : null}
    </div>
  )
})

function OverlayChip({
  chip,
  active,
}: {
  chip: Extract<ComposerChipSegment, { type: 'chip' }>
  active: boolean
}) {
  const Icon = chipIcon(chip.kind, chip.name)
  return (
    <span
      className={`composer-chip composer-chip--${chip.kind}`}
      data-comment-id={chip.commentId}
      data-active={active || undefined}
    >
      <span className="composer-chip__room">
        {` ⁠${chip.mark}`}
        <Icon className="composer-chip__icon" stroke={1.9} aria-hidden />
      </span>
      {`${chip.name}⁠`}
    </span>
  )
}

function followTextarea(area: HTMLTextAreaElement | null, overlay: HTMLDivElement | null) {
  if (!area || !overlay) return
  const scrollbar = area.offsetWidth - area.clientWidth
  overlay.style.right = scrollbar > 0 ? `${scrollbar}px` : ''
  overlay.scrollTop = area.scrollTop
}
