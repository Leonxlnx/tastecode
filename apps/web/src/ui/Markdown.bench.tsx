// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { bench, describe } from 'vitest'
import { CompletedMarkdown } from './CompletedMarkdown.js'
import { Markdown, needsRichMarkdown } from './Markdown.js'

const CLASSIFY_OPTIONS = { time: 1_200, warmupTime: 300 }
const RENDER_OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const LARGE_BURST_OPTIONS = { time: 1_200, warmupTime: 300 }
const PLAIN_TEXT = 'x'.repeat(64 * 1024)
const LARGE_BURST = 'x'.repeat(1024 * 1024)
const RICH_MARKDOWN_CHARACTERS = '`*_#[]<>|~\\'
const RICH_MARKDOWN_STRUCTURE =
  /https?:\/\/|(?:^|\n)\s*(?:[-+>]|\d+[.)])\s|(?:^|\n)\s*-{3,}\s*(?:\n|$)|\n\s*\n/
const PLAIN_PARAGRAPHS = Array.from(
  { length: 20 },
  (_, index) =>
    `Result ${index} ${'plain response text '.repeat(12)}\n\nNext step ${index} ${'more plain response text '.repeat(8)}`,
)

function scanRichMarkdownCharacters(text: string): boolean {
  for (const character of text) {
    if (RICH_MARKDOWN_CHARACTERS.includes(character)) return true
  }
  return RICH_MARKDOWN_STRUCTURE.test(text)
}

function assertPlain(result: boolean): void {
  if (result) throw new Error('plain text was classified as rich Markdown')
}

describe('completed Markdown classification', () => {
  bench(
    'walks a 64 KiB plain reply one JavaScript character at a time',
    () => assertPlain(scanRichMarkdownCharacters(PLAIN_TEXT)),
    CLASSIFY_OPTIONS,
  )

  bench(
    'searches a 64 KiB plain reply with native regular expressions',
    () => assertPlain(needsRichMarkdown(PLAIN_TEXT)),
    CLASSIFY_OPTIONS,
  )
})

describe('completed multi-paragraph prose', () => {
  bench(
    'renders 20 visible replies through the full Markdown engine',
    () => {
      const view = render(
        <>
          {PLAIN_PARAGRAPHS.map((text) => (
            <CompletedMarkdown key={text} text={text} />
          ))}
        </>,
      )
      view.unmount()
      cleanup()
    },
    RENDER_OPTIONS,
  )

  bench(
    'renders 20 visible replies through plain paragraphs',
    () => {
      const view = render(
        <>
          {PLAIN_PARAGRAPHS.map((text) => (
            <Markdown key={text} text={text} />
          ))}
        </>,
      )
      view.unmount()
      cleanup()
    },
    RENDER_OPTIONS,
  )
})

describe('very large live provider burst', () => {
  bench(
    'renders and compacts 1 MiB of plain text',
    () => {
      const view = render(<Markdown text="" streaming />)
      view.rerender(
        <Markdown
          text={LARGE_BURST}
          streaming
          liveUpdate={{ kind: 'append', text: LARGE_BURST }}
          updateVersion={1}
        />,
      )
      if (view.container.textContent?.length !== LARGE_BURST.length) {
        throw new Error('text was truncated')
      }
      view.unmount()
      cleanup()
    },
    LARGE_BURST_OPTIONS,
  )
})
