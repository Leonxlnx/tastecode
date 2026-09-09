import {
  createContext,
  memo,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
} from 'react'
import { Streamdown, type Components } from 'streamdown'
import 'streamdown/styles.css'
import { canRevealProjectFile, revealProjectFile } from '../bridge.js'
import { preserveProjectFileLinks, projectFileReference } from '../project-file-link.js'
import { FileTypeIcon, isFileReference } from './FileTypeIcon.js'
import { shikiPlugin } from './highlighter.js'
import { STREAMDOWN_ICONS } from './streamdown-icons.js'

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
