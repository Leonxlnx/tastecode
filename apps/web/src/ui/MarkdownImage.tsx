import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react'
import { isDesktop, revealPath } from '../bridge.js'
import { localImagePath } from './chat-image-source.js'
import { LazyMediaViewer as MediaViewer, preloadMediaViewer } from './LazyMediaViewer.js'

export type MarkdownImageSource = (source: string) => Promise<string>
export type MarkdownImages = {
  normalize: (source: string) => string
  resolve: MarkdownImageSource
}
export const MarkdownImageContext = createContext<MarkdownImages | undefined>(undefined)
/** Loads the pictures a chat's replies show, screenshots on this computer included. */
export const ChatImageContext = createContext<MarkdownImageSource | undefined>(undefined)
/** True inside a Markdown link so linked images navigate instead of nesting a button. */
export const MarkdownLinkContext = createContext(false)

type ImageProps = ComponentPropsWithoutRef<'img'> & { node?: unknown }

export function MarkdownImage(props: ImageProps) {
  const resolve = useContext(MarkdownImageContext)?.resolve
  if (typeof props.src !== 'string' || !props.src || !resolve) return null
  return <ResolvedImage key={props.src} {...props} src={props.src} resolve={resolve} />
}

export function ChatImage(props: ImageProps) {
  const resolve = useContext(ChatImageContext)
  if (typeof props.src !== 'string' || !props.src || !resolve) return null
  const localPath = isDesktop ? localImagePath(props.src) : undefined
  return (
    <ResolvedImage
      key={props.src}
      {...props}
      src={props.src}
      resolve={resolve}
      localPath={localPath}
    />
  )
}

function imageName(source: string, alt: string | undefined): string {
  const trimmedAlt = alt?.trim()
  if (trimmedAlt) return trimmedAlt
  if (!/^data:/i.test(source)) {
    const pathPart = source.replace(/[?#].*$/, '')
    const segment = pathPart.split(/[\\/]/).filter(Boolean).at(-1)
    if (segment) {
      try {
        const decoded = decodeURIComponent(segment).trim()
        if (decoded) return decoded
      } catch {
        if (segment.trim()) return segment.trim()
      }
    }
  }
  return 'Image'
}

function ResolvedImage({
  src,
  alt,
  width,
  height,
  title,
  resolve,
  localPath,
}: ImageProps & {
  src: string
  resolve: MarkdownImageSource
  localPath?: string | undefined
}) {
  const insideLink = useContext(MarkdownLinkContext)
  const [source, setSource] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [viewerOpen, setViewerOpen] = useState(false)
  const preview = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const name = imageName(src, alt)

  useEffect(() => {
    const element = preview.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setVisible(true)
        observer.disconnect()
      },
      { root: element.closest('.pr-detail-body'), rootMargin: '400px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let active = true
    setSource(undefined)
    setFailed(false)
    void resolve(src).then(
      (value) => {
        if (active) setSource(value)
      },
      () => {
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [src, resolve, attempt, visible])

  const image = source ? (
    <img
      className="md-resolved-image"
      src={source}
      alt={alt ?? ''}
      title={title}
      width={width}
      height={height}
      draggable={insideLink ? undefined : false}
      referrerPolicy="no-referrer"
      decoding="async"
      loading="lazy"
      onLoad={insideLink ? undefined : preloadMediaViewer}
      onError={() => setFailed(true)}
    />
  ) : null

  return (
    <span className="md-image-preview" ref={preview}>
      {failed ? (
        <span className="md-image-fallback">
          <span>{alt ? `${alt}: ` : ''}Image unavailable</span>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry image
          </button>
        </span>
      ) : !image ? (
        // The frame the picture will fill, not a caption: an inline note made
        // the paragraph jump twice, once for the text and once for the image.
        <span className="skeleton skeleton-group md-image-skeleton" role="status" aria-busy="true">
          <span className="visually-hidden">Loading image…</span>
        </span>
      ) : insideLink ? (
        image
      ) : (
        <>
          <button
            type="button"
            className="md-image-preview__open"
            aria-label={`Open preview of ${name}`}
            onPointerEnter={preloadMediaViewer}
            onFocus={preloadMediaViewer}
            onClick={() => setViewerOpen(true)}
          >
            {image}
          </button>
          {viewerOpen && source ? (
            <MediaViewer
              src={source}
              name={name}
              mediaType="image"
              onReveal={localPath ? () => void revealPath(localPath) : undefined}
              onClose={() => setViewerOpen(false)}
            />
          ) : null}
        </>
      )}
    </span>
  )
}
