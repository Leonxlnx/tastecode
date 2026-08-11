import { describe, expect, it } from 'vitest'
import { LiveMarkdownParser, type LiveMarkdownOperation } from './live-markdown.js'

function nodes(operations: LiveMarkdownOperation[]) {
  return operations.flatMap((operation) => (operation.type === 'node.open' ? [operation.node] : []))
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
    expect(() => parser.append(' late')).toThrow(/completion/)
  })

  it('styles common Markdown when delimiters split across chunks', () => {
    const parser = new LiveMarkdownParser()
    const chunks = [
      '##',
      ' Title\n\nA *',
      '*bold*',
      '* and `co',
      'de`.\n\n- i',
      'tem\n\n```ts\nco',
      'de\n``',
      '`\n',
    ]
    const operations = chunks.flatMap((chunk) => parser.append(chunk).operations)

    expect(nodes(operations)).toEqual(
      expect.arrayContaining([
        'heading-2',
        'paragraph',
        'strong',
        'inline-code',
        'list',
        'list-item',
        'code-block',
      ]),
    )
    expect(parser.complete().source).toBe(chunks.join(''))
  })

  it('bounds every mutable leaf and line-prefix carry', () => {
    const parser = new LiveMarkdownParser()
    const update = parser.append(`paragraph ${'x'.repeat(2_000)}`)
    const leaves = update.operations.filter(
      (operation): operation is Extract<LiveMarkdownOperation, { type: 'leaf.append' }> =>
        operation.type === 'leaf.append',
    )

    expect(Math.max(...leaves.map((leaf) => leaf.text.length))).toBeLessThanOrEqual(256)
    expect(update.mutableLeafCharacters).toBeLessThanOrEqual(256)
    expect(update.carryCharacters).toBeLessThanOrEqual(64)
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
