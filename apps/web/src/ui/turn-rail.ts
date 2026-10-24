import type { TurnMark, TurnPresentation } from './turns.js'

/** A turn the user started with a prompt: one tick on the turn rail. */
export type TurnRailEntry = {
  turnId: string
  /** Flat-list index of the turn's first row, where a jump lands. */
  index: number
  /** The prompt on one line, cut to what a one-line label can show. */
  prompt: string
}

/** More than one line of the preview card can hold; the card ellipsizes the rest. */
const PROMPT_LABEL_CHARS = 240
/** Three lines of the preview card, with room to spare for short words. */
const REPLY_PREVIEW_CHARS = 320
/** Markdown read for a preview; a long answer's tail never reaches the card. */
const REPLY_SOURCE_CHARS = 2400

/**
 * The turns the rail marks. Returns `previous` when no tick would change: the
 * projection is rebuilt for every new tool row of a running turn, and the
 * rail should not redraw a long chat's ticks for one of those.
 */
export function turnRailEntries(
  turns: readonly TurnMark[],
  presentations: ReadonlyMap<string, TurnPresentation>,
  previous: readonly TurnRailEntry[] = [],
): readonly TurnRailEntry[] {
  const entries: TurnRailEntry[] = []
  for (const turn of turns) {
    const prompt = presentations.get(turn.turnId)?.prompt
    if (!prompt) continue
    entries.push({
      turnId: turn.turnId,
      index: turn.index,
      prompt: oneLine(prompt.text ?? '', PROMPT_LABEL_CHARS) || 'Attachment',
    })
  }
  const unchanged =
    entries.length === previous.length &&
    entries.every((entry, at) => {
      const before = previous[at]!
      return (
        before.turnId === entry.turnId &&
        before.index === entry.index &&
        before.prompt === entry.prompt
      )
    })
  return unchanged ? previous : entries
}

/** The rail position of the turn a row belongs to: the last one starting at or before it. */
export function turnAt(entries: readonly TurnRailEntry[], itemIndex: number): number {
  let low = 0
  let high = entries.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (entries[middle]!.index <= itemIndex) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/** The row at a runway offset: the last one starting at or above it. */
export function rowAtOffset(rows: ArrayLike<{ start: number }>, offset: number): number {
  let low = 0
  let high = rows.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (rows[middle]!.start <= offset) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/**
 * The opening of an answer as plain prose for the preview card: the card shows
 * three lines of it, so markup would only spend them on symbols.
 */
export function replyPreview(markdown: string): string {
  const text = markdown
    .slice(0, REPLY_SOURCE_CHARS)
    // A code block reads as noise in three lines of prose; an unclosed one runs to the end.
    .replace(/(^|\n) {0,3}(```|~~~)[^\n]*\n[\s\S]*?(\n {0,3}\2[^\n]*(?=\n|$)|$)/g, '$1')
    // So does a table, cell by cell between pipes.
    .replace(/^ {0,3}\|.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^ {0,3}([-*_])( *\1){2,} *$/gm, '')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/`+([^`\n]+)`+/g, '$1')
  return oneLine(text, REPLY_PREVIEW_CHARS)
}

function oneLine(text: string, limit: number): string {
  const line = text
    .slice(0, limit * 4)
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > limit ? `${line.slice(0, limit).trimEnd()}…` : line
}
