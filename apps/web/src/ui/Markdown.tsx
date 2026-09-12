import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef } from 'react'
import {
  LIVE_MARKDOWN_BULK_TEXT_MIN,
  LiveMarkdownParser,
  type LiveMarkdownNode,
  type LiveMarkdownOperation,
} from './live-markdown.js'
import '../styles/markdown.css'

const loadCompletedMarkdown = () => import('./CompletedMarkdown.js')
const CompletedMarkdown = lazy(() =>
  loadCompletedMarkdown().then((module) => ({ default: module.CompletedMarkdown })),
)

const LIVE_MARKDOWN_ANIMATION_CHARACTER_LIMIT = 4 * 1024

const RICH_MARKDOWN_INLINE =
  /`|\||~~|!\[|\]\s*(?:\(|\[)|<(?:[/!?A-Za-z][^>\r\n]*|[^<>\s@]+@[^<>\s@]+)>|\\(?:[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]|\r?\n)/
const RICH_MARKDOWN_STRUCTURE =
  /https?:\/\/|(?:^|\n)[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|\r?(?:\n|$))|(?:^|\n)[ \t]{0,3}>|(?:^|\n)[ \t]{0,3}#{1,6}(?:[ \t]+|\r?(?:\n|$))|(?:^|\n)\s*(?:-{3,}|=+)[ \t]*(?:\n|$)|(?:^|\n)(?: {4}|\t)\S| {2,}\r?\n|(?:^|\n)[ \t]{0,3}\[[^\]\r\n]+\]:/
const RICH_MARKDOWN_ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/
const PLAIN_PARAGRAPH_BREAK = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/

/** Plain prose does not need the full Markdown engine or its parser graph. */
export function needsRichMarkdown(text: string): boolean {
  return (
    RICH_MARKDOWN_INLINE.test(text) ||
    RICH_MARKDOWN_STRUCTURE.test(text) ||
    RICH_MARKDOWN_ENTITY.test(text) ||
    hasRepeatedMarker(text, '*') ||
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
} satisfies Record<Exclude<LiveMarkdownNode, 'code-block'>, keyof HTMLElementTagNameMap>

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

  const element = document.createElement(LIVE_NODE_TAG[operation.node])
  parent.append(element)
  dom.stack.push(element)
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
      dom.stack.pop()
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
      dom.stack.pop()
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
      leaf.append(operation.text)
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
  const completedRendererRequested = useRef(false)

  useEffect(() => {
    if (completedRendererRequested.current) return
    const candidate = liveUpdate?.text ?? text
    if (!needsRichMarkdown(candidate)) return
    completedRendererRequested.current = true
    void loadCompletedMarkdown()
  }, [liveUpdate, text, updateVersion])

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    dom.current ??= { parser: new LiveMarkdownParser(), stack: [], leaves: new Map() }

    let update
    if (!initialized.current) {
      update =
        text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN
          ? dom.current.parser.replaceLarge(text)
          : dom.current.parser.replace(text)
      initialized.current = true
    } else if (liveUpdate && updateVersion !== lastVersion.current) {
      const exactAppend =
        liveUpdate.kind === 'append' &&
        text.length === lastText.current.length + liveUpdate.text.length &&
        text.endsWith(liveUpdate.text)
      if (exactAppend) {
        update =
          liveUpdate.text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN
            ? dom.current.parser.appendLarge(liveUpdate.text)
            : dom.current.parser.append(liveUpdate.text)
      } else {
        update =
          text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN
            ? dom.current.parser.replaceLarge(text)
            : dom.current.parser.replace(text)
      }
    } else if (text !== lastText.current) {
      update =
        text.length >= LIVE_MARKDOWN_BULK_TEXT_MIN
          ? dom.current.parser.replaceLarge(text)
          : dom.current.parser.replace(text)
    }

    if (update) {
      applyLiveMarkdown(
        element,
        dom.current,
        update.operations,
        update.kind === 'append' &&
          update.scannedCharacters <= LIVE_MARKDOWN_ANIMATION_CHARACTER_LIMIT,
      )
    }
    if (liveUpdate) lastVersion.current = updateVersion
    lastText.current = text
  }, [liveUpdate, text, updateVersion])

  return <div aria-busy="true" className="md" data-streaming-markdown ref={root} />
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
  if (streaming) {
    return <StreamingMarkdown text={text} liveUpdate={liveUpdate} updateVersion={updateVersion} />
  }
  if (!needsRichMarkdown(text)) return <PlainCompletedMarkdown text={text} />
  return (
    <Suspense fallback={<PlainCompletedMarkdown text={text} />}>
      <CompletedMarkdown text={text} projectPath={projectPath} />
    </Suspense>
  )
})
