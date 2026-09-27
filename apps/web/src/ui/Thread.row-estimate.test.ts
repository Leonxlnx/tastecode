// @vitest-environment happy-dom
import type { Item } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { estimateThreadRowSize, overscanVisibleRows } from './Thread.js'
import { projectThreadItems } from './turns.js'

function item(id: string, fields: Partial<Item>): Item {
  return { id, turnId: 'turn', status: 'completed', createdAt: 1, ...fields } as Item
}

describe('estimateThreadRowSize', () => {
  it('estimates the hidden rows of a work disclosure as nothing', () => {
    const items: Item[] = [
      item('prompt', { type: 'message', role: 'user', text: 'Fix it' }),
      item('call-1', { type: 'tool_call', text: 'read_file' }),
      item('call-2', { type: 'command', text: 'pnpm test' }),
      item('call-3', { type: 'tool_call', text: 'read_file' }),
      item('blank', { type: 'reasoning', text: '' }),
      item('answer', { type: 'message', role: 'assistant', text: 'Done.' }),
    ]
    const { presentations } = projectThreadItems(items)
    const sizes = items.map((entry, index) =>
      estimateThreadRowSize(entry, index, presentations.get(entry.turnId!)),
    )

    // One collapsed summary stands in for the whole run of tool calls.
    expect(sizes.slice(1, 5)).toEqual([46, 0, 0, 0])
    expect(sizes[0]).toBe(72)
    expect(sizes[5]).toBe(72)
  })
})

describe('overscanVisibleRows', () => {
  it('counts only rows that take up space toward the overscan', () => {
    // 0 prompt, 1 summary, 2-9 hidden tool rows, 10 answer, 11 next prompt
    const sizes = [40, 93, 0, 0, 0, 0, 0, 0, 0, 0, 90, 40]
    const rows = overscanVisibleRows(
      { startIndex: 10, endIndex: 10, overscan: 1, count: sizes.length },
      (index) => sizes[index],
    )
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('stops at the ends of the list', () => {
    const rows = overscanVisibleRows(
      { startIndex: 0, endIndex: 1, overscan: 8, count: 3 },
      () => 20,
    )
    expect(rows).toEqual([0, 1, 2])
  })
})
