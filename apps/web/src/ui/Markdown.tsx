import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
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
import { canRevealProjectFile, revealProjectFile } from '../bridge.js'
import { preserveProjectFileLinks, projectFileReference } from '../project-file-link.js'
import { FileTypeIcon, isFileReference } from './FileTypeIcon.js'
import { onHighlighterChange, plainCodePlugin, shikiPlugin } from './highlighter.js'

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

const ProjectPathContext = createContext<string | undefined>(undefined)

function MarkdownLink({ children, href, node: _node, ...props }: MarkdownLinkProps) {
  const projectPath = useContext(ProjectPathContext)
  const filePath = href ? localFileReferencePath(href) : undefined
  if (filePath) {
    if (projectPath) {
      const reference = projectFileReference(filePath, projectPath)
      if (reference?.kind === 'safe' && canRevealProjectFile) {
        return (
          <button
            className="md-file-link md-file-link--action"
            type="button"
            title={`Show ${reference.path} in its folder`}
            onClick={() => void revealProjectFile(reference.path, projectPath)}
          >
            <FileTypeIcon path={reference.path} />
            {children}
          </button>
        )
      }
      if (reference?.kind === 'blocked') {
        return (
          <span className="md-file-link md-file-link--blocked" title={reference.reason}>
            <FileTypeIcon path={reference.path} />
            {children}
            <span className="md-file-link__reason">{reference.reason}</span>
          </span>
        )
      }
    }
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
    decoded.startsWith('/__harness/project-file/') ||
    decoded.startsWith('/') ||
    decoded.startsWith('\\\\') ||
    /^file:\/\//i.test(decoded) ||
    /^[a-z]:[\\/]/i.test(decoded)
  if (!localPath) return undefined

  const withoutAnchor = decoded.replace(/[?#].*$/, '')
  if (withoutAnchor.startsWith('/__harness/project-file/')) return withoutAnchor
  return isFileReference(withoutAnchor) ? withoutAnchor : undefined
}

const STREAMDOWN_COMPONENTS = {
  a: MarkdownLink,
  inlineCode: InlineCode,
} satisfies Components

// Streamdown uses these identities to preserve its context values. Recreating
// them per token invalidates completed Markdown blocks above the live tail.
const STREAMDOWN_PLUGINS = { code: shikiPlugin }
const STREAMDOWN_STREAMING_PLUGINS = { code: plainCodePlugin }
const STREAMDOWN_CONTROLS = { code: true, table: true, mermaid: false }

/**
 * Nothing upstream paces the output: a provider emits a chunk, the server
 * forwards it, and the client coalesces a frame's worth. With no stagger every
 * word of a burst starts its fade at the same instant, so a 300ms stall
 * followed by forty words reads as a freeze and then a flash. A small stagger
 * spreads that burst across the gap — enough to flow, not enough to lag
 * visibly behind the model.
 */
const STREAM_ANIMATION = {
  animation: 'fadeIn',
  duration: 160,
  easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
  sep: 'word',
  stagger: 14,
} as const

/**
 * Agent output, rendered.
 *
 * Streamdown rather than react-markdown because a turn arrives token by token:
 * mid-stream there is an unterminated fence, a half-written bold, a dangling
 * link. A standard renderer flickers between raw and rendered on every one.
 *
 * Memoised on the text, so a completed message renders once and stays put while
 * the message after it is still streaming.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  projectPath,
}: {
  text: string
  streaming?: boolean
  projectPath?: string | undefined
}) {
  // Shiki loads grammars in the background. This is the one re-render that
  // swaps plain code for coloured code once they arrive — the layout box is
  // identical either way, so nothing moves.
  const [, bump] = useState(0)
  useEffect(() => onHighlighterChange(() => bump((n) => n + 1)), [])
  // File destinations only become interactive after the message completes.
  // Scanning a growing multi-megabyte live tail on every delta would make the
  // full transcript part of the streaming critical path.
  const renderedText = useMemo(
    () => (streaming ? text : preserveProjectFileLinks(text)),
    [streaming, text],
  )

  return (
    <ProjectPathContext.Provider value={projectPath}>
      <Streamdown
        className="md"
        // A zero-stagger fade softens irregular provider chunks without putting
        // the text behind a second, slower reveal timeline.
        mode="streaming"
        isAnimating={streaming}
        animated={STREAM_ANIMATION}
        parseIncompleteMarkdown
        plugins={streaming ? STREAMDOWN_STREAMING_PLUGINS : STREAMDOWN_PLUGINS}
        controls={STREAMDOWN_CONTROLS}
        icons={STREAMDOWN_ICONS}
        components={STREAMDOWN_COMPONENTS}
      >
        {renderedText}
      </Streamdown>
    </ProjectPathContext.Provider>
  )
})
