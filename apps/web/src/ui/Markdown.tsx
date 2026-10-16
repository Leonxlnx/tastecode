import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  LIVE_MARKDOWN_BULK_TEXT_MIN,
  LiveMarkdownParser,
  type LiveMarkdownNode,
  type LiveMarkdownOperation,
} from './live-markdown.js'
import { applyCodeWrap } from '../code-wrap.js'
import { isInlineFileReference } from './file-reference.js'
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
        if (current) setLoaded(true)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [needed, component])
  return needed ? component : undefined
}

const LIVE_MARKDOWN_ANIMATION_CHARACTER_LIMIT = 4 * 1024

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
  'list-item': 'li',
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
 */
function settleLiveInlineCode(code: HTMLElement): void {
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

function applyAnimatedLiveMarkdown(
  root: HTMLElement,
  dom: LiveMarkdownDom,
  operations: LiveMarkdownOperation[],
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
      openLiveMarkdownNode(parent, dom, operation)
      continue
    }
    if (operation.type === 'node.close') {
      const element = dom.stack.pop()
      if (operation.node === 'inline-code' && element) settleLiveInlineCode(element)
      continue
    }
    if (operation.type === 'task') {
      mountLiveTaskMarker(parent, operation.checked)
      continue
    }
    if (operation.type === 'leaf.bulk') {
      parent.append(operation.text)
      continue
    }
    if (operation.type === 'leaf.open') {
      dom.leaves.set(operation.id, mountLiveMarkdownLeaf(parent))
      continue
    }
    const leaf = dom.leaves.get(operation.id)
    if (operation.type === 'leaf.append') {
      if (!leaf) continue
      const addition = document.createElement('span')
      addition.style.animation = 'fade-in 160ms cubic-bezier(0.23, 1, 0.32, 1)'
      addition.textContent = operation.text
      addition.addEventListener('animationend', () => compactTextWrapper(addition), {
        once: true,
      })
      addition.addEventListener('animationcancel', () => compactTextWrapper(addition), {
        once: true,
      })
      leaf.append(addition)
    } else if (leaf) {
      compactTextWrapper(leaf)
      dom.leaves.delete(operation.id)
    }
  }
}

function applyBufferedLiveMarkdown(
  root: HTMLElement,
  dom: LiveMarkdownDom,
  operations: LiveMarkdownOperation[],
): void {
  const pendingLeaves = new Map<number, { parent: HTMLElement; text: string[] }>()
  let bufferedParent: HTMLElement | undefined
  const bufferedText: string[] = []
  const flushText = () => {
    if (bufferedParent && bufferedText.length > 0) bufferedParent.append(bufferedText.join(''))
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
      root.replaceChildren()
      dom.stack = []
      dom.leaves.clear()
      continue
    }

    const parent = dom.stack.at(-1) ?? root
    if (operation.type === 'node.open') {
      flushText()
      openLiveMarkdownNode(parent, dom, operation)
      continue
    }
    if (operation.type === 'node.close') {
      flushText()
      const element = dom.stack.pop()
      if (operation.node === 'inline-code' && element) settleLiveInlineCode(element)
      continue
    }
    if (operation.type === 'task') {
      flushText()
      mountLiveTaskMarker(parent, operation.checked)
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
      // One text node per leaf: a node per paced step left dozens of
      // fragments in a paragraph for the leaf's close to merge.
      const last = leaf.lastChild
      if (last instanceof Text) last.appendData(operation.text)
      else leaf.append(operation.text)
    } else if (leaf) {
      flushText()
      compactTextWrapper(leaf)
      dom.leaves.delete(operation.id)
    }
  }

  flushText()
  for (const [id, pendingLeaf] of pendingLeaves) {
    dom.leaves.set(id, mountLiveMarkdownLeaf(pendingLeaf.parent, pendingLeaf.text.join('')))
  }
}

function applyLiveMarkdown(
  root: HTMLElement,
  dom: LiveMarkdownDom,
  operations: LiveMarkdownOperation[],
  animate: boolean,
): void {
  if (animate) applyAnimatedLiveMarkdown(root, dom, operations)
  else applyBufferedLiveMarkdown(root, dom, operations)
}

function appendLiveMarkdown(
  root: HTMLElement,
  dom: LiveMarkdownDom,
  text: string,
  fade: boolean,
): void {
  const update =
    text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN ? dom.parser.appendLarge(text) : dom.parser.append(text)
  applyLiveMarkdown(
    root,
    dom,
    update.operations,
    fade && update.scannedCharacters <= LIVE_MARKDOWN_ANIMATION_CHARACTER_LIMIT,
  )
}

/*
 * Providers deliver text in bursts: several words at once, then nothing for
 * 50-150 ms. Shown as it lands, a reply grows in jerks. While the reader
 * allows motion, appended text waits in a small buffer that drains every
 * frame in proportion to what is waiting, never slower than a reading
 * floor, so the reply grows continuously about LIVE_TEXT_LAG_MS behind the
 * provider. The buffer costs a string append per delta; parsing and DOM work
 * happen once per frame, as before.
 */
const LIVE_TEXT_LAG_MS = 90
const LIVE_TEXT_MIN_CHARS_PER_MS = 0.3
const LIVE_TEXT_BUFFER_LIMIT = 4 * 1024
let motionQuery: MediaQueryList | undefined

function paceLiveText(): boolean {
  if (typeof window.matchMedia !== 'function' || typeof requestAnimationFrame !== 'function') {
    return false
  }
  motionQuery ??= window.matchMedia('(prefers-reduced-motion: no-preference)')
  return motionQuery.matches && document.visibilityState === 'visible'
}

/** Steps closer together than this wait for the next frame (about 60 a second). */
const LIVE_TEXT_STEP_MS = 15
const LIVE_TEXT_WORD_REACH = 32

function isLiveTextSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 9
}

/**
 * How much of the buffer the step shows. It ends where a word ends: half a
 * word at a line end jumps to the next line when the rest arrives. A word
 * still arriving at the end of the buffer waits for its end while
 * `holdTail` is set. Words longer than the reach (URLs, hashes) may split;
 * a surrogate pair never does.
 */
function liveTextStep(waiting: string, elapsed: number, holdTail: boolean): number {
  const proportional = Math.ceil((waiting.length * elapsed) / LIVE_TEXT_LAG_MS)
  const floor = Math.ceil(LIVE_TEXT_MIN_CHARS_PER_MS * elapsed)
  let count = Math.min(waiting.length, Math.max(1, proportional, floor))
  const reach = Math.min(waiting.length, count + LIVE_TEXT_WORD_REACH)
  while (count < reach && !isLiveTextSpace(waiting.charCodeAt(count))) count += 1
  // The space after the word goes with it, so the next step starts on a word
  // and no text node made of a lone space sits at a line break.
  if (count < reach) return count + 1
  if (count < waiting.length) {
    const last = waiting.charCodeAt(count - 1)
    return last >= 0xd800 && last <= 0xdbff ? count + 1 : count
  }
  if (!holdTail || isLiveTextSpace(waiting.charCodeAt(waiting.length - 1))) return waiting.length
  let end = waiting.length
  while (end > 0 && !isLiveTextSpace(waiting.charCodeAt(end - 1))) end -= 1
  return end
}

const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  liveUpdate,
  updateVersion,
  busy = true,
}: {
  text: string
  /** False while a completed reply waits for the rich renderer. */
  busy?: boolean
  liveUpdate?: LiveMarkdownChange | undefined
  updateVersion?: number | undefined
}) {
  const root = useRef<HTMLDivElement>(null)
  const dom = useRef<LiveMarkdownDom | undefined>(undefined)
  const initialized = useRef(false)
  const lastVersion = useRef<number | undefined>(undefined)
  const lastText = useRef(text)
  const completedRendererRequested = useRef(false)
  /** Appended text the reader has not been shown yet; see LIVE_TEXT_LAG_MS. */
  const waiting = useRef('')
  const pacing = useRef<{ frame: number; last: number; arrived: number } | undefined>(undefined)

  useEffect(() => {
    if (completedRendererRequested.current) return
    const candidate = liveUpdate?.text ?? text
    if (!needsRichMarkdown(candidate)) return
    completedRendererRequested.current = true
    void loadCompletedMarkdown()
  }, [liveUpdate, text, updateVersion])

  useEffect(
    () => () => {
      if (pacing.current) cancelAnimationFrame(pacing.current.frame)
    },
    [],
  )

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const live = (dom.current ??= {
      parser: new LiveMarkdownParser(),
      stack: [],
      leaves: new Map(),
    })

    const stopPacing = () => {
      if (pacing.current) cancelAnimationFrame(pacing.current.frame)
      pacing.current = undefined
    }
    const showWaiting = () => {
      stopPacing()
      const text = waiting.current
      waiting.current = ''
      if (text) appendLiveMarkdown(element, live, text, true)
    }
    const pace = (now: number) => {
      const state = pacing.current
      if (!state) return
      const elapsed = now - state.last
      if (elapsed >= LIVE_TEXT_STEP_MS) {
        // A word cut off by the provider waits for its end, unless the
        // provider has gone quiet.
        const holdTail = now - state.arrived < LIVE_TEXT_LAG_MS
        const count = liveTextStep(waiting.current, elapsed, holdTail)
        state.last = now
        const shown = waiting.current.slice(0, count)
        waiting.current = waiting.current.slice(count)
        // The steady pace is the motion. A fade per step kept ~20 inline
        // animations repainting the reply on every frame.
        if (shown) appendLiveMarkdown(element, live, shown, false)
      }
      if (waiting.current) state.frame = requestAnimationFrame(pace)
      else pacing.current = undefined
    }

    let update
    if (!initialized.current) {
      update =
        text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN
          ? live.parser.replaceLarge(text)
          : live.parser.replace(text)
      initialized.current = true
    } else if (liveUpdate && updateVersion !== lastVersion.current) {
      const exactAppend =
        liveUpdate.kind === 'append' &&
        text.length === lastText.current.length + liveUpdate.text.length &&
        text.endsWith(liveUpdate.text)
      if (
        exactAppend &&
        liveUpdate.text.length + waiting.current.length <= LIVE_TEXT_BUFFER_LIMIT &&
        paceLiveText()
      ) {
        waiting.current += liveUpdate.text
        const now = performance.now()
        if (pacing.current) pacing.current.arrived = now
        else pacing.current = { frame: requestAnimationFrame(pace), last: now, arrived: now }
      } else if (exactAppend) {
        showWaiting()
        appendLiveMarkdown(element, live, liveUpdate.text, true)
      } else {
        stopPacing()
        waiting.current = ''
        update =
          text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN
            ? live.parser.replaceLarge(text)
            : live.parser.replace(text)
      }
    } else if (text !== lastText.current) {
      stopPacing()
      waiting.current = ''
      update =
        text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN
          ? live.parser.replaceLarge(text)
          : live.parser.replace(text)
    }

    if (update) applyLiveMarkdown(element, live, update.operations, false)
    // A finished reply shows everything at once.
    if (!liveUpdate) showWaiting()
    if (liveUpdate) lastVersion.current = updateVersion
    lastText.current = text
  }, [liveUpdate, text, updateVersion])

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
  const rich = !streaming && needsRichMarkdown(text)
  const RichMarkdown = useCompletedMarkdown(rich)
  if (RichMarkdown) return <RichMarkdown text={text} projectPath={projectPath} />
  // A rich reply that completes before its renderer has loaded keeps the live
  // DOM at the same position in the tree, so it never collapses meanwhile.
  if (streaming || rich) {
    return (
      <StreamingMarkdown
        text={text}
        liveUpdate={streaming ? liveUpdate : undefined}
        updateVersion={streaming ? updateVersion : undefined}
        busy={streaming}
      />
    )
  }
  return <PlainCompletedMarkdown text={text} />
})
