import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClick } from '@tabler/icons-react'
import { knownViewedImagePreview, previewViewedImage } from '../bridge.js'
import { browserCommentElementLabel, type BrowserComment } from './browser-comments.js'
import '../styles/browser-comment.css'

const CARD_WIDTH = 380
const EDGE = 12

/** What a browser comment holds: the marked page, where it was made, and the words. */
export function BrowserCommentCard(props: {
  comment: Pick<BrowserComment, 'comment' | 'title' | 'url' | 'selector'>
  image?: string | undefined
  anchor: DOMRect
}) {
  const { image, anchor } = props
  const panel = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState<{ image: string; url: string }>()
  const source = image
    ? (knownViewedImagePreview(image)?.previewUrl ??
      (loaded?.image === image ? loaded.url : undefined))
    : undefined
  useEffect(() => {
    if (!image || knownViewedImagePreview(image)?.previewUrl) return
    let cancelled = false
    void previewViewedImage(image).then((preview) => {
      if (!cancelled && preview?.previewUrl) setLoaded({ image, url: preview.previewUrl })
    })
    return () => {
      cancelled = true
    }
  }, [image])

  const [top, setTop] = useState(EDGE)
  const width = Math.min(CARD_WIDTH, window.innerWidth - EDGE * 2)
  const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - width - EDGE))
  const place = () => {
    const height = panel.current?.getBoundingClientRect().height ?? 0
    const above = anchor.top - height - 8
    setTop(
      Math.max(
        EDGE,
        Math.min(above >= EDGE ? above : anchor.bottom + 8, window.innerHeight - height - EDGE),
      ),
    )
  }
  useLayoutEffect(place, [anchor, source, props.comment])
  return createPortal(
    <div ref={panel} className="browser-comment-card" role="tooltip" style={{ left, top, width }}>
      {source ? (
        <div className="browser-comment-card__shot">
          <span className="browser-comment-card__element">
            {browserCommentElementLabel(props.comment.selector)}
          </span>
          <img src={source} alt="Annotated element" onLoad={place} />
        </div>
      ) : null}
      <div className="browser-comment-card__body">
        <p className="browser-comment-card__title">{props.comment.title || props.comment.url}</p>
        <p className="browser-comment-card__comment">{props.comment.comment}</p>
        <p className="browser-comment-card__count">1 element</p>
      </div>
    </div>,
    document.body,
  )
}

/** The chip a sent prompt draws for a comment, keyboard-reachable for its card. */
export function BrowserCommentChip(props: {
  comment: Pick<BrowserComment, 'comment' | 'title' | 'url' | 'selector'>
  label: string
  image?: string | undefined
}) {
  const [anchor, setAnchor] = useState<DOMRect>()
  return (
    <>
      <span
        className="prompt-chip prompt-chip--browser"
        tabIndex={0}
        onPointerEnter={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setAnchor(undefined)}
        onFocus={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        onBlur={() => setAnchor(undefined)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setAnchor(undefined)
        }}
      >
        <IconClick className="prompt-chip__icon" stroke={1.9} aria-hidden />
        {props.label}
      </span>
      {anchor ? (
        <BrowserCommentCard comment={props.comment} image={props.image} anchor={anchor} />
      ) : null}
    </>
  )
}
