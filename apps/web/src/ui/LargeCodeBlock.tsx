import {
  cloneElement,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { IconTextWrap as TextWrap } from '@tabler/icons-react'
import {
  Block,
  CodeBlock,
  CodeBlockContainer,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  CodeBlockHeader,
  StreamdownContext,
  useIsCodeFenceIncomplete,
  type HighlightOptions,
  type BlockProps,
  type StreamdownContextType,
} from 'streamdown'
import { readCodeWrap, subscribeCodeWrap, writeCodeWrap } from '../code-wrap.js'
import { shikiPlugin } from './highlighter.js'
import type { HighlightResult } from './highlighter-protocol.js'

const LARGE_CODE_CHARACTERS = 32 * 1024
const CHUNK_LINES = 12
const CODE_LANGUAGE = /language-([^\s]+)/u
const START_LINE = /startLine=(\d+)/u
const NO_LINE_NUMBERS = /\bnoLineNumbers\b/u
type Token = HighlightResult['tokens'][number][number]

/** Which of Streamdown's code block buttons its `controls` setting shows. */
function codeBlockControls(controls: StreamdownContextType['controls']) {
  const code = typeof controls === 'boolean' ? controls : controls.code
  return {
    copy: code !== false && (code === true || code?.copy !== false),
    download: code !== false && (code === true || code?.download !== false),
  }
}

/**
 * Soft-wraps long lines in every code block. The choice lives on the document
 * root, so pressing it re-renders this button only: no block and no
 * highlighted token renders again.
 */
export function CodeWrapButton() {
  const wrap = useSyncExternalStore(subscribeCodeWrap, readCodeWrap)
  return (
    <button
      type="button"
      aria-label="Wrap lines"
      aria-pressed={wrap}
      title="Wrap lines"
      onClick={() => writeCodeWrap(!wrap)}
    >
      <TextWrap size={14} aria-hidden />
    </button>
  )
}

type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
  node?: { properties?: Record<string, unknown> } | undefined
}

function fenceText(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (
    isValidElement<{ children?: unknown }>(children) &&
    typeof children.props.children === 'string'
  )
    return children.props.children
  return ''
}

/**
 * Streamdown's block code renderer with the Wrap toggle beside its download
 * and copy buttons; Streamdown takes no extra code block actions. This keeps
 * its language, `startLine` and `noLineNumbers` handling. The app registers no
 * Mermaid or custom renderers, so those branches of the original never apply.
 * Inline code never arrives here: Streamdown routes it to `inlineCode`.
 */
export const MarkdownCode = memo(
  function MarkdownCode({ node, className, children }: MarkdownCodeProps) {
    const { controls, lineNumbers } = useContext(StreamdownContext)
    const incomplete = useIsCodeFenceIncomplete()
    const language = CODE_LANGUAGE.exec(className ?? '')?.[1] ?? ''
    const meta =
      typeof node?.properties?.['metastring'] === 'string' ? node.properties['metastring'] : ''
    const startLine = Number.parseInt(START_LINE.exec(meta)?.[1] ?? '', 10)
    const code = fenceText(children)
    const shown = codeBlockControls(controls)
    const showControls = typeof controls === 'boolean' ? controls : controls.code !== false
    return (
      <CodeBlock
        className={className}
        code={code}
        isIncomplete={incomplete}
        language={language}
        lineNumbers={!NO_LINE_NUMBERS.test(meta) && lineNumbers !== false}
        {...(startLine >= 1 ? { startLine } : {})}
      >
        {showControls ? (
          <>
            <CodeWrapButton />
            {shown.download ? <CodeBlockDownloadButton code={code} language={language} /> : null}
            {shown.copy ? <CodeBlockCopyButton /> : null}
          </>
        ) : null}
      </CodeBlock>
    )
  },
  (previous, next) =>
    previous.className === next.className &&
    previous.node?.properties?.['metastring'] === next.node?.properties?.['metastring'] &&
    fenceText(previous.children) === fenceText(next.children),
)

/** A simple complete fence needs no HTML/Markdown AST; keep complex syntax on Streamdown. */
export const MarkdownBlock = memo(function MarkdownBlock(props: BlockProps) {
  const fence =
    props.content.length >= LARGE_CODE_CHARACTERS && !props.isIncomplete
      ? /^```([a-zA-Z0-9_+.#-]+)\n([\s\S]*)\n```\n*$/u.exec(props.content)
      : null
  if (fence && fence[2] && !/```|\r|\0/u.test(fence[2]) && !props.dir)
    return (
      <LargeCodeBlock key={`${fence[1]}:${fence[2]}`} code={`${fence[2]}\n`} language={fence[1]!} />
    )
  return <Block {...props} />
})

/** Keep Streamdown's normal renderer for small fences and non-code pre elements. */
export function MarkdownPre({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  if (!isValidElement<{ children?: unknown; className?: string; 'data-block'?: string }>(children))
    return <pre {...props}>{children}</pre>
  const code = children.props.children
  if (typeof code !== 'string' || code.length < LARGE_CODE_CHARACTERS)
    return cloneElement(children, { 'data-block': 'true' })
  const language = /language-([^\s]+)/u.exec(children.props.className ?? '')?.[1] ?? 'text'
  return <LargeCodeBlock key={`${language}:${code}`} code={code} language={language} />
}

function tokenStyle(token: Token): CSSProperties {
  const style: Record<string, string> = {}
  if (token.color) style['--sdm-c'] = token.color
  if (token.bgColor) style['--sdm-tbg'] = token.bgColor
  for (const [name, value] of Object.entries(token.htmlStyle ?? {})) {
    style[name === 'color' ? '--sdm-c' : name === 'background-color' ? '--sdm-tbg' : name] = value
  }
  return style
}

/** Only foreground colors inherit. Preserve every token with attributes or other styling. */
function foregroundKey(token: Token): string | undefined {
  if (
    token.bgColor ||
    Object.keys(token.htmlAttrs ?? {}).length > 0 ||
    Object.keys(token.htmlStyle ?? {}).some((key) => key !== 'color' && key !== '--shiki-dark')
  )
    return undefined
  const style = tokenStyle(token)
  return Object.keys(style).length ? JSON.stringify(style) : undefined
}

function inheritedForeground(tokens: Token[] | undefined): string | undefined {
  const counts = new Map<string, number>()
  let winner: string | undefined
  let most = 1
  for (const token of tokens ?? []) {
    const key = foregroundKey(token)
    if (!key) continue
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count > most) {
      winner = key
      most = count
    }
  }
  return winner
}

const CodeChunk = memo(function CodeChunk({
  lines,
  tokens,
}: {
  lines: string[]
  tokens?: HighlightResult['tokens'] | undefined
}) {
  // Mount the complete plain text with one layout box per chunk. Reserving every
  // line also keeps trailing blank lines at their final height before colors arrive.
  if (!tokens)
    return (
      <span className="md-code-chunk" style={{ minHeight: `${lines.length}lh` }}>
        {lines.join('\n')}
      </span>
    )
  return (
    <span className="md-code-chunk">
      {lines.map((line, index) => {
        const foreground = inheritedForeground(tokens?.[index])
        const content: ReactNode[] = []
        for (const [tokenIndex, token] of (tokens[index] ?? []).entries()) {
          if (foreground && foregroundKey(token) === foreground) {
            const previous = content.at(-1)
            if (typeof previous === 'string') content[content.length - 1] = previous + token.content
            else content.push(token.content)
          } else
            content.push(
              <span key={tokenIndex} style={tokenStyle(token)} {...token.htmlAttrs}>
                {token.content}
              </span>,
            )
        }
        return (
          <span
            className="md-code-line"
            key={index}
            style={foreground ? JSON.parse(foreground) : undefined}
          >
            {line === '' ? '\n' : tokens[index] ? content : line}
          </span>
        )
      })}
    </span>
  )
})

function rootStyle(result: HighlightResult | undefined): CSSProperties {
  const style: Record<string, string> = {}
  if (result?.bg) style['--sdm-bg'] = result.bg
  if (result?.fg) style['--sdm-fg'] = result.fg
  if (result?.rootStyle) {
    for (const declaration of result.rootStyle.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon > 0) style[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
    }
  }
  return style
}

/** All text stays selectable; only decorative token DOM is spread across frames. */
function LargeCodeBlock({ code, language }: { code: string; language: string }) {
  const { controls, shikiTheme } = useContext(StreamdownContext)
  const incomplete = useIsCodeFenceIncomplete()
  const content = code.replace(/\n+$/u, '')
  const chunks = useMemo(() => {
    const lines = content.split('\n')
    const result = []
    for (let start = 0; start < lines.length; start += CHUNK_LINES) {
      const end = Math.min(start + CHUNK_LINES, lines.length)
      result.push({
        start,
        end,
        lines: lines.slice(start, end),
      })
    }
    return result
  }, [content])
  const [result, setResult] = useState<HighlightResult>()
  const [painted, setPainted] = useState(0)
  useEffect(() => {
    let active = true
    const accept = (highlighted: HighlightResult) => {
      if (active) setResult(highlighted)
    }
    const initial = shikiPlugin.highlight(
      { code: content, language: language as HighlightOptions['language'], themes: shikiTheme },
      accept,
    )
    if (initial) accept(initial)
    return () => {
      active = false
    }
  }, [content, language, shikiTheme])
  const highlighted = useMemo(
    () => chunks.map((chunk) => result?.tokens.slice(chunk.start, chunk.end)),
    [chunks, result],
  )
  const hasColors = useMemo(
    () => result?.tokens.some((line) => line.some((token) => token.color || token.htmlStyle)),
    [result],
  )
  useEffect(() => {
    if (!hasColors) return
    let count = 0
    let frame = 0
    const paint = () => {
      count += 1
      setPainted(count)
      if (count < chunks.length) frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(frame)
  }, [chunks.length, hasColors, result])
  const { copy: showCopy, download: showDownload } = codeBlockControls(controls)
  return (
    <CodeBlockContainer
      language={language}
      isIncomplete={incomplete}
      style={{ contentVisibility: 'visible' }}
    >
      <CodeBlockHeader language={language} />
      {showCopy || showDownload ? (
        <div>
          <div data-streamdown="code-block-actions">
            <CodeWrapButton />
            {showDownload ? <CodeBlockDownloadButton code={code} language={language} /> : null}
            {showCopy ? <CodeBlockCopyButton code={code} /> : null}
          </div>
        </div>
      ) : null}
      <div
        data-streamdown="code-block-body"
        data-language={language}
        data-highlight-pending={(hasColors && painted < chunks.length) || undefined}
      >
        <pre style={rootStyle(result)}>
          <code>
            {chunks.map((chunk, index) => (
              <CodeChunk
                key={chunk.start}
                lines={chunk.lines}
                tokens={index < painted ? highlighted[index] : undefined}
              />
            ))}
          </code>
        </pre>
      </div>
    </CodeBlockContainer>
  )
}
