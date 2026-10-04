import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react'

export type MarkdownImageSource = (source: string) => Promise<string>
export type MarkdownImages = {
  normalize: (source: string) => string
  resolve: MarkdownImageSource
}
export const MarkdownImageContext = createContext<MarkdownImages | undefined>(undefined)

type ImageProps = ComponentPropsWithoutRef<'img'> & { node?: unknown }

export function MarkdownImage(props: ImageProps) {
  const resolve = useContext(MarkdownImageContext)?.resolve
  if (typeof props.src !== 'string' || !props.src || !resolve) return null
  return <ResolvedImage key={props.src} {...props} src={props.src} resolve={resolve} />
}

function ResolvedImage({
  src,
  alt,
  width,
  height,
  title,
  resolve,
}: ImageProps & { src: string; resolve: MarkdownImageSource }) {
  const [source, setSource] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const preview = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)

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

  return (
    <span className="md-image-preview" ref={preview}>
      {failed ? (
        <span className="md-image-fallback">
          <span>{alt ? `${alt}: ` : ''}Image unavailable</span>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry image
          </button>
        </span>
      ) : !source ? (
        // The frame the picture will fill, not a caption: an inline note made
        // the paragraph jump twice, once for the text and once for the image.
        <span className="skeleton skeleton-group md-image-skeleton" role="status" aria-busy="true">
          <span className="visually-hidden">Loading image…</span>
        </span>
      ) : (
        <img
          className="md-resolved-image"
          src={source}
          alt={alt ?? ''}
          title={title}
          width={width}
          height={height}
          referrerPolicy="no-referrer"
          decoding="async"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}
