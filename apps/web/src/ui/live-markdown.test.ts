import { describe, expect, it } from 'vitest'
import {
  LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT,
  LiveMarkdownParser,
  type LiveMarkdownOperation,
} from './live-markdown.js'

function nodes(operations: LiveMarkdownOperation[]) {
  return operations.flatMap((operation) => (operation.type === 'node.open' ? [operation.node] : []))
}

function normalizeLeafAppends(operations: LiveMarkdownOperation[]): LiveMarkdownOperation[] {
  const normalized: LiveMarkdownOperation[] = []
  for (const operation of operations) {
    const previous = normalized.at(-1)
    if (
      operation.type === 'leaf.append' &&
      previous?.type === 'leaf.append' &&
      previous.id === operation.id
    ) {
      previous.text += operation.text
    } else normalized.push({ ...operation })
  }
  return normalized
}

describe('LiveMarkdownParser', () => {
  it('keeps canonical source exact across append, replacement, and completion', () => {
    const parser = new LiveMarkdownParser()
    parser.append('old')
    const replacement = parser.replace('new **answer**')
    const appended = parser.append('\nwith code')

    expect(replacement.operations[0]).toEqual({ type: 'reset' })
    expect(appended.scannedCharacters).toBe('\nwith code'.length)
    expect(parser.complete()).toMatchObject({ source: 'new **answer**\nwith code' })
    expect(parser.complete()).toMatchObject({ source: 'new **answer**\nwith code' })
    expect(() => parser.append(' late')).toThrow(/completion/)
    expect(() => parser.replace('late')).toThrow(/completion/)
  })

  it('styles common Markdown when delimiters split across chunks', () => {
    const parser = new LiveMarkdownParser()
    const chunks = [
      '##',
      ' Title\n\nA *',
      '*bold*',
      '* and `co',
      'de`.\n\n- i',
      'tem\n# Next\n\n```ts\nco',
      'de\n``',
      '`\n',
    ]
    const operations = chunks.flatMap((chunk) => parser.append(chunk).operations)

    expect(nodes(operations)).toEqual(
      expect.arrayContaining([
        'heading-2',
        'strong',
        'inline-code',
        'list',
        'list-item',
        'code-block',
      ]),
    )
    expect(parser.complete().source).toBe(chunks.join(''))
    const sequence = JSON.stringify(operations)
    expect(sequence).toMatch(
      /"type":"node.close","node":"list"}.*"type":"node.open","node":"heading-1"/,
    )
  })

  it('keeps batched plain runs equal to character-at-a-time parsing', () => {
    const source = `${'# Title\n\nA '.padEnd(1_024, 'x')} **bold** and \`code_value\`.\n\n- item\n> quote\n\n\`\`\`ts\n${'const value = 1\n'.repeat(100)}\`\`\`\n`
    const batched = new LiveMarkdownParser()
    const incremental = new LiveMarkdownParser()

    const batchedOperations = batched.append(source).operations
    const incrementalOperations = Array.from(source).flatMap(
      (character) => incremental.append(character).operations,
    )

    expect(normalizeLeafAppends(batchedOperations)).toEqual(
      normalizeLeafAppends(incrementalOperations),
    )
    expect(batched.complete()).toEqual(incremental.complete())
  })

  it('bounds every mutable leaf and line-prefix carry', () => {
    const parser = new LiveMarkdownParser()
    const update = parser.append(`paragraph ${'x'.repeat(2_000)}${'_**'.repeat(10_000)}`)
    const leaves = update.operations.filter(
      (operation): operation is Extract<LiveMarkdownOperation, { type: 'leaf.append' }> =>
        operation.type === 'leaf.append',
    )

    expect(Math.max(...leaves.map((leaf) => leaf.text.length))).toBeLessThanOrEqual(256)
    expect(update.carryCharacters).toBeLessThanOrEqual(64)
    parser.append('\n')
    expect(parser.append('\n').operations.length).toBeLessThanOrEqual(66)
  })

  it('coalesces large sealed plain-text runs without growing mutable leaves', () => {
    const source = 'x'.repeat(1024 * 1024)
    const parser = new LiveMarkdownParser()
    const update = parser.appendLarge(source)

    expect(update.operations.length).toBeLessThan(10)
    expect(update.operations).toContainEqual(expect.objectContaining({ type: 'leaf.bulk' }))
    expect(update.mutableLeafCharacters).toBe(0)
    expect(parser.append('y').mutableLeafCharacters).toBe(1)
    expect(parser.complete().source).toBe(`${source}y`)
  })

  it('bounds source chunk bookkeeping during a very long stream', () => {
    const parser = new LiveMarkdownParser()
    let update = parser.append('')
    for (let index = 0; index < 10_000; index += 1) update = parser.append('x')

    expect(update.bufferedSourceChunks).toBeLessThan(LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT)
    expect(parser.complete().source).toBe('x'.repeat(10_000))
  })

  it('joins compact source segments once at completion', () => {
    const parser = new LiveMarkdownParser()
    const chunks = Array.from(
      { length: LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT * 3 + 17 },
      (_, index) => `${index % 10}`,
    )
    for (const chunk of chunks) parser.append(chunk)

    expect(parser.complete().source).toBe(chunks.join(''))
    expect(parser.complete().source).toBe(chunks.join(''))
  })

  it('keeps streamed HTML and links inert', () => {
    const source = '<img src=x onerror=alert(1)> [click](javascript:alert(1))'
    const parser = new LiveMarkdownParser()
    expect(nodes(parser.append(source).operations)).toEqual(['paragraph'])
    expect(parser.complete().source).toBe(source)
  })

  it.each([4_096, 65_536])('makes delta work independent of a %i-character prefix', (size) => {
    const parser = new LiveMarkdownParser()
    parser.replace('x'.repeat(size))
    const update = parser.append(' next')
    expect(update).toMatchObject({ scannedCharacters: 5, sourceLength: size + 5 })
    expect(update.operations.length).toBeLessThanOrEqual(5)
  })
})
