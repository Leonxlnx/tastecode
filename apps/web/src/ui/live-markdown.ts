import { propertiesWhen } from '../properties-when.js'
import { z } from 'zod'
export const LIVE_MARKDOWN_LEAF_LIMIT = 256
export const LIVE_MARKDOWN_CARRY_LIMIT = 64

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
}

const HeadingNodeSchema = z.enum([
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
])

export class LiveMarkdownParser {
  private source: string[] = []
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
    this.source.push(delta)
    this.sourceLength += delta.length
    for (let index = 0; index < delta.length; index += 1) this.consume(delta[index]!)
    return this.update('append', delta.length)
  }

  replace(text: string): LiveMarkdownUpdate {
    if (this.completed) throw new Error('Cannot replace after Markdown completion')
    this.resetState()
    this.operations = [{ type: 'reset' }]
    this.source = [text]
    this.sourceLength = text.length
    for (let index = 0; index < text.length; index += 1) this.consume(text[index]!)
    return this.update('replace', text.length)
  }

  complete() {
    this.completed = true
    return {
      source: this.source.join(''),
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
    }
  }

  private resetState(): void {
    this.source = []
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
      this.openBlock(HeadingNodeSchema.parse(`heading-${this.prefix.trim().length}`))
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
      ...propertiesWhen(language, (language) => ({ language })),
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
      ...propertiesWhen(language, (language) => ({ language })),
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
