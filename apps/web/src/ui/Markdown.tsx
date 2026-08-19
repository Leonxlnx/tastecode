import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
import { onHighlighterChange, shikiPlugin } from './highlighter.js'
import {
  LiveMarkdownParser,
  type LiveMarkdownNode,
  type LiveMarkdownOperation,
} from './live-markdown.js'

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
  const [revealFailed, setRevealFailed] = useState(false)
  const filePath = href ? localFileReferencePath(href) : undefined
  if (filePath) {
    if (projectPath) {
      const reference = projectFileReference(filePath, projectPath)
      if (reference?.kind === 'safe' && canRevealProjectFile) {
        return (
          <button
            className="md-file-link md-file-link--action"
            type="button"
            title={
              revealFailed
                ? `Try showing ${reference.path} again`
                : `Show ${reference.path} in its folder`
            }
            onClick={() => {
              setRevealFailed(false)
              void revealProjectFile(reference.path, projectPath).catch(() => setRevealFailed(true))
            }}
          >
            <FileTypeIcon path={reference.path} />
            {children}
            {revealFailed ? (
              <span className="md-file-link__reason" role="alert">
                Could not show file
              </span>
            ) : null}
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
 * Completed output uses Streamdown for repaired Markdown, project links and
 * highlighting. The live path below applies parser operations directly so a
 * delta never reparses the accumulated answer.
 */
const CompletedMarkdown = memo(function CompletedMarkdown({
  text,
  projectPath,
}: {
  text: string
  projectPath?: string | undefined
}) {
  // Shiki loads grammars in the background. This is the one re-render that
  // swaps plain code for coloured code once they arrive — the layout box is
  // identical either way, so nothing moves.
  const [, bump] = useState(0)
  useEffect(() => onHighlighterChange(() => bump((n) => n + 1)), [])
  // File destinations only become interactive after the message completes.
  const renderedText = useMemo(() => preserveProjectFileLinks(text), [text])

  return (
    <ProjectPathContext.Provider value={projectPath}>
      <Streamdown
        className="md"
        mode="streaming"
        isAnimating={false}
        animated={STREAM_ANIMATION}
        parseIncompleteMarkdown
        plugins={STREAMDOWN_PLUGINS}
        controls={STREAMDOWN_CONTROLS}
        icons={STREAMDOWN_ICONS}
        components={STREAMDOWN_COMPONENTS}
      >
        {renderedText}
      </Streamdown>
    </ProjectPathContext.Provider>
  )
})

export type LiveMarkdownChange = { kind: 'append'; text: string } | { kind: 'reset'; text: string }

type LiveMarkdownDom = {
  parser: LiveMarkdownParser
  stack: HTMLElement[]
  leaves: Map<number, HTMLElement>
}

const LIVE_NODE_TAG = {
  paragraph: 'p',
  'heading-1': 'h1',
  'heading-2': 'h2',
  'heading-3': 'h3',
  'heading-4': 'h4',
  'heading-5': 'h5',
  'heading-6': 'h6',
  blockquote: 'blockquote',
  list: 'ul',
  'list-item': 'li',
  strong: 'strong',
  emphasis: 'em',
  'inline-code': 'code',
} satisfies Record<Exclude<LiveMarkdownNode, 'code-block'>, keyof HTMLElementTagNameMap>

function applyLiveMarkdown(
  root: HTMLElement,
  dom: LiveMarkdownDom,
  operations: LiveMarkdownOperation[],
  animate: boolean,
): void {
  for (const operation of operations) {
    if (operation.type === 'reset') {
      root.replaceChildren()
      dom.stack = []
      dom.leaves.clear()
      continue
    }

    const parent = dom.stack.at(-1) ?? root
    if (operation.type === 'node.open') {
      if (operation.node === 'code-block') {
        const wrapper = document.createElement('div')
        const header = document.createElement('div')
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        wrapper.dataset.streamdown = 'code-block'
        header.dataset.streamdown = 'code-block-header'
        if (operation.language) header.textContent = operation.language
        pre.append(code)
        wrapper.append(header, pre)
        parent.append(wrapper)
        dom.stack.push(code)
      } else {
        const element = document.createElement(LIVE_NODE_TAG[operation.node])
        parent.append(element)
        dom.stack.push(element)
      }
      continue
    }
    if (operation.type === 'node.close') {
      dom.stack.pop()
      continue
    }
    if (operation.type === 'leaf.open') {
      const span = document.createElement('span')
      span.dataset.liveMarkdownLeaf = ''
      span.style.display = 'inline'
      span.style.minHeight = '0'
      parent.append(span)
      dom.leaves.set(operation.id, span)
      continue
    }
    const leaf = dom.leaves.get(operation.id)
    if (operation.type === 'leaf.append') {
      if (!leaf) continue
      if (!animate) leaf.append(operation.text)
      else {
        const addition = document.createElement('span')
        addition.style.animation = 'fade-in 160ms cubic-bezier(0.23, 1, 0.32, 1)'
        addition.textContent = operation.text
        leaf.append(addition)
      }
    } else if (leaf) {
      leaf.replaceChildren(leaf.textContent)
      dom.leaves.delete(operation.id)
    }
  }
}

const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  liveUpdate,
  updateVersion,
}: {
  text: string
  liveUpdate?: LiveMarkdownChange | undefined
  updateVersion?: number | undefined
}) {
  const root = useRef<HTMLDivElement>(null)
  const dom = useRef<LiveMarkdownDom | undefined>(undefined)
  const initialized = useRef(false)
  const lastVersion = useRef<number | undefined>(undefined)
  const lastText = useRef(text)

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    dom.current ??= { parser: new LiveMarkdownParser(), stack: [], leaves: new Map() }

    let update
    if (!initialized.current) {
      update = dom.current.parser.replace(text)
      initialized.current = true
    } else if (liveUpdate && updateVersion !== lastVersion.current) {
      const exactAppend =
        liveUpdate.kind === 'append' &&
        text.length === lastText.current.length + liveUpdate.text.length &&
        text.endsWith(liveUpdate.text)
      update = exactAppend
        ? dom.current.parser.append(liveUpdate.text)
        : dom.current.parser.replace(text)
    } else if (text !== lastText.current) update = dom.current.parser.replace(text)

    if (update) applyLiveMarkdown(element, dom.current, update.operations, update.kind === 'append')
    if (liveUpdate) lastVersion.current = updateVersion
    lastText.current = text
  }, [liveUpdate, text, updateVersion])

  return <div aria-busy="true" className="md" data-streaming-markdown ref={root} />
})

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  projectPath,
  liveUpdate,
  updateVersion,
}: {
  text: string
  streaming?: boolean
  projectPath?: string | undefined
  liveUpdate?: LiveMarkdownChange | undefined
  updateVersion?: number | undefined
}) {
  return streaming ? (
    <StreamingMarkdown text={text} liveUpdate={liveUpdate} updateVersion={updateVersion} />
  ) : (
    <CompletedMarkdown text={text} projectPath={projectPath} />
  )
})
