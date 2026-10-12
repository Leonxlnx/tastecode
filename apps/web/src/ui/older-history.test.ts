import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import { prependedRowCount } from './older-history.js'

const rows = (...ids: string[]): Item[] =>
  ids.map((id, index) => ({
    id,
    turnId: `turn-${id}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    createdAt: index,
  }))

describe('prependedRowCount', () => {
  it('counts rows inserted above the previous first row', () => {
    expect(prependedRowCount(rows('c', 'd'), rows('a', 'b', 'c', 'd'))).toBe(2)
    // A live row appended in the same update does not hide the prepend.
    expect(prependedRowCount(rows('c', 'd'), rows('a', 'b', 'c', 'd', 'e'))).toBe(2)
  })

  it('ignores appends, replacements and first loads', () => {
    expect(prependedRowCount(rows('a'), rows('a', 'b'))).toBe(0)
    expect(prependedRowCount(rows('a', 'b'), rows('x', 'y', 'z'))).toBe(0)
    expect(prependedRowCount([], rows('a', 'b'))).toBe(0)
    expect(prependedRowCount(rows('a', 'b'), rows('b'))).toBe(0)
  })
})
