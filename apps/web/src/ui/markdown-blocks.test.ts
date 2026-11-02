import { parseMarkdownIntoBlocks } from 'streamdown'
import { describe, expect, it, vi } from 'vitest'
import {
  closedBlockCount,
  completedBlocks,
  createBlockSplitter,
  type BlockSplitter,
} from './markdown-blocks.js'
import { STREAMED_ANSWER, streamedChunks } from './markdown-blocks.fixture.js'

/** Constructs where a later line can change an earlier one, or where marked merges tokens. */
const TRICKY = [
  // Loose lists, continuation paragraphs, nested and ordered items.
  '- one\n\n  still one\n- two\n\n\n- three\n\nAfter the list.\n\n1. first\n2) second\n\n   more of second\n',
  // Setext headings turn the paragraph above into a heading.
  'A paragraph line\nanother line\n===\n\nNext\n---\n\nEnd',
  // A table interrupting a paragraph, growing rows, then a paragraph.
  'Intro text\n| a | b |\n| --- | :-: |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter the table.',
  // Indented code after a paragraph and after one or two blank lines.
  'Para\n\n    code after one blank\n\nPara\n\n\n    code after two blanks\n',
  // Fences, an unclosed one at the end.
  '```ts\nconst a = 1\n```\n\n```\nplain\n```\n\n```js\nlet open = true\n',
  // Quotes with lazy continuation and nested lists.
  '> quoted\nlazy line\n> - item\n>   more\n\nOut.',
  // Raw HTML blocks that span blank lines, and math.
  '<div>\n\nInside html\n\n</div>\n\n$$\na + b\n\n= c\n$$\n\nText with $$x$$ inline.',
  // Thematic breaks, headings without a blank line, hard breaks.
  '# H1\nText  \nbreak\n***\n## H2\n- a\n***\nend',
  // CRLF line endings.
  '## Title\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n```\r\n\r\nDone.\r\n',
  // Lines that interrupt a paragraph, then stop being a block: they fold back into it.
  'Para\n#\n#x heading-like text\nPara\n***\n***x\nPara\n```\n```x`\nPara\n<div\n<divx\nPara\n1. a\n2. b\nPara\n> q\n',
  // Blocks directly after one another, without blank lines.
  '# H\n```\ncode\n```\nPara right after\n| a |\n| - |\n| 1 |\nPara after table\n- item\nPara after list',
]

/** Feeds `chunks` one after another, as a stream does, and checks every step. */
function replay(chunks: readonly string[], check: (text: string, blocks: string[]) => void) {
  const split = createBlockSplitter()
  let text = ''
  for (const chunk of chunks) {
    text += chunk
    check(text, split(text))
  }
}

describe('createBlockSplitter', () => {
  it('matches a whole-text split after every delta of the streamed answer', () => {
    replay(streamedChunks(STREAMED_ANSWER), (text, blocks) => {
      expect(blocks).toEqual(parseMarkdownIntoBlocks(text))
    })
  })

  it('matches a whole-text split at every character of the tricky texts', () => {
    for (const source of TRICKY) {
      replay([...source], (text, blocks) => {
        expect(blocks, JSON.stringify(text)).toEqual(parseMarkdownIntoBlocks(text))
      })
    }
  })

  it('matches a whole-text split for texts built from random pieces', () => {
    const pieces = TRICKY.flatMap((source) => source.split(/(?<=\n)/))
    let seed = 11
    const next = (max: number) => {
      seed = (seed * 48271) % 2147483647
      return seed % max
    }
    for (let round = 0; round < 40; round += 1) {
      let source = ''
      for (let index = 0; index < 24; index += 1) source += pieces[next(pieces.length)]
      const chunks: string[] = []
      for (let index = 0; index < source.length;) {
        const size = 1 + next(9)
        chunks.push(source.slice(index, index + size))
        index += size
      }
      replay(chunks, (text, blocks) => {
        expect(blocks, JSON.stringify(text)).toEqual(parseMarkdownIntoBlocks(text))
      })
    }
  })

  it('lexes only the tail when the text grows', () => {
    const lexed: number[] = []
    const counting: BlockSplitter = (markdown) => {
      lexed.push(markdown.length)
      return completedBlocks(markdown)
    }
    const split = createBlockSplitter(counting)
    const head = STREAMED_ANSWER.slice(0, STREAMED_ANSWER.indexOf('## Test results'))
    split(head)
    split(`${head}## Test results\n\n| Suite |`)
    expect(lexed[0]).toBe(head.length)
    // From the last block that is not blank space: the migration's paragraph.
    expect(lexed[1]).toBeLessThan(400)
  })

  it('returns the same blocks for the same text without lexing again', () => {
    const counting = vi.fn(completedBlocks)
    const split = createBlockSplitter(counting)
    const first = split(STREAMED_ANSWER)
    expect(split(STREAMED_ANSWER)).toBe(first)
    expect(counting).toHaveBeenCalledTimes(1)
  })

  it('splits again from the start when the text is not a continuation', () => {
    const split = createBlockSplitter()
    split('# One\n\nfirst paragraph')
    expect(split('# Two\n\nsecond')).toEqual(parseMarkdownIntoBlocks('# Two\n\nsecond'))
    expect(split('# Two')).toEqual(parseMarkdownIntoBlocks('# Two'))
  })

  it('keeps texts with reference definitions or footnotes whole', () => {
    const split = createBlockSplitter()
    const reference = 'See [the guide][guide].\n\n[guide]: https://example.com\n'
    expect(split(reference)).toEqual([reference])
    const footnote = 'A claim[^1].\n\n[^1]: The source.\n'
    expect(split(footnote)).toEqual([footnote])
    expect(split(`${footnote}\nMore.`)).toEqual([`${footnote}\nMore.`])
  })
})

describe('closedBlockCount', () => {
  it('leaves out the last block and the blank space after it', () => {
    expect(closedBlockCount([])).toBe(0)
    expect(closedBlockCount(['Para'])).toBe(0)
    expect(closedBlockCount(['# H\n', '\n', 'Para'])).toBe(2)
    expect(closedBlockCount(['# H\n', '\n', 'Para\n', '\n\n'])).toBe(2)
  })

  it('never counts a block as closed that the rest of the stream changes', () => {
    const finalBlocks = parseMarkdownIntoBlocks(STREAMED_ANSWER)
    let checked = 0
    replay(streamedChunks(STREAMED_ANSWER), (_text, blocks) => {
      const closed = blocks.slice(0, closedBlockCount(blocks))
      expect(finalBlocks.slice(0, closed.length)).toEqual(closed)
      checked += closed.length
    })
    expect(checked).toBeGreaterThan(0)
  })
})
