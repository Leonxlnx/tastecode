const LIVE_MARKDOWN_LEAF_LIMIT = 256
const LIVE_MARKDOWN_CARRY_LIMIT = 64
/** A line that starts with a pipe is held until it ends; past this it is prose. */
const LIVE_MARKDOWN_TABLE_LINE_LIMIT = 4 * 1024
/** A link is held until its closing parenthesis; past these it is literal text. */
const LIVE_MARKDOWN_LINK_LABEL_LIMIT = 512
const LIVE_MARKDOWN_LINK_URL_LIMIT = 2 * 1024
export const LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT = 256
export const LIVE_MARKDOWN_BULK_TEXT_MIN = 8 * 1024

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export type LiveMarkdownNode =
  | 'paragraph'
  | `heading-${HeadingLevel}`
  | 'blockquote'
  | 'list'
  | 'ordered-list'
  | 'list-item'
  | 'thematic-break'
  | 'strong'
  | 'emphasis'
  | 'inline-code'
  | 'code-block'
  | 'table'
  | 'table-head'
  | 'table-body'
  | 'table-row'
  | 'table-header-cell'
  | 'table-cell'
  | 'link'

export type LiveMarkdownAlign = 'left' | 'center' | 'right'

export type LiveMarkdownOperation =
  | { type: 'reset' }
  | {
      type: 'node.open'
      node: LiveMarkdownNode
      language?: string
      align?: LiveMarkdownAlign
      href?: string
      /** An ordered list's first number, when it is not 1. */
      start?: number
    }
  | { type: 'node.close'; node: LiveMarkdownNode }
  | { type: 'task'; checked: boolean }
  | { type: 'leaf.bulk'; text: string }
  | { type: 'leaf.open'; id: number }
  | { type: 'leaf.append'; id: number; text: string }
  | { type: 'leaf.close'; id: number }

export type LiveMarkdownUpdate = {
  kind: 'append' | 'replace'
  operations: LiveMarkdownOperation[]
  scannedCharacters: number
  sourceLength: number
  mutableLeafCharacters: number
  carryCharacters: number
  bufferedSourceChunks: number
}

type PendingLink = {
  stage: 'label' | 'after-label' | 'destination'
  label: string
  destination: string
  /** Open brackets inside the label, then open parentheses inside the destination. */
  depth: number
}

const HEADING_NODES = [
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
] as const
const TASK_MARKERS = ['[ ] ', '[x] ', '[X] '] as const
/** A list item's marker and the space after it: a bullet, or a number and its delimiter. */
const LIST_MARKER = /^(?:([-+*])|(\d{1,9})([.)])) $/
/** The start of a line that may still become a list marker. */
const LIST_MARKER_PENDING = /^(?:[-+*]|\d{1,9}[.)]?)$/
/** A line of three or more `-`, `*` or `_`: a thematic break, once the line ends. */
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/
const THEMATIC_BREAK_PENDING = /^(?:-+|\*+|_+)$/
/** A whole line that waited to become a list marker or a rule, but is text. */
const PENDING_TEXT_LINE = /^(?:\d{1,9}|--|\*\*|__?)$/
/** An empty list item, which cannot interrupt a paragraph: there it is text. */
const EMPTY_ITEM_IN_PARAGRAPH = /^(?:\d{1,9}[.)]|[+*])$/

/**
 * A list the parser is inside. Its current item stays open past the item's
 * line, so a nested list or a continuation line can still go into it.
 */
type OpenList = {
  /** The bullet character, or an ordered list's delimiter. */
  marker: string
  ordered: boolean
  /** The column of the marker. */
  indent: number
  /** The column the item's text starts at; a nested item is indented at least this far. */
  content: number
  itemOpen: boolean
}

function leadingSpaces(text: string): number {
  let count = 0
  while (text.charCodeAt(count) === 32) count += 1
  return count
}
const FLOW_SPECIAL_CHARACTER = /[\n`*_[]/g
const INLINE_CODE_SPECIAL_CHARACTER = /[\n`]/g
const TABLE_DELIMITER_CELL = /^(:?)-+(:?)$/
const LINK_DESTINATION =
  /^[ \t]*(?:<([^<>\n]*)>|([^\s<]*))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/

/** Characters a GFM delimiter row (`| --- | :-: |`) is made of, CRLF line end included. */
function isTableDelimiterCharacter(character: string): boolean {
  return (
    character === '|' ||
    character === '-' ||
    character === ':' ||
    character === ' ' ||
    character === '\t' ||
    character === '\r'
  )
}

/** Splits a GFM table row on unescaped pipes; an escaped pipe is cell text. */
function tableCells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (character === '\\' && text[index + 1] === '|') {
      cell += '|'
      index += 1
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += character
  }
  cells.push(cell.trim())
  return cells
}

/** The column alignments a delimiter row declares, or undefined when it is not one. */
function tableAlignment(
  line: string,
  columns: number,
): Array<LiveMarkdownAlign | undefined> | undefined {
  if (!line.includes('-')) return undefined
  const cells = tableCells(line)
  if (cells.length !== columns) return undefined
  const alignment: Array<LiveMarkdownAlign | undefined> = []
  for (const cell of cells) {
    const match = TABLE_DELIMITER_CELL.exec(cell)
    if (!match) return undefined
    const [, left, right] = match
    alignment.push(left && right ? 'center' : right ? 'right' : left ? 'left' : undefined)
  }
  return alignment
}

/** The source characters a pending link holds back: `[label](destination`. */
function heldLinkCharacters(link: PendingLink | undefined): number {
  if (!link) return 0
  return (
    1 +
    link.label.length +
    (link.stage === 'label' ? 0 : 1) +
    (link.stage === 'destination' ? 1 + link.destination.length : 0)
  )
}

/** Live links open only web and mail destinations; anything else stays its label. */
function safeLinkHref(destination: string): string | undefined {
  if (!/^(?:https?:\/\/|mailto:)/i.test(destination)) return undefined
  try {
    const { protocol } = new URL(destination)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
      ? destination
      : undefined
  } catch {
    return undefined
  }
}

export class LiveMarkdownParser {
  private sourceSegments: string[] = []
  private sourceChunks: string[] = []
  private sourceLength = 0
  private operations: LiveMarkdownOperation[] = []
  private block: LiveMarkdownNode | undefined
  private inline: LiveMarkdownNode[] = []
  /** Open lists, outermost first. */
  private lists: OpenList[] = []
  private mode: 'flow' | 'fence-info' | 'code' | 'table-line' = 'flow'
  private atLineStart = true
  private prefix = ''
  private pendingStar = false
  private leafId = 0
  private leafLength = 0
  private totalScanned = 0
  private completed = false
  /** The line being held while it might be, or is, a table row. */
  private tableLine = ''
  /** A complete first table line, waiting for the delimiter row that confirms it. */
  private tableHeader: string | undefined
  /**
   * A confirmed header, waiting for its first row. Laid out alone, the
   * columns fit the header's words, and the first row then reshaped every
   * one of them; together they start where the table goes on.
   */
  private tableHead:
    { characters: number; cells: string[]; align: Array<LiveMarkdownAlign | undefined> } | undefined
  private tableAlign: Array<LiveMarkdownAlign | undefined> = []
  private tableBodyOpen = false
  /** Set while a held line is replayed as prose, so it cannot start a table again. */
  private tablesSuppressed = false
  private link: PendingLink | undefined
  private inLinkLabel = false
  /** The characters after a list marker while they may still be `[ ] `. */
  private task: string | undefined
  private previous = ''

  append(delta: string): LiveMarkdownUpdate {
    if (this.completed) throw new Error('Cannot append after Markdown completion')
    this.operations = []
    if (delta) {
      this.sourceChunks.push(delta)
      if (this.sourceChunks.length >= LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT) {
        this.sourceSegments.push(this.sourceChunks.join(''))
        this.sourceChunks = []
      }
    }
    this.sourceLength += delta.length
    this.consumeText(delta)
    return this.update('append', delta.length)
  }

  /** Keeps large non-animated runs off the small-delta parser's monomorphic path. */
  appendLarge(delta: string): LiveMarkdownUpdate {
    if (delta.length < LIVE_MARKDOWN_BULK_TEXT_MIN) return this.append(delta)
    if (this.completed) throw new Error('Cannot append after Markdown completion')
    this.operations = []
    if (delta) {
      this.sourceChunks.push(delta)
      if (this.sourceChunks.length >= LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT) {
        this.sourceSegments.push(this.sourceChunks.join(''))
        this.sourceChunks = []
      }
    }
    this.sourceLength += delta.length
    this.consumeLargeText(delta)
    return this.update('append', delta.length)
  }

  replace(text: string): LiveMarkdownUpdate {
    if (this.completed) throw new Error('Cannot replace after Markdown completion')
    this.resetState()
    this.operations = [{ type: 'reset' }]
    if (text) this.sourceSegments = [text]
    this.sourceLength = text.length
    this.consumeText(text)
    return this.update('replace', text.length)
  }

  /** See appendLarge: normal token frames must not pay for bulk-run dispatch. */
  replaceLarge(text: string): LiveMarkdownUpdate {
    if (text.length < LIVE_MARKDOWN_BULK_TEXT_MIN) return this.replace(text)
    if (this.completed) throw new Error('Cannot replace after Markdown completion')
    this.resetState()
    this.operations = [{ type: 'reset' }]
    if (text) this.sourceSegments = [text]
    this.sourceLength = text.length
    this.consumeLargeText(text)
    return this.update('replace', text.length)
  }

  complete() {
    this.completed = true
    if (this.sourceChunks.length > 0) {
      this.sourceSegments.push(this.sourceChunks.join(''))
      this.sourceChunks = []
    }
    const source =
      this.sourceSegments.length === 1 ? this.sourceSegments[0]! : this.sourceSegments.join('')
    this.sourceSegments = source ? [source] : []
    return {
      source,
      sourceLength: this.sourceLength,
      totalScannedCharacters: this.totalScanned,
    }
  }

  private update(kind: LiveMarkdownUpdate['kind'], scannedCharacters: number): LiveMarkdownUpdate {
    this.totalScanned += scannedCharacters
    return {
      kind,
      operations: this.operations,
      scannedCharacters,
      sourceLength: this.sourceLength,
      mutableLeafCharacters: this.leafLength,
      carryCharacters:
        this.prefix.length +
        Number(this.pendingStar) +
        this.tableLine.length +
        (this.tableHeader?.length ?? 0) +
        (this.tableHead?.characters ?? 0) +
        heldLinkCharacters(this.link) +
        (this.task?.length ?? 0),
      bufferedSourceChunks: this.sourceChunks.length,
    }
  }

  private resetState(): void {
    this.sourceSegments = []
    this.sourceChunks = []
    this.sourceLength = 0
    this.block = undefined
    this.inline = []
    this.lists = []
    this.mode = 'flow'
    this.atLineStart = true
    this.prefix = ''
    this.pendingStar = false
    this.leafId = 0
    this.leafLength = 0
    this.totalScanned = 0
    this.completed = false
    this.tableLine = ''
    this.tableHeader = undefined
    this.tableHead = undefined
    this.tableAlign = []
    this.tableBodyOpen = false
    this.tablesSuppressed = false
    this.link = undefined
    this.inLinkLabel = false
    this.task = undefined
    this.previous = ''
  }

  /** Plain runs skip per-character dispatch; held links and task markers do not. */
  private canWriteRun(): boolean {
    return (
      this.mode === 'flow' &&
      !this.atLineStart &&
      !this.pendingStar &&
      this.link === undefined &&
      this.task === undefined
    )
  }

  private consumeText(text: string): void {
    if (text.length < 8) {
      for (let index = 0; index < text.length; index += 1) this.consume(text[index]!)
      return
    }

    let index = 0
    while (index < text.length) {
      if (this.mode === 'code' && !this.atLineStart) {
        const end = text.indexOf('\n', index)
        if (end < 0) {
          this.write(index === 0 ? text : text.slice(index))
          return
        }
        if (end > index) this.write(text.slice(index, end))
        this.consume('\n')
        index = end + 1
        continue
      }

      if (this.mode === 'table-line' && this.tableHeader === undefined) {
        const end = text.indexOf('\n', index)
        const stop = end < 0 ? text.length : end
        if (stop > index) {
          this.holdTableLine(text.slice(index, stop))
          index = stop
          continue
        }
      }

      if (this.canWriteRun()) {
        const inlineCode = this.inline.at(-1) === 'inline-code'
        let end = index
        while (end < text.length) {
          const code = text.charCodeAt(end)
          if (
            code === 10 ||
            code === 96 ||
            (!inlineCode && (code === 42 || code === 95 || code === 91))
          )
            break
          end += 1
        }
        if (end > index) {
          this.write(index === 0 && end === text.length ? text : text.slice(index, end))
          this.previous = text[end - 1]!
          index = end
          continue
        }
      }

      this.consume(text[index]!)
      index += 1
    }
  }

  private consumeLargeText(text: string): void {
    let index = 0
    while (index < text.length) {
      if (this.mode === 'code' && !this.atLineStart) {
        const end = text.indexOf('\n', index)
        if (end < 0) {
          this.writeLarge(index === 0 ? text : text.slice(index))
          return
        }
        if (end > index) this.writeLarge(text.slice(index, end))
        this.consume('\n')
        index = end + 1
        continue
      }

      if (this.mode === 'table-line' && this.tableHeader === undefined) {
        const end = text.indexOf('\n', index)
        const stop = end < 0 ? text.length : end
        if (stop > index) {
          this.holdTableLine(text.slice(index, stop))
          index = stop
          continue
        }
      }

      if (this.canWriteRun()) {
        const special =
          this.inline.at(-1) === 'inline-code'
            ? INLINE_CODE_SPECIAL_CHARACTER
            : FLOW_SPECIAL_CHARACTER
        special.lastIndex = index
        const end = special.exec(text)?.index ?? text.length
        if (end > index) {
          this.writeLarge(index === 0 && end === text.length ? text : text.slice(index, end))
          this.previous = text[end - 1]!
          index = end
          continue
        }
      }

      this.consume(text[index]!)
      index += 1
    }
  }

  private consume(character: string): void {
    if (this.mode === 'fence-info') {
      if (character === '\n') {
        this.openCode(this.prefix.slice(3).trim())
        this.prefix = ''
        this.mode = 'code'
        this.atLineStart = true
      } else if (this.prefix.length < LIVE_MARKDOWN_CARRY_LIMIT) this.prefix += character
      return
    }
    if (this.mode === 'code') {
      this.consumeCode(character)
      return
    }
    if (this.mode === 'table-line') {
      this.consumeTableLine(character)
      return
    }
    if (this.atLineStart) {
      this.consumePrefix(character)
      return
    }
    if (character !== '\n') {
      this.consumeInline(character)
      return
    }
    this.settleInline()
    this.flushPendingStar()
    if (this.block?.startsWith('heading-')) this.closeBlock()
    else if (this.block === 'list-item') this.closeBlock(true)
    else this.write('\n')
    this.atLineStart = true
  }

  private consumePrefix(character: string): void {
    if (this.prefix === '') {
      // A table ends at the first line that is not one of its rows.
      if (this.block === 'table' && character !== '|') this.closeBlock()
      // A header whose next line is no row is a table of its own.
      if (this.tableHead && character !== '|') {
        this.openTable()
        this.closeBlock()
      }
      if (this.tableHeader !== undefined) {
        if (character !== '\n' && isTableDelimiterCharacter(character)) {
          this.mode = 'table-line'
          this.tableLine = character
          return
        }
        this.rejectTableHeader()
      }
      if (character === '|' && !this.tablesSuppressed) {
        this.mode = 'table-line'
        this.tableLine = character
        return
      }
    }
    if (character === '\n') {
      // A line that ends while it could still have become a list marker or a
      // rule (`42`, `--`) is text, as in the finished renderer. Its markers
      // stand alone on their line, so they open no emphasis: literal text.
      const marker = this.prefix.slice(leadingSpaces(this.prefix))
      if (
        PENDING_TEXT_LINE.test(marker) ||
        (this.block === 'paragraph' && EMPTY_ITEM_IN_PARAGRAPH.test(marker))
      ) {
        const buffered = this.prefix
        this.finishPrefix()
        const line = this.continueListItem() ? marker : buffered
        this.write(line)
        this.previous = line.at(-1) ?? this.previous
        this.consume(character)
        return
      }
      this.flushPendingStar()
      const rule = this.block === undefined && THEMATIC_BREAK.test(this.prefix)
      this.closeBlock()
      if (rule) {
        this.operations.push({ type: 'node.open', node: 'thematic-break' })
        this.closeNode('thematic-break')
      }
      this.prefix = ''
      return
    }
    if (this.prefix.length === LIVE_MARKDOWN_CARRY_LIMIT) {
      this.ensureParagraph()
      const buffered = this.prefix
      this.prefix = ''
      this.atLineStart = false
      this.consumeInline(buffered + character)
      return
    }
    this.prefix += character
    if (this.prefix === '```') {
      this.mode = 'fence-info'
      return
    }
    if (/^`{1,2}$/.test(this.prefix) || /^#{1,6}$/.test(this.prefix)) return
    if (/^#{1,6} $/.test(this.prefix)) {
      const heading = HEADING_NODES[this.prefix.trim().length - 1]
      if (heading) this.openBlock(heading)
      this.finishPrefix()
      return
    }
    if (this.prefix === '> ') {
      this.openBlock('blockquote')
      this.finishPrefix()
      return
    }
    if (this.prefix === '>') return
    // List items may be indented: nested under an open item, or by up to
    // three spaces at the top. Only spaces so far: wait for what follows.
    const indent = leadingSpaces(this.prefix)
    const listable = indent <= 3 || this.lists.length > 0
    const marker = this.prefix.slice(indent)
    if (marker === '' && listable) return
    const item = listable ? LIST_MARKER.exec(marker) : null
    // A numbered line interrupts a paragraph only when it starts a list at 1.
    if (item && (item[1] || this.block !== 'paragraph' || item[2] === '1')) {
      this.openListItem(
        indent,
        marker.length - 1,
        item[1] ?? item[3]!,
        item[1] ? undefined : Number(item[2]),
      )
      this.finishPrefix()
      this.task = ''
      return
    }
    if (listable && LIST_MARKER_PENDING.test(marker)) return
    // A line of dashes, stars or underscores is a rule once it ends, unless
    // it underlines a paragraph.
    if (indent === 0 && this.block === undefined && THEMATIC_BREAK_PENDING.test(marker)) return
    const buffered = this.prefix
    this.finishPrefix()
    if (this.continueListItem()) {
      this.consumeInline(buffered.slice(indent))
      return
    }
    this.ensureParagraph()
    this.consumeInline(buffered)
  }

  /**
   * A line that starts with a pipe stays hidden until it ends. The first such
   * line becomes a table header only once the delimiter row below it is
   * complete; until then neither line is shown, so a table never appears as
   * raw pipes. The header waits for its first row (see tableHead); each later
   * row renders whole when its line ends.
   */
  private consumeTableLine(character: string): void {
    if (character !== '\n') {
      if (this.tableHeader !== undefined && !isTableDelimiterCharacter(character)) {
        const held = this.tableLine
        this.tableLine = ''
        this.mode = 'flow'
        this.rejectTableHeader()
        this.consumeText(held + character)
        return
      }
      this.holdTableLine(character)
      return
    }

    const line = this.tableLine
    this.tableLine = ''
    this.mode = 'flow'
    this.atLineStart = true
    if (this.block === 'table') {
      this.emitTableRow(tableCells(line))
      return
    }
    if (this.tableHead) {
      this.openTable()
      this.emitTableRow(tableCells(line))
      return
    }
    if (this.tableHeader === undefined) {
      this.tableHeader = line
      return
    }
    const header = tableCells(this.tableHeader)
    const alignment = tableAlignment(line, header.length)
    if (!alignment) {
      this.rejectTableHeader()
      this.consumeText(`${line}\n`)
      return
    }
    this.tableHead = {
      characters: this.tableHeader.length + line.length + 2,
      cells: header,
      align: alignment,
    }
    this.tableHeader = undefined
    this.closeBlock()
  }

  private openTable(): void {
    const head = this.tableHead
    if (!head) return
    this.tableHead = undefined
    this.operations.push({ type: 'node.open', node: 'table' })
    this.block = 'table'
    this.tableAlign = head.align
    this.tableBodyOpen = false
    this.operations.push({ type: 'node.open', node: 'table-head' })
    this.emitTableCells('table-header-cell', head.cells)
    this.closeNode('table-head')
  }

  private holdTableLine(text: string): void {
    this.tableLine += text
    if (this.tableLine.length <= LIVE_MARKDOWN_TABLE_LINE_LIMIT) return
    // Too long to be a row worth waiting for: show it as prose from here on.
    const held = this.tableLine
    this.tableLine = ''
    this.mode = 'flow'
    if (this.tableHead) this.openTable()
    if (this.block === 'table') this.closeBlock()
    this.rejectTableHeader()
    this.replayAsProse(held)
  }

  /** The held first line was prose after all: it continues as a paragraph line. */
  private rejectTableHeader(): void {
    const header = this.tableHeader
    if (header === undefined) return
    this.tableHeader = undefined
    this.replayAsProse(`${header}\n`)
  }

  private replayAsProse(text: string): void {
    const suppressed = this.tablesSuppressed
    this.tablesSuppressed = true
    this.consumeText(text)
    this.tablesSuppressed = suppressed
  }

  private emitTableRow(cells: string[]): void {
    if (!this.tableBodyOpen) {
      this.operations.push({ type: 'node.open', node: 'table-body' })
      this.tableBodyOpen = true
    }
    this.emitTableCells('table-cell', cells)
  }

  private emitTableCells(node: 'table-header-cell' | 'table-cell', cells: string[]): void {
    this.operations.push({ type: 'node.open', node: 'table-row' })
    for (let column = 0; column < this.tableAlign.length; column += 1) {
      const align = this.tableAlign[column]
      this.operations.push({ type: 'node.open', node, ...(align ? { align } : {}) })
      this.previous = ''
      const text = cells[column]
      if (text) this.consumeInline(text)
      this.settleInline()
      this.flushPendingStar()
      while (this.inline.length) this.closeNode(this.inline.pop()!)
      this.closeNode(node)
    }
    this.closeNode('table-row')
  }

  private consumeCode(character: string): void {
    if (!this.atLineStart) {
      this.write(character)
      if (character === '\n') this.atLineStart = true
      return
    }
    if (this.prefix.length === LIVE_MARKDOWN_CARRY_LIMIT) {
      const buffered = this.prefix
      this.prefix = ''
      this.atLineStart = false
      this.write(buffered + character)
      return
    }
    this.prefix += character
    if (character === '\n' && /^```[ \t]*\n$/.test(this.prefix)) {
      this.prefix = ''
      this.closeBlock()
      this.mode = 'flow'
      return
    }
    if (/^`{1,3}$/.test(this.prefix) || /^```[ \t]*$/.test(this.prefix)) return
    const buffered = this.prefix
    this.prefix = ''
    this.atLineStart = false
    this.write(buffered)
    if (character === '\n') this.atLineStart = true
  }

  private consumeInline(value: string): void {
    for (const character of value) {
      if (this.task !== undefined && this.consumeTaskMarker(character)) continue
      if (this.link) {
        this.consumeLink(character)
        continue
      }
      if (this.inline.at(-1) === 'inline-code' && character !== '`') {
        this.write(character)
        this.previous = character
        continue
      }
      if (character === '*') {
        if (this.pendingStar) {
          this.pendingStar = false
          this.toggleInline('strong', '**')
        } else this.pendingStar = true
        this.previous = character
        continue
      }
      if (this.pendingStar) {
        this.pendingStar = false
        this.toggleInline('emphasis', '*')
      }
      if (character === '[' && this.previous !== '!' && !this.inLinkLabel) {
        this.link = { stage: 'label', label: '', destination: '', depth: 0 }
      } else if (character === '_') this.toggleInline('emphasis', '_')
      else if (character === '`') this.toggleInline('inline-code', '`')
      else this.write(character)
      this.previous = character
    }
  }

  /** True when the character belongs to a possible `[ ] ` marker or replayed it. */
  private consumeTaskMarker(character: string): boolean {
    const marker = this.task + character
    if (TASK_MARKERS.some((candidate) => candidate.startsWith(marker))) {
      if (marker.length === 4) {
        this.task = undefined
        this.operations.push({ type: 'task', checked: marker[1] !== ' ' })
      } else this.task = marker
      return true
    }
    this.task = undefined
    if (marker.length === 1) return false
    this.consumeInline(marker)
    return true
  }

  private consumeLink(character: string): void {
    const link = this.link!
    if (link.stage === 'label') {
      if (character === ']' && link.depth === 0) {
        link.stage = 'after-label'
        return
      }
      if (character === '[') link.depth += 1
      else if (character === ']') link.depth -= 1
      link.label += character
      if (link.label.length > LIVE_MARKDOWN_LINK_LABEL_LIMIT) this.abandonLink()
      return
    }
    if (link.stage === 'after-label') {
      if (character === '(') {
        link.stage = 'destination'
        return
      }
      this.abandonLink()
      this.consumeInline(character)
      return
    }
    if (character === ')' && link.depth === 0) {
      this.resolveLink()
      return
    }
    if (character === '(') link.depth += 1
    else if (character === ')') link.depth -= 1
    link.destination += character
    if (link.destination.length > LIVE_MARKDOWN_LINK_URL_LIMIT) this.abandonLink()
  }

  /** Not a link after all: its held source is ordinary text. */
  private abandonLink(closing = ''): void {
    const link = this.link
    if (!link) return
    this.link = undefined
    this.write('[')
    this.previous = '['
    let held = link.label
    if (link.stage !== 'label') held += ']'
    if (link.stage === 'destination') held += `(${link.destination}${closing}`
    this.consumeInline(held)
  }

  private resolveLink(): void {
    const link = this.link!
    const match = LINK_DESTINATION.exec(link.destination)
    if (!match) {
      this.abandonLink(')')
      return
    }
    this.link = undefined
    const href = safeLinkHref(match[1] ?? match[2] ?? '')
    const depth = this.inline.length
    if (href) {
      this.ensureParagraph()
      this.sealLeaf()
      this.operations.push({ type: 'node.open', node: 'link', href })
      this.inline.push('link')
    }
    this.inLinkLabel = true
    this.previous = ''
    this.consumeInline(link.label)
    this.inLinkLabel = false
    if (href) {
      this.flushPendingStar()
      while (this.inline.length > depth) this.closeNode(this.inline.pop()!)
    }
    this.previous = ')'
  }

  /** Releases a held link or task marker as text before its line or block ends. */
  private settleInline(): void {
    while (this.task !== undefined || this.link) {
      if (this.task !== undefined) {
        const marker = this.task
        this.task = undefined
        this.consumeInline(marker)
      } else this.abandonLink()
    }
  }

  private ensureParagraph(): void {
    if (!this.block) this.openBlock('paragraph')
  }

  private openBlock(node: LiveMarkdownNode, language?: string): void {
    if (this.block || this.lists.length > 0) this.closeBlock()
    this.operations.push({
      type: 'node.open',
      node,
      ...(language ? { language } : {}),
    })
    this.block = node
  }

  /**
   * A list item whose marker (`width` characters before its space) is
   * `indent` spaces in: an item of an open list at that depth, the first
   * item of a list nested in the open item it is indented into, or the first
   * item of a new list. `start` is an ordered item's number. A different
   * bullet or delimiter starts a new list.
   */
  private openListItem(
    indent: number,
    width: number,
    marker: string,
    start: number | undefined,
  ): void {
    if (this.block) this.closeBlock(true)
    while (this.lists.length > 0 && indent < this.lists.at(-1)!.indent) {
      this.closeLists(this.lists.length - 1)
    }
    const ordered = start !== undefined
    let list = this.lists.at(-1)
    if (list && indent < list.content) {
      if (list.itemOpen) this.closeNode('list-item')
      list.itemOpen = false
      if (list.marker !== marker || list.ordered !== ordered) {
        this.closeLists(this.lists.length - 1)
        list = undefined
      }
    } else list = undefined
    if (!list) {
      this.operations.push({
        type: 'node.open',
        node: ordered ? 'ordered-list' : 'list',
        ...(ordered && start !== 1 ? { start } : {}),
      })
      list = { marker, ordered, indent, content: indent + width + 1, itemOpen: false }
      this.lists.push(list)
    }
    this.operations.push({ type: 'node.open', node: 'list-item' })
    // Nesting is measured from the open item's own marker.
    list.indent = indent
    list.content = indent + width + 1
    list.itemOpen = true
    this.block = 'list-item'
  }

  /** A text line right after a list item's line continues that item's text. */
  private continueListItem(): boolean {
    if (this.block || !this.lists.at(-1)?.itemOpen) return false
    this.block = 'list-item'
    this.write('\n')
    return true
  }

  /** Closes the open lists deeper than `depth`, with their open items. */
  private closeLists(depth: number): void {
    while (this.lists.length > depth) {
      const list = this.lists.pop()!
      if (list.itemOpen) this.closeNode('list-item')
      this.closeNode(list.ordered ? 'ordered-list' : 'list')
    }
  }

  private openCode(language: string): void {
    if (this.block || this.lists.length > 0) this.closeBlock()
    this.operations.push({
      type: 'node.open',
      node: 'code-block',
      ...(language ? { language } : {}),
    })
    this.block = 'code-block'
  }

  /**
   * Ends the current block. A list item's line ends without closing the
   * item, which stays open for a nested list or a continuation line; the
   * lists end too unless `keepList` is set.
   */
  private closeBlock(keepList = false): void {
    this.settleInline()
    this.flushPendingStar()
    while (this.inline.length) this.closeNode(this.inline.pop()!)
    this.sealLeaf()
    if (this.block === 'table' && this.tableBodyOpen) this.closeNode('table-body')
    this.tableBodyOpen = false
    if (this.block && this.block !== 'list-item') this.closeNode(this.block)
    this.block = undefined
    if (!keepList) this.closeLists(0)
  }

  private toggleInline(node: 'strong' | 'emphasis' | 'inline-code', marker: string): void {
    this.ensureParagraph()
    if (this.inline.at(-1) === node) this.closeNode(this.inline.pop()!)
    else if (this.inline.length < LIVE_MARKDOWN_CARRY_LIMIT) {
      this.sealLeaf()
      this.operations.push({ type: 'node.open', node })
      this.inline.push(node)
    } else this.write(marker)
  }

  private closeNode(node: LiveMarkdownNode): void {
    this.sealLeaf()
    this.operations.push({ type: 'node.close', node })
  }

  private write(text: string): void {
    if (!text) return
    this.ensureParagraph()
    let remaining = text
    while (remaining) {
      if (this.leafLength === 0) this.operations.push({ type: 'leaf.open', id: this.leafId })
      const next = remaining.slice(0, LIVE_MARKDOWN_LEAF_LIMIT - this.leafLength)
      const last = this.operations.at(-1)
      if (last?.type === 'leaf.append' && last.id === this.leafId) last.text += next
      else this.operations.push({ type: 'leaf.append', id: this.leafId, text: next })
      this.leafLength += next.length
      remaining = remaining.slice(next.length)
      if (this.leafLength === LIVE_MARKDOWN_LEAF_LIMIT) this.sealLeaf()
    }
  }

  private writeLarge(text: string): void {
    if (text.length < LIVE_MARKDOWN_BULK_TEXT_MIN) {
      this.write(text)
      return
    }
    this.ensureParagraph()
    let offset = 0
    while (offset < text.length) {
      const remaining = text.length - offset
      if (this.leafLength === 0 && remaining >= LIVE_MARKDOWN_BULK_TEXT_MIN) {
        const bulkLength = remaining - (remaining % LIVE_MARKDOWN_LEAF_LIMIT)
        this.operations.push({
          type: 'leaf.bulk',
          text:
            offset === 0 && bulkLength === text.length
              ? text
              : text.slice(offset, offset + bulkLength),
        })
        this.leafId += bulkLength / LIVE_MARKDOWN_LEAF_LIMIT
        offset += bulkLength
        continue
      }
      if (this.leafLength === 0) this.operations.push({ type: 'leaf.open', id: this.leafId })
      const nextLength = Math.min(remaining, LIVE_MARKDOWN_LEAF_LIMIT - this.leafLength)
      const next =
        offset === 0 && nextLength === text.length ? text : text.slice(offset, offset + nextLength)
      const last = this.operations.at(-1)
      if (last?.type === 'leaf.append' && last.id === this.leafId) last.text += next
      else this.operations.push({ type: 'leaf.append', id: this.leafId, text: next })
      this.leafLength += next.length
      offset += next.length
      if (this.leafLength === LIVE_MARKDOWN_LEAF_LIMIT) this.sealLeaf()
    }
  }

  private sealLeaf(): void {
    if (this.leafLength === 0) return
    this.operations.push({ type: 'leaf.close', id: this.leafId++ })
    this.leafLength = 0
  }

  private flushPendingStar(): void {
    if (!this.pendingStar) return
    this.pendingStar = false
    this.write('*')
  }

  private finishPrefix(): void {
    this.prefix = ''
    this.atLineStart = false
  }
}
