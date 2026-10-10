import {
  createContext,
  memo,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
} from 'react'
import { Streamdown, defaultRehypePlugins, type Components } from 'streamdown'
import 'streamdown/styles.css'
import { canRevealProjectFile, revealProjectFile } from '../bridge.js'
import { preserveProjectFileLinks, projectFileReference } from '../project-file-link.js'
import { FileTypeIcon, isFileReference } from './FileTypeIcon.js'
import { shikiPlugin } from './highlighter.js'
import { STREAMDOWN_ICONS } from './streamdown-icons.js'
import { MarkdownImage, MarkdownImageContext } from './MarkdownImage.js'
import { MarkdownBlock, MarkdownPre } from './LargeCodeBlock.js'

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

const PRESERVED_FILE_PREFIX = '/__harness/project-file/'

type LocalFileLink = { href: string; path: string }

function localFileLink(href: string): LocalFileLink | undefined {
  const preserved = href.startsWith(PRESERVED_FILE_PREFIX)
  const original = preserved ? decodeHref(href.slice(PRESERVED_FILE_PREFIX.length)) : href
  // A literal ? or # ends the path; an encoded %23 is part of a file name, so cut before decoding.
  const target = original.replace(/[?#].*$/, '')
  const path = decodeHref(target)

  const localPath =
    path.startsWith('/') ||
    path.startsWith('\\\\') ||
    /^file:\/\//i.test(path) ||
    /^[a-z]:[\\/]/i.test(path)
  if (!localPath) return undefined

  // Preserved links were file: URLs or drive paths, so they stay file links without a known extension.
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

const STREAMDOWN_COMPONENTS = {
  a: MarkdownLink,
  inlineCode: InlineCode,
  pre: MarkdownPre,
} satisfies Components
const IMAGE_COMPONENTS = { ...STREAMDOWN_COMPONENTS, img: MarkdownImage } satisfies Components

type ImageTreeNode = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
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

const STREAMDOWN_PLUGINS = { code: shikiPlugin }
const STREAMDOWN_CONTROLS = { code: true, table: true, mermaid: false }
const STREAM_ANIMATION = {
  animation: 'fadeIn',
  duration: 160,
  easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
  sep: 'word',
  stagger: 14,
} as const

/** Full Markdown is loaded only for completed output that uses Markdown syntax.
 * Completed output skips Streamdown's repeated whole-string repair passes. */
export const CompletedMarkdown = memo(function CompletedMarkdown({
  text,
  projectPath,
}: {
  text: string
  projectPath?: string | undefined
}) {
  const renderedText = useMemo(() => preserveProjectFileLinks(text), [text])
  const imageSource = useContext(MarkdownImageContext)
  const rehypePlugins = useMemo(() => {
    if (!imageSource) return undefined
    const plugins = Object.values(defaultRehypePlugins)
    // Resolve repository-relative paths after raw HTML parsing, before the
    // existing sanitizer/hardener can discard an origin-less image URL.
    plugins.splice(1, 0, [normalizeImageSources, imageSource.normalize])
    return plugins
  }, [imageSource])

  return (
    <ProjectPathContext.Provider value={projectPath}>
      <Streamdown
        BlockComponent={MarkdownBlock}
        className="md"
        mode="streaming"
        isAnimating={false}
        animated={STREAM_ANIMATION}
        parseIncompleteMarkdown
        plugins={STREAMDOWN_PLUGINS}
        controls={STREAMDOWN_CONTROLS}
        icons={STREAMDOWN_ICONS}
        components={imageSource ? IMAGE_COMPONENTS : STREAMDOWN_COMPONENTS}
        {...(rehypePlugins ? { rehypePlugins } : {})}
      >
        {renderedText}
      </Streamdown>
    </ProjectPathContext.Provider>
  )
})
