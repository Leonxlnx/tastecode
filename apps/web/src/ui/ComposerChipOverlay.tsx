import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from 'react'
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

  if (!shown) return null
  return (
    <div ref={overlay} className="composer__chips" aria-hidden>
      {segments.map((segment, index) =>
        segment.type === 'chip' ? <OverlayChip key={index} chip={segment} /> : segment.text,
      )}
      {/* A trailing line break only gets a line box when something follows it. */}
      {text.endsWith('\n') ? '​' : null}
    </div>
  )
})

function OverlayChip({ chip }: { chip: Extract<ComposerChipSegment, { type: 'chip' }> }) {
  const Icon = chipIcon(chip.kind, chip.name)
  return (
    <span className={`composer-chip composer-chip--${chip.kind}`}>
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
