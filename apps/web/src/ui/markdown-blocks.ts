import { parseMarkdownIntoBlocks } from 'streamdown'

/**
 * Each block is parsed on its own, so `[text][ref]` would never see a `[ref]: url`
 * in another block. Like Streamdown's own footnote handling, such a text stays one
 * block; everything else keeps per-block rendering and the large-fence fast path.
 */
const REFERENCE_DEFINITION = /^[ \t]{0,3}(?:>[ \t]*)*\[[^\]\r\n]+\]:/m
/** Streamdown keeps a text that has footnote references or definitions as one block. */
const FOOTNOTE = /\[\^[\w-]{1,200}\]/
const LINE_BREAK = /\r\n?/g
const BLANK = /^\s*$/
const ENDS_WITH_BLANK_LINE = /\n[ \t]*\n$/
const LIST_START = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/

export type BlockSplitter = (markdown: string) => string[]

/** The blocks Streamdown renders for a completed text (see REFERENCE_DEFINITION). */
export function completedBlocks(markdown: string): string[] {
  return REFERENCE_DEFINITION.test(markdown) ? [markdown] : parseMarkdownIntoBlocks(markdown)
}

/**
 * The first block that more text can still change. The last block that is not
 * blank space can grow (a list item, a table row, a paragraph that becomes a
 * heading), and a blank line after it still belongs to it. Two kinds of block
 * above it stay open with it:
 * - a block right above it, with no blank line between them: a table, heading
 *   or fence that interrupted a paragraph turns back into lines of that
 *   paragraph when its next character makes it invalid;
 * - a list above blank lines: the open block can become its next item.
 * Everything before the first open block is final.
 */
function firstOpenBlock(blocks: readonly string[]): number {
  let open = blocks.length - 1
  while (open > 0 && BLANK.test(blocks[open]!)) open -= 1
  for (;;) {
    while (
      open > 0 &&
      !BLANK.test(blocks[open - 1]!) &&
      !ENDS_WITH_BLANK_LINE.test(blocks[open - 1]!)
    )
      open -= 1
    let above = open - 1
    while (above > 0 && BLANK.test(blocks[above]!)) above -= 1
    if (above < 0 || above === open - 1 || !LIST_START.test(blocks[above]!)) break
    open = above
  }
  return Math.max(open, 0)
}

/**
 * Splits text into the same blocks as completedBlocks, remembering the last
 * text. When the next text extends it, only its tail is lexed again, from the
 * first block that the new text can change. A whole-text split runs one marked
 * lexer pass over the reply (about 20 ms for 5 KB in a production build); this
 * one costs what the tail costs.
 *
 * Blocks are marked's top-level token sources, which add up to the text with
 * its line breaks normalized. Where they do not, the next call splits it all.
 */
export function createBlockSplitter(split: BlockSplitter = completedBlocks): BlockSplitter {
  let last: { text: string; blocks: string[]; starts: number[] } | undefined
  return (markdown) => {
    if (REFERENCE_DEFINITION.test(markdown) || FOOTNOTE.test(markdown)) {
      last = undefined
      return split(markdown)
    }
    // marked normalizes line breaks before it lexes; offsets count them that way.
    const text = markdown.includes('\r') ? markdown.replace(LINE_BREAK, '\n') : markdown
    if (last?.text === text) return last.blocks
    const keep = last && text.startsWith(last.text) ? firstOpenBlock(last.blocks) : 0
    const from = keep > 0 ? last!.starts[keep]! : 0
    const blocks = keep > 0 ? last!.blocks.slice(0, keep) : []
    const starts = keep > 0 ? last!.starts.slice(0, keep) : []
    let offset = from
    for (const block of split(from > 0 ? text.slice(from) : text)) {
      blocks.push(block)
      starts.push(offset)
      offset += block.length
    }
    last = offset === text.length ? { text, blocks, starts } : undefined
    return blocks
  }
}

/** How many leading blocks are final while the text may still grow. */
export function closedBlockCount(blocks: readonly string[]): number {
  return firstOpenBlock(blocks)
}
