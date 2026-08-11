import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
} from 'react'
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  LoaderCircle,
  Maximize2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Streamdown, type Components, type IconMap } from 'streamdown'
import { FileTypeIcon, isFileReference } from './FileTypeIcon.js'
import { onHighlighterChange, shikiPlugin } from './highlighter.js'

const STREAMDOWN_ICONS = {
  CheckIcon: Check,
  CopyIcon: Copy,
  DownloadIcon: Download,
  ExternalLinkIcon: ExternalLink,
  Loader2Icon: LoaderCircle,
  Maximize2Icon: Maximize2,
  RotateCcwIcon: RotateCcw,
  XIcon: X,
  ZoomInIcon: ZoomIn,
  ZoomOutIcon: ZoomOut,
} satisfies IconMap

type InlineCodeProps = ComponentPropsWithoutRef<'code'> & { node?: unknown }

function InlineCode({ children, node: _node, ...props }: InlineCodeProps) {
  const reference = typeof children === 'string' && isFileReference(children)

  if (!reference) return <code {...props}>{children}</code>

  return (
    <span className="md-file-ref">
      <FileTypeIcon path={children} />
      {children}
    </span>
  )
}

type MarkdownLinkProps = ComponentPropsWithoutRef<'a'> & { node?: unknown }

function MarkdownLink({ children, href, node: _node, ...props }: MarkdownLinkProps) {
  const filePath = href ? localFileReferencePath(href) : undefined
  if (filePath) {
    return (
      <span className="md-file-link" title={href}>
        <FileTypeIcon path={filePath} />
        {children}
      </span>
    )
  }

  const external = href ? /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) : false
  return (
    <a
      {...props}
      href={href}
      target={external ? '_blank' : props.target}
      rel={external ? 'noreferrer' : props.rel}
    >
      {children}
    </a>
  )
}

function localFileReferencePath(href: string): string | undefined {
  let decoded = href
  try {
    decoded = decodeURIComponent(href)
  } catch {
    // Keep the original href when an agent emits a malformed escape sequence.
  }

  const localPath =
    decoded.startsWith('/') ||
    decoded.startsWith('\\\\') ||
    /^file:\/\//i.test(decoded) ||
    /^[a-z]:[\\/]/i.test(decoded)
  if (!localPath) return undefined

  const withoutAnchor = decoded.replace(/[?#].*$/, '')
  return isFileReference(withoutAnchor) ? withoutAnchor : undefined
}

const STREAMDOWN_COMPONENTS = {
  a: MarkdownLink,
  inlineCode: InlineCode,
} satisfies Components

// Streamdown uses these identities to preserve its context values. Recreating
// them per token invalidates completed Markdown blocks above the live tail.
const STREAMDOWN_PLUGINS = { code: shikiPlugin }
const STREAMDOWN_CONTROLS = { code: true, table: true, mermaid: false }
const STREAMING_TEXT_STYLE = {
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
} satisfies CSSProperties

/**
 * Agent output, rendered.
 *
 * Live output stays a readable text node because reparsing an accumulated
 * incomplete document makes every frame cost more than the one before it.
 * Completion swaps that temporary view for full Streamdown Markdown once.
 */
const CompletedMarkdown = memo(function CompletedMarkdown({ text }: { text: string }) {
  // Shiki loads grammars in the background. This is the one re-render that
  // swaps plain code for coloured code once they arrive — the layout box is
  // identical either way, so nothing moves.
  const [, bump] = useState(0)
  useEffect(() => onHighlighterChange(() => bump((n) => n + 1)), [])

  return (
    <Streamdown
      className="md"
      mode="static"
      plugins={STREAMDOWN_PLUGINS}
      controls={STREAMDOWN_CONTROLS}
      icons={STREAMDOWN_ICONS}
      components={STREAMDOWN_COMPONENTS}
    >
      {text}
    </Streamdown>
  )
})

const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const textNodeRef = useRef<Text | null>(null)
  const renderedTextRef = useRef('')

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderedText = renderedTextRef.current
    const stillAppending = text.length >= renderedText.length && text.startsWith(renderedText)

    if (!textNodeRef.current || !stillAppending) {
      const textNode = document.createTextNode(text)
      container.replaceChildren(textNode)
      textNodeRef.current = textNode
    } else if (text.length > renderedText.length) {
      textNodeRef.current.appendData(text.slice(renderedText.length))
    }

    renderedTextRef.current = text
  }, [text])

  return (
    <div
      aria-busy="true"
      className="md"
      data-streaming-markdown
      ref={containerRef}
      style={STREAMING_TEXT_STYLE}
    />
  )
})

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string
  streaming?: boolean
}) {
  return streaming ? <StreamingMarkdown text={text} /> : <CompletedMarkdown text={text} />
})
