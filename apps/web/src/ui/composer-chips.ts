import {
  browserChipLabel,
  browserComment,
  browserCommentBlock,
  type BrowserComment,
} from './browser-comments.js'

/**
 * Picked skills, MCP servers and commands sit inline in the composer as chips.
 *
 * The textarea stays the editor, so caret, selection, undo, paste and IME keep
 * working as the platform made them. A chip is therefore text the textarea can
 * hold: an em space that reserves room for the icon, a word joiner that keeps
 * the icon on the name's line, an invisible mark that says what the chip is,
 * the name, and a closing word joiner. The marks are default-ignorable, so they
 * take no room; an overlay draws the icon and the coloured name over the same
 * characters.
 *
 * What the provider receives never changes: `composerWireText` turns each chip
 * back into the `$skill`, `@server` or `/command` token it stands for.
 */

export type ComposerChipKind = 'skill' | 'mcp' | 'command' | 'browser'
export type ComposerChipMarker = '$' | '@' | '/' | ''

export type ComposerChip = {
  kind: ComposerChipKind
  marker: ComposerChipMarker
  /** The name without its marker, as the chip shows it. */
  name: string
  /** What the provider receives: the marker followed by the name. */
  token: string
  /** Where the chip's characters start and end in the draft. */
  start: number
  end: number
  /** A browser comment: its id, kept as invisible marks after the chip's own mark. */
  commentId?: string
}

export type ComposerChipSegment =
  { type: 'text'; text: string } | ({ type: 'chip'; mark: string } & ComposerChip)

const ICON_ROOM = ' '
const GLUE = '⁠'
const MARKS = {
  '⁡': { marker: '$', kind: 'skill' },
  '⁢': { marker: '@', kind: 'mcp' },
  '⁣': { marker: '/', kind: 'command' },
  // A skill the provider runs as a slash command, such as Claude Code's.
  '⁤': { marker: '/', kind: 'skill' },
} as const satisfies Record<string, { marker: ComposerChipMarker; kind: ComposerChipKind }>
type Mark = keyof typeof MARKS

// A browser comment's name is the user's words, so unlike a resource it may hold spaces.
const BROWSER_MARK = '⁥'
const CHIP = / ⁠(?:([⁡-⁤])([^\s⁠-⁥]+)|⁥([⁡-⁤]{64})([^\n⁠-⁥]+))⁠/g
// A chip's leftovers after an edit cut through it: an opener or a lone mark.
const FRAGMENT = / ⁠|[⁠-⁥]/g

/** The characters the draft holds for a picked resource. */
export function composerChipText(token: string, kind: ComposerChipKind): string {
  const marker = token[0] as ComposerChipMarker
  const name = token.slice(1)
  const mark = (Object.keys(MARKS) as Mark[]).find(
    (candidate) => MARKS[candidate].marker === marker && MARKS[candidate].kind === kind,
  )
  // A combination no provider uses stays the plain token it would be sent as.
  if (!mark || !/^[^\s⁠-⁤]+$/.test(name)) return token
  return `${ICON_ROOM}${GLUE}${mark}${name}${GLUE}`
}

/** The characters the draft holds for a comment pinned in the browser. */
export function browserCommentChipText(comment: Pick<BrowserComment, 'id' | 'comment'>): string {
  return `${ICON_ROOM}${GLUE}${BROWSER_MARK}${comment.id}${browserChipLabel(comment.comment)}${GLUE}`
}

/** Cheap enough for every keystroke: a draft without a word joiner has no chips. */
export function hasComposerChips(text: string): boolean {
  return text.includes(GLUE)
}

export function composerChips(text: string): ComposerChip[] {
  if (!hasComposerChips(text)) return []
  const chips: ComposerChip[] = []
  for (const match of text.matchAll(CHIP)) {
    const start = match.index
    const end = start + match[0].length
    const commentId = match[3]
    if (commentId) {
      const name = match[4]!
      const comment = browserComment(commentId)
      // Details lost with the browser's storage: the user's words still go out.
      const token = comment ? browserCommentBlock(comment) : name
      chips.push({ kind: 'browser', marker: '', name, token, start, end, commentId })
      continue
    }
    const { marker, kind } = MARKS[match[1] as Mark]
    const name = match[2]!
    chips.push({ kind, marker, name, token: `${marker}${name}`, start, end })
  }
  return chips
}

export function composerChipSegments(text: string): ComposerChipSegment[] {
  const segments: ComposerChipSegment[] = []
  let position = 0
  for (const chip of composerChips(text)) {
    if (chip.start > position)
      segments.push({ type: 'text', text: text.slice(position, chip.start) })
    // Everything between the opener and the name, which for a comment includes its id.
    const mark = text.slice(chip.start + 2, chip.end - 1 - chip.name.length)
    segments.push({ type: 'chip', mark, ...chip })
    position = chip.end
  }
  if (position < text.length) segments.push({ type: 'text', text: text.slice(position) })
  return segments
}

/**
 * The prompt as the provider receives it: every chip back to its token. A chip
 * drawn right against a word or another chip is still its own token, so a
 * space keeps the two apart where they would otherwise run together
 * (`$cookx`, `use$cook`, `$cook$docs` name no skill).
 */
export function composerWireText(text: string, options: { images?: boolean } = {}): string {
  if (!hasComposerChips(text)) return text
  let wire = ''
  let afterToken = false
  let afterBlock = false
  for (const segment of composerChipSegments(text)) {
    if (segment.type === 'chip' && segment.kind === 'browser') {
      const comment = browserComment(segment.commentId!)
      const block = comment ? browserCommentBlock(comment, options.images !== false) : segment.name
      wire = `${wire.trimEnd()}${wire.trim() ? '\n\n' : ''}${block}\n\n`
      afterToken = false
      afterBlock = true
      continue
    }
    if (segment.type === 'chip') {
      if (wire !== '' && !opensToken(wire.at(-1)!)) wire += ' '
      wire += segment.token
      afterToken = true
      afterBlock = false
      continue
    }
    const plain = segment.text.replace(FRAGMENT, '')
    if (plain === '') continue
    if (afterToken && !closesToken(plain)) wire += ' '
    wire += afterBlock ? plain.trimStart() : plain
    afterToken = false
    afterBlock = false
  }
  return afterBlock ? wire.trimEnd() : wire
}

/** Screenshots of the comments this draft still holds: a deleted chip takes its image along. */
export function composerBrowserImages(text: string): string[] {
  return composerChips(text).flatMap((chip) => {
    const image = chip.commentId ? browserComment(chip.commentId)?.image : undefined
    return image ? [image] : []
  })
}

/** Whitespace, or an opening bracket or quote, may sit right before a token. */
function opensToken(character: string): boolean {
  return /[\s([{"']/.test(character)
}

/**
 * Whitespace or closing punctuation may follow a token directly, as long as
 * no name character comes after the dots, colons and dashes it starts with:
 * `$cook.`, `$cook...` and `$cook.)` end at the name, while `$cook.md` would
 * read as a longer name. This is where a sent prompt's token ends when it is
 * read back (message-chips.ts), so a prompt put back into the composer goes
 * out again exactly as it was sent.
 */
function closesToken(text: string): boolean {
  return /^[\s.,;:!?)\]}"']/.test(text) && !/^[\w.:-]*\w/.test(text)
}

/** The chip the position falls strictly inside, where no caret belongs. */
export function composerChipAround(text: string, index: number): ComposerChip | undefined {
  return composerChips(text).find((chip) => chip.start < index && index < chip.end)
}

/** The chip that ends exactly at the position (Backspace) or starts there (Delete). */
export function composerChipTouching(
  text: string,
  index: number,
  side: 'before' | 'after',
): ComposerChip | undefined {
  return composerChips(text).find((chip) =>
    side === 'before' ? chip.end === index : chip.start === index,
  )
}

/**
 * The chip that only spaces separate from the position, before it (a word
 * deletion backward) or after it (forward). The editor's own word deletion
 * there would take the name and leave the chip's invisible marks behind.
 */
export function composerChipPastSpaces(
  text: string,
  index: number,
  side: 'before' | 'after',
): ComposerChip | undefined {
  let position = index
  if (side === 'before') while (position > 0 && /[ \t]/.test(text[position - 1]!)) position -= 1
  else while (position < text.length && /[ \t]/.test(text[position]!)) position += 1
  return composerChipTouching(text, position, side)
}

/**
 * Whether a slash typed at `index` can still lead the prompt. Providers read a
 * command only at the start, so only whitespace and `$skill` or `@server`
 * chips may come before it: the composer puts a picked command in front of
 * those. Walks back from the slash and stops at the first other character, so
 * it costs a step per leading character, never the whole draft.
 */
export function composerSlashCanLead(text: string, index: number): boolean {
  let position = index
  while (position > 0) {
    const character = text[position - 1]!
    if (character === GLUE) {
      // A chip ends here: step over its name to the mark that says what it is.
      let mark = position - 2
      while (mark >= 0 && !/[\s⁠-⁤]/.test(text[mark]!)) mark -= 1
      const chip = mark < position - 2 ? markedChip(text[mark]) : undefined
      if (!chip || chip.marker === '/') return false
      if (text[mark - 1] !== GLUE || text[mark - 2] !== ICON_ROOM) return false
      position = mark - 2
      continue
    }
    if (!/\s/.test(character)) return false
    position -= 1
  }
  return true
}

function markedChip(
  character: string | undefined,
): { marker: ComposerChipMarker; kind: ComposerChipKind } | undefined {
  return character !== undefined && Object.hasOwn(MARKS, character)
    ? MARKS[character as Mark]
    : undefined
}

/** Widens a selection that cuts through a chip so it takes the whole chip. */
export function composerSelectionOverChips(
  text: string,
  start: number,
  end: number,
): [number, number] {
  let from = start
  let to = end
  for (const chip of composerChips(text)) {
    if (chip.start < from && from < chip.end) from = chip.start
    if (chip.start < to && to < chip.end) to = chip.end
  }
  return [from, to]
}

/**
 * Removes what is left of a chip that an edit cut through, so no invisible
 * mark lingers in the draft. Returns the text and where the caret moves.
 */
export function repairComposerChips(
  text: string,
  caret: number,
): { text: string; caret: number } | undefined {
  const fragments = composerChipFragments(text)
  if (fragments.length === 0) return undefined
  let repaired = ''
  let nextCaret = caret
  let position = 0
  for (const [start, end] of fragments) {
    repaired += text.slice(position, start)
    if (start < caret) nextCaret -= Math.min(end, caret) - start
    position = end
  }
  return { text: repaired + text.slice(position), caret: nextCaret }
}

/**
 * Where an edit that cut through a chip left its opener or a lone mark, in
 * order. Leftovers that touch are one range, so they go in one edit.
 */
export function composerChipFragments(text: string): Array<[start: number, end: number]> {
  if (!/[⁠-⁤]/.test(text)) return []
  const fragments: Array<[number, number]> = []
  let position = 0
  const collect = (until: number) => {
    for (const match of text.slice(position, until).matchAll(FRAGMENT)) {
      const start = position + match.index
      const end = start + match[0].length
      const last = fragments.at(-1)
      if (last && last[1] === start) last[1] = end
      else fragments.push([start, end])
    }
  }
  for (const chip of composerChips(text)) {
    collect(chip.start)
    position = chip.end
  }
  collect(text.length)
  return fragments
}

/** The tokens of the chips in a draft, so the menu can leave them out. */
export function composerChipTokens(text: string): ReadonlySet<string> {
  return new Set(composerChips(text).map((chip) => chip.token))
}

/**
 * The draft without its skill and MCP server chips, each with the space typed
 * after it. Skills and servers belong to the provider and project they were
 * picked for; command chips stay, as typed commands always did, and a browser
 * comment stays because it belongs to a page, and any provider can act on it.
 */
export function composerTextWithoutPicks(text: string): string {
  let kept = ''
  let position = 0
  for (const chip of composerChips(text)) {
    if (chip.kind === 'command' || chip.kind === 'browser') continue
    kept += text.slice(position, chip.start)
    position = text[chip.end] === ' ' ? chip.end + 1 : chip.end
  }
  return position === 0 ? text : kept + text.slice(position)
}

/**
 * The draft as the chip overlay needs it. It only changes while the draft has
 * chips, so ordinary typing never wakes the overlay.
 */
export type ComposerChipTextStore = {
  get: () => string
  set: (text: string) => void
  subscribe: (listener: () => void) => () => void
}

export function createComposerChipTextStore(): ComposerChipTextStore {
  let shown = ''
  const listeners = new Set<() => void>()
  return {
    get: () => shown,
    set(text) {
      const next = hasComposerChips(text) ? text : ''
      if (next === shown) return
      shown = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
