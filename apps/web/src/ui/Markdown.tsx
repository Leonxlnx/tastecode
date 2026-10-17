import {
  memo,
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  LIVE_MARKDOWN_BULK_TEXT_MIN,
  LiveMarkdownParser,
  type LiveMarkdownNode,
  type LiveMarkdownOperation,
} from './live-markdown.js'
import { applyCodeWrap } from '../code-wrap.js'
import { isInlineFileReference } from './file-reference.js'
import { REVEAL_PENDING_ATTRIBUTE, revealClock, type RevealCursor } from './reveal-clock.js'
import '../styles/markdown.css'

// Code blocks read the wrap choice from the document root; set it before the
// first block, streaming or completed, renders.
applyCodeWrap()

type CompletedMarkdownModule = typeof import('./CompletedMarkdown.js')

// The rich renderer is a separate chunk. Once it has loaded, a completing
// reply renders it in the same commit. A lazy() boundary would suspend once
// more on its first mount even after the preload, and React then holds its
// fallback for at least 300 ms: the reply collapsed to plain paragraphs.
let completedMarkdownModule: CompletedMarkdownModule | undefined
let completedMarkdownLoad: Promise<CompletedMarkdownModule> | undefined
const loadCompletedMarkdown = (): Promise<CompletedMarkdownModule> =>
  (completedMarkdownLoad ??= import('./CompletedMarkdown.js').then(
    (module) => (completedMarkdownModule = module),
    (cause: unknown) => {
      completedMarkdownLoad = undefined
      throw cause
    },
  ))

/** The rich renderer when it has loaded; until then, starts loading it. */
function useCompletedMarkdown(needed: boolean) {
  const [, setLoaded] = useState(false)
  const component = completedMarkdownModule?.CompletedMarkdown
  useEffect(() => {
    if (!needed || component) return
    let current = true
    loadCompletedMarkdown().then(
      () => {
        // Mounting a long reply's finished renderer takes well over a frame:
        // in a transition it renders in slices beside the live DOM.
        if (current) startTransition(() => setLoaded(true))
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [needed, component])
  return needed ? component : undefined
}

const RICH_MARKDOWN_INLINE =
  /`|\||~~|!\[|\]\s*(?:\(|\[)|<(?:[/!?A-Za-z][^>\r\n]*|[^<>\s@]+@[^<>\s@]+)>|\\(?:[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]|\r?\n)/
const RICH_MARKDOWN_STRUCTURE =
  /https?:\/\/|[wW]{3}\.|[\w.+-]@[A-Za-z\d_-]+\.|(?:^|\n)[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|\r?(?:\n|$))|(?:^|\n)[ \t]{0,3}>|(?:^|\n)[ \t]{0,3}#{1,6}(?:[ \t]+|\r?(?:\n|$))|(?:^|\n)\s*(?:-{3,}|=+)[ \t]*(?:\n|$)|(?:^|\n)(?: {4}|\t)\S| {2,}\r?\n|(?:^|\n)[ \t]{0,3}\[[^\]\r\n]+\]:/
const RICH_MARKDOWN_ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/
const PLAIN_PARAGRAPH_BREAK = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/

/** Plain prose does not need the full Markdown engine or its parser graph. */
export function needsRichMarkdown(text: string): boolean {
  return (
    RICH_MARKDOWN_INLINE.test(text) ||
    RICH_MARKDOWN_STRUCTURE.test(text) ||
    RICH_MARKDOWN_ENTITY.test(text) ||
    hasRepeatedMarker(text, '*') ||
    hasRepeatedMarker(text, '~') ||
    hasPotentialUnderscorePair(text)
  )
}

function hasRepeatedMarker(text: string, marker: string): boolean {
  const first = text.indexOf(marker)
  return first >= 0 && text.indexOf(marker, first + 1) >= 0
}

/** Intraword underscores in identifiers cannot open or close CommonMark emphasis. */
function hasPotentialUnderscorePair(text: string): boolean {
  let candidates = 0
  for (let index = text.indexOf('_'); index >= 0; index = text.indexOf('_', index + 1)) {
    if (isAsciiAlphaNumeric(text[index - 1]) && isAsciiAlphaNumeric(text[index + 1])) continue
    candidates += 1
    if (candidates >= 2) return true
  }
  return false
}

function isAsciiAlphaNumeric(character: string | undefined): boolean {
  if (!character) return false
  const code = character.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

export type LiveMarkdownChange = { kind: 'append'; text: string } | { kind: 'reset'; text: string }

type LiveMarkdownDom = {
  parser: LiveMarkdownParser
  stack: HTMLElement[]
  leaves: Map<number, HTMLElement>
}

function compactTextWrapper(wrapper: HTMLElement): void {
  if (!wrapper.isConnected) return
  const text = wrapper.textContent ?? ''
  const previous = wrapper.previousSibling
  const next = wrapper.nextSibling
  if (previous?.nodeType === Node.TEXT_NODE) {
    previous.textContent = `${previous.textContent ?? ''}${text}`
    wrapper.remove()
    if (next?.nodeType === Node.TEXT_NODE) {
      previous.textContent = `${previous.textContent ?? ''}${next.textContent ?? ''}`
      next.remove()
    }
    return
  }
  if (next?.nodeType === Node.TEXT_NODE) {
    next.textContent = `${text}${next.textContent ?? ''}`
    wrapper.remove()
    return
  }
  wrapper.replaceWith(document.createTextNode(text))
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
  'ordered-list': 'ol',
  'list-item': 'li',
  'thematic-break': 'hr',
  strong: 'strong',
  emphasis: 'em',
  'inline-code': 'code',
  'table-head': 'thead',
  'table-body': 'tbody',
  'table-row': 'tr',
  'table-header-cell': 'th',
  'table-cell': 'td',
  link: 'a',
} satisfies Record<Exclude<LiveMarkdownNode, 'code-block' | 'table'>, keyof HTMLElementTagNameMap>

/** The completed renderer's markers, so a live table is styled as the finished one. */
function liveTablePart(node: LiveMarkdownNode): string | undefined {
  switch (node) {
    case 'table-head':
      return 'table-header'
    case 'table-body':
    case 'table-row':
    case 'table-header-cell':
    case 'table-cell':
      return node
    default:
      return undefined
  }
}

function mountLiveMarkdownLeaf(parent: HTMLElement, text = ''): HTMLElement {
  const span = document.createElement('span')
  span.dataset.liveMarkdownLeaf = ''
  span.style.display = 'inline'
  span.style.minHeight = '0'
  if (text) span.append(text)
  parent.append(span)
  return span
}

function openLiveMarkdownNode(
  parent: HTMLElement,
  dom: LiveMarkdownDom,
  operation: Extract<LiveMarkdownOperation, { type: 'node.open' }>,
): void {
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
    return
  }

  if (operation.node === 'table') {
    // The completed table's wrapper: a controls row above a scroller. The
    // controls row is empty while streaming but keeps its height, so the
    // finished table lands exactly where the live one was.
    const wrapper = document.createElement('div')
    const controls = document.createElement('div')
    const scroller = document.createElement('div')
    const table = document.createElement('table')
    wrapper.dataset.streamdown = 'table-wrapper'
    table.dataset.streamdown = 'table'
    scroller.append(table)
    wrapper.append(controls, scroller)
    parent.append(wrapper)
    dom.stack.push(table)
    return
  }

  const element = document.createElement(LIVE_NODE_TAG[operation.node])
  const part = liveTablePart(operation.node)
  if (part) element.dataset.streamdown = part
  if (operation.align) element.style.textAlign = operation.align
  if (operation.start !== undefined && element instanceof HTMLOListElement) {
    element.start = operation.start
  }
  if (operation.node === 'link' && operation.href && element instanceof HTMLAnchorElement) {
    element.href = operation.href
    element.target = '_blank'
    element.rel = 'noreferrer'
  }
  parent.append(element)
  dom.stack.push(element)
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const LIVE_FILE_ICON_PATHS = [
  'M14 3v4a1 1 0 0 0 1 1h4',
  'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z',
]

/**
 * A finished backticked file name renders as a file reference: an icon and
 * prose type instead of a code chip. Settling the live span into the same box
 * (a generic file icon until the typed one arrives) keeps a table's columns
 * and a paragraph's line breaks where they will be once the reply completes.
 * Its icon waits for the reveal like a code chip's box does.
 */
function settleLiveInlineCode(code: HTMLElement, reveal: RevealCursor): void {
  if (!isInlineFileReference(code.textContent ?? '')) return
  const reference = document.createElement('span')
  const icon = document.createElement('span')
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg')
  reference.className = 'md-file-ref'
  icon.className = 'md-file-ref__icon'
  icon.setAttribute('aria-hidden', 'true')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const d of LIVE_FILE_ICON_PATHS) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  icon.append(svg)
  reference.append(icon, ...code.childNodes)
  code.replaceWith(reference)
  if (code.hasAttribute(REVEAL_PENDING_ATTRIBUTE)) reveal.holdBox(reference)
}

/** A GFM task marker: the same disabled checkbox the completed list renders. */
function mountLiveTaskMarker(parent: HTMLElement, checked: boolean): void {
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.disabled = true
  input.checked = checked
  parent.append(input, ' ')
  parent.classList.add('task-list-item')
  parent.parentElement?.classList.add('contains-task-list')
}

/**
 * Applies parser operations to the live DOM and returns how many characters
 * of text it appended after the last reset. Sealed leaves fold back into
 * their neighbours unless the reveal is tracking the reply: it holds a
 * position inside those text nodes until the reply is complete.
 */
function applyLiveMarkdown(
  root: HTMLElement,
  dom: LiveMarkdownDom,
  operations: LiveMarkdownOperation[],
  reveal: RevealCursor,
): number {
  const compact = !reveal.tracking
  const pendingLeaves = new Map<number, { parent: HTMLElement; text: string[] }>()
  let appended = 0
  let bufferedParent: HTMLElement | undefined
  const bufferedText: string[] = []
  const flushText = () => {
    if (bufferedParent && bufferedText.length > 0) {
      const text = bufferedText.join('')
      bufferedParent.append(text)
      appended += text.length
    }
    bufferedParent = undefined
    bufferedText.length = 0
  }
  const bufferText = (parent: HTMLElement, text: string) => {
    if (bufferedParent && bufferedParent !== parent) flushText()
    bufferedParent = parent
    bufferedText.push(text)
  }

  for (const operation of operations) {
    if (operation.type === 'reset') {
      bufferedParent = undefined
      bufferedText.length = 0
      pendingLeaves.clear()
      appended = 0
      root.replaceChildren()
      dom.stack = []
      dom.leaves.clear()
      continue
    }

    const parent = dom.stack.at(-1) ?? root
    if (operation.type === 'node.open') {
      flushText()
      openLiveMarkdownNode(parent, dom, operation)
      // A code chip laid out ahead would show as an empty box until its text
      // arrives, and a list item as a bullet with nothing next to it.
      if (operation.node === 'inline-code' || operation.node === 'list-item') {
        reveal.holdBox(dom.stack.at(-1)!)
      }
      continue
    }
    if (operation.type === 'node.close') {
      flushText()
      const element = dom.stack.pop()
      if (operation.node === 'inline-code' && element) settleLiveInlineCode(element, reveal)
      continue
    }
    if (operation.type === 'task') {
      flushText()
      mountLiveTaskMarker(parent, operation.checked)
      appended += 1
      continue
    }
    if (operation.type === 'leaf.bulk') {
      bufferText(parent, operation.text)
      continue
    }
    if (operation.type === 'leaf.open') {
      pendingLeaves.set(operation.id, { parent, text: [] })
      continue
    }
    const pendingLeaf = pendingLeaves.get(operation.id)
    if (pendingLeaf) {
      if (operation.type === 'leaf.append') pendingLeaf.text.push(operation.text)
      else {
        bufferText(pendingLeaf.parent, pendingLeaf.text.join(''))
        pendingLeaves.delete(operation.id)
      }
      continue
    }
    const leaf = dom.leaves.get(operation.id)
    if (operation.type === 'leaf.append') {
      if (!leaf) continue
      flushText()
      // One text node per leaf: a node per appended delta left dozens of
      // fragments in a paragraph for the leaf's close to merge.
      const last = leaf.lastChild
      if (last instanceof Text) last.appendData(operation.text)
      else leaf.append(operation.text)
      appended += operation.text.length
    } else if (leaf) {
      flushText()
      if (compact) compactTextWrapper(leaf)
      dom.leaves.delete(operation.id)
    }
  }

  flushText()
  for (const [id, pendingLeaf] of pendingLeaves) {
    const text = pendingLeaf.text.join('')
    dom.leaves.set(id, mountLiveMarkdownLeaf(pendingLeaf.parent, text))
    appended += text.length
  }
  return appended
}

function appendLiveMarkdown(
  root: HTMLElement,
  dom: LiveMarkdownDom,
  text: string,
  reveal: RevealCursor,
): number {
  const update =
    text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN
      ? dom.parser.appendLarge(text)
      : dom.parser.append(text)
  return applyLiveMarkdown(root, dom, update.operations, reveal)
}

function replaceLiveMarkdown(
  root: HTMLElement,
  dom: LiveMarkdownDom,
  text: string,
  reveal: RevealCursor,
): number {
  const update =
    text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN
      ? dom.parser.replaceLarge(text)
      : dom.parser.replace(text)
  return applyLiveMarkdown(root, dom, update.operations, reveal)
}

/**
 * A reply's first text is revealed like the rest when it is about one
 * delta's worth. A longer one is a reply opened mid-stream: it shows at once.
 */
const INITIAL_REVEAL_MAX_CHARACTERS = 200

/**
 * How often a streaming rich reply's finished renderer catches up with it.
 * Each catch-up renders only the blocks that closed since, in a transition.
 */
const AHEAD_INTERVAL_MS = 300
/** How long a finished reply waits for its renderer ahead to show all of it. */
const AHEAD_SHOW_TIMEOUT_MS = 1000

/**
 * The text a streaming reply's finished renderer renders ahead: the reply as
 * it stood at the last catch-up, once it needs the rich renderer. Undefined
 * until then. Per delta this costs one effect that finds its timer running.
 */
function useTextAhead(text: string, streaming: boolean): string | undefined {
  const [ahead, setAhead] = useState<string | undefined>(undefined)
  const latest = useRef(text)
  const timer = useRef<number | undefined>(undefined)
  const rich = useRef(false)
  useEffect(() => {
    latest.current = text
    if (!streaming) {
      window.clearTimeout(timer.current)
      timer.current = undefined
      return
    }
    if (timer.current !== undefined) return
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      const next = latest.current
      rich.current ||= needsRichMarkdown(next)
      if (rich.current) startTransition(() => setAhead(next))
    }, AHEAD_INTERVAL_MS)
  }, [streaming, text])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return ahead
}

const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  liveUpdate,
  updateVersion,
  busy = true,
  drained,
}: {
  text: string
  /** False once the reply is complete: what is still veiled drains, then `drained` runs. */
  busy?: boolean
  liveUpdate?: LiveMarkdownChange | undefined
  updateVersion?: number | undefined
  drained?: { readonly current: () => void } | undefined
}) {
  const root = useRef<HTMLDivElement>(null)
  const dom = useRef<LiveMarkdownDom | undefined>(undefined)
  const cursor = useRef<RevealCursor | undefined>(undefined)
  const initialized = useRef(false)
  const lastVersion = useRef<number | undefined>(undefined)
  const lastText = useRef(text)
  const completedRendererRequested = useRef(false)

  useEffect(() => {
    if (completedRendererRequested.current) return
    const candidate = liveUpdate?.text ?? text
    if (!needsRichMarkdown(candidate)) return
    completedRendererRequested.current = true
    void loadCompletedMarkdown()
  }, [liveUpdate, text, updateVersion])

  useLayoutEffect(
    () => () => {
      cursor.current?.dispose()
      cursor.current = undefined
    },
    [],
  )

  // Text is laid out the moment it arrives, so a line break is final before
  // a word of it shows; the reveal clock shows it a little later, a character
  // at a time.
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const live = (dom.current ??= {
      parser: new LiveMarkdownParser(),
      stack: [],
      leaves: new Map(),
    })
    let reveal = cursor.current
    if (!reveal) {
      reveal = cursor.current = revealClock().attach(element, {
        onDrained: () => drained?.current(),
      })
      // Mounted again over text that is already shown.
      if (initialized.current) reveal.reset()
    }
    /** The text the parser has seen. */
    let consumed = text

    if (!initialized.current) {
      initialized.current = true
      const appended = replaceLiveMarkdown(element, live, text, reveal)
      if (busy && appended <= INITIAL_REVEAL_MAX_CHARACTERS) reveal.appended(appended)
      else reveal.reset()
    } else if (liveUpdate && updateVersion !== lastVersion.current) {
      const exactAppend =
        liveUpdate.kind === 'append' &&
        text.length === lastText.current.length + liveUpdate.text.length &&
        text.endsWith(liveUpdate.text)
      if (exactAppend) {
        reveal.appended(appendLiveMarkdown(element, live, liveUpdate.text, reveal))
      } else {
        replaceLiveMarkdown(element, live, text, reveal)
        reveal.reset()
      }
    } else if (text !== lastText.current) {
      const shown = lastText.current
      // The last words of a reply can come with its completion instead of a
      // delta, and a finished summary is trimmed: neither starts over.
      if (text.startsWith(shown)) {
        reveal.appended(appendLiveMarkdown(element, live, text.slice(shown.length), reveal))
      } else if (shown.startsWith(text) && shown.slice(text.length).trim() === '') {
        consumed = shown
      } else {
        replaceLiveMarkdown(element, live, text, reveal)
        reveal.reset()
      }
    }
    if (!busy) reveal.finish()
    if (liveUpdate) lastVersion.current = updateVersion
    lastText.current = consumed
  }, [busy, drained, liveUpdate, text, updateVersion])

  return <div aria-busy={busy} className="md" data-streaming-markdown ref={root} />
})
const PlainCompletedMarkdown = memo(function PlainCompletedMarkdown({ text }: { text: string }) {
  const paragraphs = text.includes('\n')
    ? text.split(PLAIN_PARAGRAPH_BREAK).filter(Boolean)
    : [text]
  return (
    <div className="md" data-plain-markdown>
      {(paragraphs.length > 0 ? paragraphs : [text]).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  )
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
  // A finished reply stays live until its reveal has caught up; only then
  // does the finished renderer take over, as a transition.
  const [revealing, setRevealing] = useState(streaming)
  const revealEnabled = revealClock().enabled()
  if (streaming && !revealing) setRevealing(true)
  // Finished while nothing is revealed (reduced motion, a hidden window): it
  // is done at once, and a later render must not bring the live view back.
  if (!streaming && revealing && !revealEnabled) setRevealing(false)
  const drained = useRef(() => startTransition(() => setRevealing(false)))
  const live = streaming || (revealing && revealEnabled)
  // The finished renderer takes over in a background render, never in the
  // commit that ends the reply: rendering a long reply's Markdown takes well
  // over a frame, and the live DOM stays until it is ready. History mounts
  // finished at once (a deferred value starts at its first value).
  const finished = useDeferredValue(!live) && !live
  const richText = finished && needsRichMarkdown(text)
  // Until then, a rich reply's finished renderer renders it ahead, out of
  // view: the closed blocks while it streams, all of it while the reveal
  // drains. Taking over then only has to show it, so it waits until that
  // renderer shows the whole reply.
  const ahead = useTextAhead(text, streaming)
  // It takes the whole text in a background render as well, not in the commit
  // that ends the reply.
  const aheadGrowing = useDeferredValue(streaming)
  const aheadWanted = ahead !== undefined && (!finished || richText)
  const rich = finished ? richText : aheadWanted
  const RichMarkdown = useCompletedMarkdown(rich)
  const [aheadShown, setAheadShown] = useState<string | undefined>(undefined)
  const aheadRendered = useRef((shown: string) => startTransition(() => setAheadShown(shown)))
  // Once it has taken over, a later change of the text stays on it. History
  // starts there, so mounting it costs no second render.
  const [tookOver, setTookOver] = useState(!streaming)
  if (streaming && tookOver) setTookOver(false)
  const waiting =
    !tookOver && finished && aheadWanted && RichMarkdown !== undefined && aheadShown !== text
  useEffect(() => {
    if (!waiting) return
    // A renderer that never reports must not keep the live DOM for good.
    const timer = window.setTimeout(() => aheadRendered.current(text), AHEAD_SHOW_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [text, waiting])
  const settled = finished && !waiting
  if (settled && !tookOver) setTookOver(true)
  return (
    <>
      {/* A rich reply that completes before its renderer has loaded keeps
          the live DOM, so it never collapses meanwhile. */}
      {!settled || (rich && !RichMarkdown) ? (
        <StreamingMarkdown
          key="live"
          text={text}
          liveUpdate={streaming ? liveUpdate : undefined}
          updateVersion={streaming ? updateVersion : undefined}
          busy={streaming}
          drained={drained}
        />
      ) : null}
      {RichMarkdown && rich ? (
        <RichMarkdown
          key="rich"
          text={aheadGrowing ? (ahead ?? text) : text}
          projectPath={projectPath}
          hidden={!settled}
          growing={aheadGrowing}
          onRendered={settled ? undefined : aheadRendered.current}
        />
      ) : null}
      {settled && !rich ? <PlainCompletedMarkdown key="plain" text={text} /> : null}
    </>
  )
})
