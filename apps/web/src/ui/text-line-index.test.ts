import { describe, expect, it } from 'vitest'
import { indexedTextLine, indexTextLines } from './text-line-index.js'

function indexedLines(text: string): string[] {
  const index = indexTextLines(text)
  return Array.from(index, (_, line) => indexedTextLine(text, index, line))
}

describe('text line index', () => {
  it.each(['', 'one', 'one\n', 'one\ntwo', 'one\r\ntwo\r\n', '🙂\nżółw'])(
    'matches String.split for %j',
    (text) => {
      expect(indexedLines(text)).toEqual(text.split('\n'))
    },
  )

  it('grows past the initial line capacity without losing offsets', () => {
    const text = 'line\n'.repeat(2_000)
    const index = indexTextLines(text)

    expect(index).toHaveLength(2_001)
    expect(indexedTextLine(text, index, 0)).toBe('line')
    expect(indexedTextLine(text, index, 1_999)).toBe('line')
    expect(indexedTextLine(text, index, 2_000)).toBe('')
    expect(indexedTextLine(text, index, 2_001)).toBe('')
  })
})
