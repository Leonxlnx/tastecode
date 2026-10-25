import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import { projectThreadItems } from './turns.js'
import { replyPreview, rowAtOffset, turnAt, turnRailEntries } from './turn-rail.js'

const message = (id: string, turnId: string, role: 'user' | 'assistant', text: string): Item => ({
  id,
  turnId,
  type: 'message',
  role,
  status: 'completed',
  text,
  createdAt: 0,
})

const entriesOf = (items: Item[]) => {
  const { turns, presentations } = projectThreadItems(items)
  return turnRailEntries(turns, presentations)
}

describe('turn rail entries', () => {
  it('marks each prompted turn at its first row, with the prompt on one line', () => {
    const entries = entriesOf([
      message('p1', 't1', 'user', 'Fix the\n\n  login   bug'),
      message('a1', 't1', 'assistant', 'Done.'),
      message('p2', 't2', 'user', 'Now the tests'),
      message('a2', 't2', 'assistant', 'Passing.'),
    ])

    expect(entries).toEqual([
      { turnId: 't1', index: 0, prompt: 'Fix the login bug', at: 0 },
      { turnId: 't2', index: 2, prompt: 'Now the tests', at: 0 },
    ])
  })

  it('skips turns nobody prompted', () => {
    const entries = entriesOf([
      message('a0', 't0', 'assistant', 'Resumed.'),
      message('p1', 't1', 'user', 'Go on'),
    ])

    expect(entries.map((entry) => entry.turnId)).toEqual(['t1'])
  })

  it('names a prompt without text by its attachment', () => {
    const entries = entriesOf([{ ...message('p1', 't1', 'user', ''), attachments: ['a.png'] }])

    expect(entries[0]?.prompt).toBe('Attachment')
  })

  it('cuts a pasted wall of text down to a label', () => {
    const [entry] = entriesOf([message('p1', 't1', 'user', 'word '.repeat(2000))])

    expect(entry!.prompt.length).toBeLessThanOrEqual(241)
    expect(entry!.prompt.endsWith('…')).toBe(true)
  })

  it('keeps the previous list while no tick changes', () => {
    const items = [message('p1', 't1', 'user', 'One'), message('p2', 't2', 'user', 'Two')]
    const { turns, presentations } = projectThreadItems(items)
    const first = turnRailEntries(turns, presentations)
    const grown = projectThreadItems([...items, message('a2', 't2', 'assistant', 'Answer')])

    expect(turnRailEntries(grown.turns, grown.presentations, first)).toBe(first)
  })
})

describe('turn rail positions', () => {
  const entries = [
    { turnId: 'a', index: 2, prompt: 'a', at: 0 },
    { turnId: 'b', index: 5, prompt: 'b', at: 0 },
    { turnId: 'c', index: 9, prompt: 'c', at: 0 },
  ]

  it('finds the turn a row belongs to', () => {
    expect(turnAt(entries, 0)).toBe(0)
    expect(turnAt(entries, 2)).toBe(0)
    expect(turnAt(entries, 4)).toBe(0)
    expect(turnAt(entries, 5)).toBe(1)
    expect(turnAt(entries, 8)).toBe(1)
    expect(turnAt(entries, 40)).toBe(2)
  })

  it('finds the row at an offset', () => {
    const rows = [{ start: 0 }, { start: 40 }, { start: 40 }, { start: 100 }]

    expect(rowAtOffset(rows, -16)).toBe(0)
    expect(rowAtOffset(rows, 39)).toBe(0)
    expect(rowAtOffset(rows, 40)).toBe(2)
    expect(rowAtOffset(rows, 99)).toBe(2)
    expect(rowAtOffset(rows, 5000)).toBe(3)
  })
})

describe('reply preview', () => {
  it('reads markdown as plain prose', () => {
    expect(
      replyPreview(
        [
          '## Done',
          '',
          'The **settings gear** now opens a `Settings` sheet; see [the PR](https://x.test/1).',
          '',
          '- one item',
          '1. step',
          '> quoted',
          '',
          '```ts',
          'const hidden = true',
          '```',
          'After the *code*.',
        ].join('\n'),
      ),
    ).toBe(
      'Done The settings gear now opens a Settings sheet; see the PR. one item step quoted After the code.',
    )
  })

  it('leaves snake_case and lone asterisks alone', () => {
    expect(replyPreview('Set max_turn_count to 2 * 3')).toBe('Set max_turn_count to 2 * 3')
  })

  it('drops tables', () => {
    expect(
      replyPreview('Both are in.\n\n| Before | After |\n|---|---|\n| 1 | 2 |\n\nCheck them.'),
    ).toBe('Both are in. Check them.')
  })

  it('drops an unclosed code block to the end', () => {
    expect(replyPreview('Here:\n```\nlet a = 1')).toBe('Here:')
  })

  it('stops at what three lines can show', () => {
    const preview = replyPreview('word '.repeat(500))

    expect(preview.length).toBeLessThanOrEqual(321)
    expect(preview.endsWith('…')).toBe(true)
  })
})
