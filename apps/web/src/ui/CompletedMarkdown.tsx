import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
} from 'react'
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type BlockProps,
  type Components,
} from 'streamdown'
import 'streamdown/styles.css'
import { canRevealProjectFile, revealProjectFile } from '../bridge.js'
import {
  preserveProjectFileLinks,
  preserveRelativeLink,
  preservedRelativeLink,
  projectFileReference,
} from '../project-file-link.js'
import { isFileReference, isInlineFileReference } from './file-reference.js'
import { FileTypeIcon } from './FileTypeIcon.js'
import { shikiPlugin } from './highlighter.js'
import { STREAMDOWN_ICONS } from './streamdown-icons.js'
import {
  ChatImage,
  ChatImageContext,
  MarkdownImage,
  MarkdownImageContext,
} from './MarkdownImage.js'
import { MarkdownBlock, MarkdownCode, MarkdownPre } from './LargeCodeBlock.js'
import { closedBlockCount, createBlockSplitter } from './markdown-blocks.js'

type InlineCodeProps = ComponentPropsWithoutRef<'code'> & { node?: unknown }

function InlineCode({ children, node: _node, ...props }: InlineCodeProps) {
  const reference = typeof children === 'string' && isInlineFileReference(children)

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

function MarkdownLink({ children, href: source, node: _node, ...props }: MarkdownLinkProps) {
  const projectPath = useContext(ProjectPathContext)
  const images = useContext(MarkdownImageContext)
  const [revealFailed, setRevealFailed] = useState(false)
  const href = images && source ? repositoryLink(source, images.normalize) : source
  const fileLink = href ? localFileLink(href) : undefined
  if (fileLink) {
    if (projectPath) {
      // projectFileReference decodes the path itself, so it gets the still-encoded href.
      const reference = projectFileReference(fileLink.href, projectPath)
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
        <FileTypeIcon path={fileLink.path} />
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

// PR text resolves a repository-relative link against the PR head, as it does for images.
function repositoryLink(href: string, normalize: (source: string) => string): string {
  const relative = preservedRelativeLink(href)
  if (relative === undefined) return href
  const [, path = '', suffix = ''] = /^([^?#]*)(.*)$/s.exec(relative) ?? []
  const resolved = normalize(path)
  return /^https:\/\//i.test(resolved) ? `${resolved}${suffix}` : href
}

const PRESERVED_FILE_PREFIX = '/__harness/project-file/'

type LocalFileLink = { href: string; path: string }

function localFileLink(href: string): LocalFileLink | undefined {
  const preserved = href.startsWith(PRESERVED_FILE_PREFIX)
  const original = preserved ? decodeHref(href.slice(PRESERVED_FILE_PREFIX.length)) : href
  // A literal ? or # ends the path; an encoded %23 is part of a file name, so cut before decoding.
  const target = original.replace(/[?#].*$/, '')
  const path = decodeHref(target)

  const localPath =
    preserved ||
    path.startsWith('/') ||
    path.startsWith('\\\\') ||
    /^file:\/\//i.test(path) ||
    /^[a-z]:[\\/]/i.test(path)
  if (!localPath) return undefined

  // Preserved links were file: URLs, drive or relative paths, so they stay file links without a known extension.
  return preserved || isFileReference(path) ? { href: target, path } : undefined
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    // Keep the original href when an agent emits a malformed escape sequence.
    return href
  }
}

type MarkdownStrongProps = ComponentPropsWithoutRef<'strong'> & { node?: unknown }

function MarkdownStrong({ children, node: _node }: MarkdownStrongProps) {
  return <strong>{children}</strong>
}

const STREAMDOWN_COMPONENTS = {
  a: MarkdownLink,
  code: MarkdownCode,
  inlineCode: InlineCode,
  pre: MarkdownPre,
  strong: MarkdownStrong,
} satisfies Components
const IMAGE_COMPONENTS = { ...STREAMDOWN_COMPONENTS, img: MarkdownImage } satisfies Components
const CHAT_IMAGE_COMPONENTS = { ...STREAMDOWN_COMPONENTS, img: ChatImage } satisfies Components

type ImageTreeNode = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  value?: string
  children?: ImageTreeNode[]
}

function normalizeImageSources(normalize: (source: string) => string) {
  return (tree: ImageTreeNode) => {
    const pending = [tree]
    while (pending.length) {
      const node = pending.pop()!
      if (node.tagName === 'img' && typeof node.properties?.['src'] === 'string') {
        node.properties['src'] = normalize(node.properties['src'])
      }
      if (node.children) pending.push(...node.children)
    }
  }
}

function preserveRelativeLinks() {
  return (tree: ImageTreeNode) => {
    const pending = [tree]
    while (pending.length) {
      const node = pending.pop()!
      if (node.tagName === 'a' && typeof node.properties?.['href'] === 'string') {
        node.properties['href'] = preserveRelativeLink(node.properties['href'])
      }
      if (node.children) pending.push(...node.children)
    }
  }
}

type MarkdownTreeNode = { type: string; value?: string; children?: MarkdownTreeNode[] }

const FLOW_CONTAINERS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/** Raw HTML as the live parser shows it: inline tags as text, an HTML block as a paragraph. */
function literalHtmlNodes() {
  return (tree: MarkdownTreeNode) => {
    const pending = [tree]
    while (pending.length) {
      const node = pending.pop()!
      if (!node.children) continue
      const flow = FLOW_CONTAINERS.has(node.type)
      node.children = node.children.map((child) => {
        if (child.type !== 'html') return child
        const text = { type: 'text', value: child.value ?? '' }
        return flow ? { type: 'paragraph', children: [text] } : text
      })
      pending.push(...node.children)
    }
  }
}

const BLOCK_ELEMENTS = new Set([
  'blockquote',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'table',
  'ul',
])
const COLLAPSIBLE_WHITESPACE = /^[ \t\r\n]+$/

function isBlockElement(node: ImageTreeNode | undefined): boolean {
  return node?.type === 'element' && BLOCK_ELEMENTS.has(node.tagName ?? '')
}

/**
 * Chat replies show line breaks (white-space: pre-line), so the line endings
 * Markdown writes between blocks and after a hard break's <br> would show as
 * blank lines. Normal wrapping collapses them, so no other view changes.
 */
function dropFormattingLineEndings() {
  return (tree: ImageTreeNode) => {
    const pending = [tree]
    while (pending.length) {
      const node = pending.pop()!
      if (!node.children || node.tagName === 'pre') continue
      const kept: ImageTreeNode[] = []
      for (const [index, child] of node.children.entries()) {
        const previous = node.children[index - 1]
        if (child.type === 'text') {
          const value =
            previous?.tagName === 'br' ? child.value?.replace(/^\r?\n/, '') : child.value
          if (!value) continue
          if (
            COLLAPSIBLE_WHITESPACE.test(value) &&
            (isBlockElement(previous) || isBlockElement(node.children[index + 1]))
          )
            continue
          child.value = value
        }
        kept.push(child)
        pending.push(child)
      }
      node.children = kept
    }
  }
}

const REMARK_PLUGINS = Object.values(defaultRemarkPlugins)
const LITERAL_HTML_REMARK_PLUGINS = [...REMARK_PLUGINS, literalHtmlNodes]
const { raw: RAW_HTML_REHYPE_PLUGIN, ...HARDENING_REHYPE_PLUGINS } = defaultRehypePlugins
const STREAMDOWN_PLUGINS = { code: shikiPlugin }
const STREAMDOWN_CONTROLS = { code: true, table: true, mermaid: false }

/**
 * Which blocks a finished renderer has committed. Streamdown applies a new
 * text's blocks one commit after the text itself, so a renderer that was
 * given a reply's last words shows them only a commit later; this tells
 * when it does.
 */
class BlockCommits {
  private readonly shown: Array<string | undefined> = []
  private wanted: { text: string; blocks: readonly string[] } | undefined
  private notify: ((text: string) => void) | undefined

  commit(index: number, content: string): void {
    this.shown[index] = content
    this.check()
  }

  forget(index: number, content: string): void {
    if (this.shown[index] === content) this.shown[index] = undefined
  }

  /** Calls `notify` once, after the commit that shows all of `blocks`. */
  expect(text: string, blocks: readonly string[], notify: (text: string) => void): void {
    this.wanted = { text, blocks }
    this.notify = notify
    this.check()
  }

  stop(): void {
    this.wanted = undefined
    this.notify = undefined
  }

  private check(): void {
    const wanted = this.wanted
    const notify = this.notify
    if (!wanted || !notify) return
    if (wanted.blocks.some((block, index) => this.shown[index] !== block)) return
    this.stop()
    notify(wanted.text)
  }
}

const BlockCommitsContext = createContext<BlockCommits | undefined>(undefined)

/** A block that reports its commits to the renderer around it. */
const ReportedBlock = memo(function ReportedBlock(props: BlockProps) {
  const commits = useContext(BlockCommitsContext)
  const { index, content } = props
  useLayoutEffect(() => {
    commits?.commit(index, content)
    return () => commits?.forget(index, content)
  }, [commits, content, index])
  return <MarkdownBlock {...props} />
})

/** Full Markdown is loaded only for completed output that uses Markdown syntax.
 * Completed output skips Streamdown's repeated whole-string repair passes. */
export const CompletedMarkdown = memo(function CompletedMarkdown({
  text,
  projectPath,
  hidden = false,
  growing = false,
  onRendered,
  literalHtml = false,
}: {
  text: string
  projectPath?: string | undefined
  /** Rendered ahead, out of view: the live renderer still shows this reply. */
  hidden?: boolean
  /** The text is still streaming: only its closed blocks render. */
  growing?: boolean
  /**
   * Called with `text` after the commit that shows all of its blocks (not
   * while growing). Its identity should not change between renders.
   */
  onRendered?: ((text: string) => void) | undefined
  /** Shows raw HTML outside code as its source text instead of rendering it. */
  literalHtml?: boolean | undefined
}) {
  const renderedText = useMemo(() => preserveProjectFileLinks(text), [text])
  // Per renderer: a text that grows is split again only from its open tail.
  const [splitBlocks] = useState(createBlockSplitter)
  const closed = useMemo(() => {
    if (!growing) return undefined
    const blocks = splitBlocks(renderedText)
    const settled = blocks.slice(0, closedBlockCount(blocks))
    return { source: settled.join(''), blocks: settled }
  }, [growing, renderedText, splitBlocks])
  const source = closed ? closed.source : renderedText
  // Streamdown asks for the blocks of exactly the source it is given.
  const parseBlocks = useCallback(
    (markdown: string) => (closed?.source === markdown ? closed.blocks : splitBlocks(markdown)),
    [closed, splitBlocks],
  )
  const [commits] = useState(() => new BlockCommits())
  // After the blocks' own layout effects: a commit that already shows every
  // block reports at once.
  useLayoutEffect(() => {
    if (!onRendered || growing) commits.stop()
    else commits.expect(text, splitBlocks(renderedText), onRendered)
  }, [commits, growing, onRendered, renderedText, splitBlocks, text])
  const imageSource = useContext(MarkdownImageContext)
  const chatImages = useContext(ChatImageContext)
  const rehypePlugins = useMemo(() => {
    const plugins = Object.values(HARDENING_REHYPE_PLUGINS)
    // Resolve repository- and project-relative paths after raw HTML parsing,
    // before the existing sanitizer/hardener can discard an origin-less URL.
    plugins.unshift(preserveRelativeLinks)
    if (imageSource) plugins.unshift([normalizeImageSources, imageSource.normalize])
    // Literal HTML leaves no raw HTML for rehype-raw to parse.
    if (!literalHtml) plugins.unshift(RAW_HTML_REHYPE_PLUGIN!)
    plugins.push(dropFormattingLineEndings)
    return plugins
  }, [imageSource, literalHtml])

  return (
    <ProjectPathContext.Provider value={projectPath}>
      <BlockCommitsContext.Provider value={commits}>
        <Streamdown
          BlockComponent={ReportedBlock}
          className={hidden ? 'md md-ahead' : 'md'}
          // Streaming mode keeps per-block rendering. Without `animated`,
          // Streamdown applies a changed text's blocks in a transition, so new
          // blocks render in slices instead of one task.
          mode="streaming"
          isAnimating={false}
          parseIncompleteMarkdown={false}
          parseMarkdownIntoBlocksFn={parseBlocks}
          plugins={STREAMDOWN_PLUGINS}
          controls={STREAMDOWN_CONTROLS}
          icons={STREAMDOWN_ICONS}
          components={
            imageSource
              ? IMAGE_COMPONENTS
              : chatImages
                ? CHAT_IMAGE_COMPONENTS
                : STREAMDOWN_COMPONENTS
          }
          remarkPlugins={literalHtml ? LITERAL_HTML_REMARK_PLUGINS : REMARK_PLUGINS}
          rehypePlugins={rehypePlugins}
        >
          {source}
        </Streamdown>
      </BlockCommitsContext.Provider>
    </ProjectPathContext.Provider>
  )
})
