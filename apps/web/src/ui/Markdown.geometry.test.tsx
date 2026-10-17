// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompletedMarkdown } from './CompletedMarkdown.js'
import { Markdown } from './Markdown.js'
import { STREAMED_ANSWER, streamedChunks } from './markdown-blocks.fixture.js'

/** happy-dom's emulated device: text lands as it arrives, without a reveal. */
const device = (
  window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } }
).happyDOM.settings.device

beforeEach(() => {
  device.prefersReducedMotion = 'reduce'
})

afterEach(() => {
  cleanup()
  device.prefersReducedMotion = 'no-preference'
})

const words = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim()

/** An item's own text, without the lists nested in it. */
function itemText(item: Element): string {
  let text = ''
  for (const node of item.childNodes) {
    if (node instanceof Element && (node.tagName === 'UL' || node.tagName === 'OL')) continue
    text += node.textContent
  }
  return words(text)
}

/**
 * The block structure a reply lays out with: block tags in order, lists with
 * their start, items and nesting. Inline markup and code block chrome are left
 * out; they do not move lines.
 */
function shape(root: Element): string[] {
  const blocks: string[] = []
  for (const child of root.children) {
    const tag = child.tagName.toLowerCase()
    const part = child.getAttribute('data-streamdown')
    if (part === 'code-block' || tag === 'pre') blocks.push('code')
    else if (part === 'table-wrapper' || tag === 'table') blocks.push('table')
    else if (tag === 'ul' || tag === 'ol') {
      const start =
        tag === 'ol' && child.getAttribute('start') ? `@${child.getAttribute('start')}` : ''
      const items = [...child.children].map((item) => {
        const nested = [...item.children].filter(
          (node) => node.tagName === 'UL' || node.tagName === 'OL',
        )
        const inner = nested.flatMap((list) => shape({ children: [list] } as unknown as Element))
        return `li "${itemText(item)}"${inner.length ? ` ${inner.join(' ')}` : ''}`
      })
      blocks.push(`${tag}${start} [${items.join(', ')}]`)
    } else if (tag === 'blockquote') {
      // The finished quote wraps its text in a paragraph whose margins sit
      // inside the quote; both lay out at the same height.
      blocks.push(`blockquote "${words(child.textContent)}"`)
    } else if (/^(?:p|h[1-6]|hr)$/.test(tag)) blocks.push(tag)
    else blocks.push(`?${tag}`)
  }
  return blocks
}

function liveShape(text: string, chunks?: readonly string[]): string[] {
  const view = render(<Markdown text={chunks ? chunks[0]! : text} streaming />)
  if (chunks) {
    let current = chunks[0]!
    chunks.slice(1).forEach((chunk, index) => {
      current += chunk
      view.rerender(
        <Markdown
          text={current}
          streaming
          liveUpdate={{ kind: 'append', text: chunk }}
          updateVersion={index + 1}
        />,
      )
    })
  }
  const root = view.container.querySelector('[data-streaming-markdown]')!
  const result = shape(root)
  cleanup()
  return result
}

function finishedShape(text: string): string[] {
  const view = render(<CompletedMarkdown text={text} />)
  const result = shape(view.container.querySelector('.md')!)
  cleanup()
  return result
}

const LISTS = [
  ['ordered', 'Steps:\n\n1. one\n2. two\n3. three\n\nDone.'],
  ['ordered from 3', 'Later:\n\n3. three\n4. four\n'],
  ['ordered with parentheses', '1) one\n2) two\n'],
  ['nested bullets', '- a\n  - a1\n  - a2\n- b\n    - b1\n- c\n'],
  ['bullets nested in an ordered list', '1. first\n   - detail\n   - more\n2. second\n'],
  ['ordered nested in bullets', '- outer\n  1. inner\n  2. inner two\n- outer two\n'],
  ['a changed bullet starts a new list', '- a\n- b\n* c\n+ d\n'],
  ['continuation lines', '- first line\n  continues here\n- second\nlazily continued\n'],
  ['a numbered line inside a paragraph', 'The year\n2024. was long\n'],
  ['rules', 'Above\n\n---\n\nBetween\n\n***\n\n___\n\nBelow'],
  ['a rule right after a list', '- a\n- b\n---\nAfter'],
  ['three levels', '- one\n  - two\n    - three\n  - two b\n- one b\n'],
  ['tasks in an ordered list', '1. [x] done\n2. [ ] next\n'],
] as const

describe('the live renderer lays a reply out like the finished one', () => {
  it.each(LISTS)('%s', (_name, text) => {
    expect(liveShape(text)).toEqual(finishedShape(text))
  })

  it('keeps a line of dashes under a paragraph as text, not a rule', () => {
    // The finished renderer makes it a heading underline, which the live
    // parser does not take back into the paragraph above.
    expect(liveShape('Title\n---\n\nText')).toEqual(['p', 'p'])
  })

  it('for the streamed answer, delta by delta', () => {
    expect(liveShape(STREAMED_ANSWER, streamedChunks(STREAMED_ANSWER))).toEqual(
      finishedShape(STREAMED_ANSWER),
    )
  })
})
