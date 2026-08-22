export const LIVE_MARKDOWN_LEAF_LIMIT = 256
export const LIVE_MARKDOWN_CARRY_LIMIT = 64
export const LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT = 256
export const LIVE_MARKDOWN_BULK_TEXT_MIN = 8 * 1024

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export type LiveMarkdownNode =
  | 'paragraph'
  | `heading-${HeadingLevel}`
  | 'blockquote'
  | 'list'
  | 'list-item'
  | 'strong'
  | 'emphasis'
  | 'inline-code'
  | 'code-block'

export type LiveMarkdownOperation =
  | { type: 'reset' }
  | { type: 'node.open'; node: LiveMarkdownNode; language?: string }
  | { type: 'node.close'; node: LiveMarkdownNode }
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

const HEADING_NODES = [
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
] as const
const FLOW_SPECIAL_CHARACTER = /[\n`*_]/g
const INLINE_CODE_SPECIAL_CHARACTER = /[\n`]/g

export class LiveMarkdownParser {
  private sourceSegments: string[] = []
  private sourceChunks: string[] = []
  private sourceLength = 0
  private operations: LiveMarkdownOperation[] = []
  private block: LiveMarkdownNode | undefined
  private inline: LiveMarkdownNode[] = []
  private listOpen = false
  private mode: 'flow' | 'fence-info' | 'code' = 'flow'
  private atLineStart = true
  private prefix = ''
  private pendingStar = false
  private leafId = 0
  private leafLength = 0
  private totalScanned = 0
  private completed = false

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
      carryCharacters: this.prefix.length + Number(this.pendingStar),
      bufferedSourceChunks: this.sourceChunks.length,
    }
  }

  private resetState(): void {
    this.sourceSegments = []
    this.sourceChunks = []
    this.sourceLength = 0
    this.block = undefined
    this.inline = []
    this.listOpen = false
    this.mode = 'flow'
    this.atLineStart = true
    this.prefix = ''
    this.pendingStar = false
    this.leafId = 0
    this.leafLength = 0
    this.totalScanned = 0
    this.completed = false
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

      if (this.mode === 'flow' && !this.atLineStart && !this.pendingStar) {
        const inlineCode = this.inline.at(-1) === 'inline-code'
        let end = index
        while (end < text.length) {
          const code = text.charCodeAt(end)
          if (code === 10 || code === 96 || (!inlineCode && (code === 42 || code === 95))) break
          end += 1
        }
        if (end > index) {
          this.write(index === 0 && end === text.length ? text : text.slice(index, end))
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

      if (this.mode === 'flow' && !this.atLineStart && !this.pendingStar) {
        const special =
          this.inline.at(-1) === 'inline-code'
            ? INLINE_CODE_SPECIAL_CHARACTER
            : FLOW_SPECIAL_CHARACTER
        special.lastIndex = index
        const end = special.exec(text)?.index ?? text.length
        if (end > index) {
          this.writeLarge(index === 0 && end === text.length ? text : text.slice(index, end))
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
    if (this.atLineStart) {
      this.consumePrefix(character)
      return
    }
    if (character !== '\n') {
      this.consumeInline(character)
      return
    }
    this.flushPendingStar()
    if (this.block?.startsWith('heading-')) this.closeBlock()
    else if (this.block === 'list-item') this.closeBlock(true)
    else this.write('\n')
    this.atLineStart = true
  }

  private consumePrefix(character: string): void {
    if (character === '\n') {
      this.flushPendingStar()
      this.closeBlock()
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
    if (this.prefix === '- ' || this.prefix === '* ') {
      this.openListItem()
      this.finishPrefix()
      return
    }
    if (this.prefix === '> ') {
      this.openBlock('blockquote')
      this.finishPrefix()
      return
    }
    if (this.prefix === '-' || this.prefix === '*' || this.prefix === '>') return
    this.ensureParagraph()
    const buffered = this.prefix
    this.finishPrefix()
    this.consumeInline(buffered)
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
      if (this.inline.at(-1) === 'inline-code' && character !== '`') {
        this.write(character)
        continue
      }
      if (character === '*') {
        if (this.pendingStar) {
          this.pendingStar = false
          this.toggleInline('strong', '**')
        } else this.pendingStar = true
        continue
      }
      if (this.pendingStar) {
        this.pendingStar = false
        this.toggleInline('emphasis', '*')
      }
      if (character === '_') this.toggleInline('emphasis', '_')
      else if (character === '`') this.toggleInline('inline-code', '`')
      else this.write(character)
    }
  }

  private ensureParagraph(): void {
    if (!this.block) this.openBlock('paragraph')
  }

  private openBlock(node: LiveMarkdownNode, language?: string): void {
    if (this.block || this.listOpen) this.closeBlock()
    this.operations.push({
      type: 'node.open',
      node,
      ...(language ? { language } : {}),
    })
    this.block = node
  }

  private openListItem(): void {
    if (this.block) this.closeBlock()
    if (!this.listOpen) {
      this.operations.push({ type: 'node.open', node: 'list' })
      this.listOpen = true
    }
    this.operations.push({ type: 'node.open', node: 'list-item' })
    this.block = 'list-item'
  }

  private openCode(language: string): void {
    if (this.block || this.listOpen) this.closeBlock()
    this.operations.push({
      type: 'node.open',
      node: 'code-block',
      ...(language ? { language } : {}),
    })
    this.block = 'code-block'
  }

  private closeBlock(keepList = false): void {
    this.flushPendingStar()
    while (this.inline.length) this.closeNode(this.inline.pop()!)
    this.sealLeaf()
    if (this.block) this.closeNode(this.block)
    this.block = undefined
    if (this.listOpen && !keepList) {
      this.closeNode('list')
      this.listOpen = false
    }
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
