import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import { findTurns, neighbourTurn } from './turns.js'

const item = (id: string, turnId: string): Item => ({
  id,
  turnId,
  type: 'message',
  status: 'completed',
  createdAt: 0,
})

describe('turn boundaries', () => {
  it('groups consecutive items of the same turn', () => {
    const turns = findTurns([
      item('a', 't1'),
      item('b', 't1'),
      item('c', 't2'),
      item('d', 't2'),
      item('e', 't2'),
    ])
    expect(turns.map((t) => [t.index, t.count])).toEqual([
      [0, 2],
      [2, 3],
    ])
  })

  it('gives an un-sent local echo its own boundary', () => {
    // It has no turn id yet but still visually starts a turn; folding it into
    // the previous one would make "previous turn" skip it.
    const turns = findTurns([item('a', 't1'), item('local', ''), item('b', 't2')])
    expect(turns).toHaveLength(3)
  })

  it('walks to the neighbouring turn', () => {
    const turns = findTurns([item('a', 't1'), item('b', 't1'), item('c', 't2'), item('d', 't3')])
    expect(neighbourTurn(turns, 0, 'next')).toBe(2)
    expect(neighbourTurn(turns, 2, 'next')).toBe(3)
    expect(neighbourTurn(turns, 3, 'next')).toBeUndefined()
    expect(neighbourTurn(turns, 3, 'prev')).toBe(2)
    expect(neighbourTurn(turns, 0, 'prev')).toBeUndefined()
  })

  it('returns to the start of the turn you are inside before skipping past it', () => {
    const turns = findTurns([item('a', 't1'), item('b', 't2'), item('c', 't2'), item('d', 't2')])
    // Standing on the third item of t2, "previous" is the start of t2.
    expect(neighbourTurn(turns, 3, 'prev')).toBe(1)
  })
})
