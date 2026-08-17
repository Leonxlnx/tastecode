import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import { createThreadProjector, findTurns, neighbourTurn, presentTurns } from './turns.js'

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

  it('keeps reasoning visible and groups the following tool activity', () => {
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user', createdAt: 1_000 },
      {
        ...item('reasoning', 't1'),
        type: 'reasoning',
        text: 'Inspecting',
        createdAt: 2_000,
      },
      {
        ...item('command', 't1'),
        type: 'command',
        command: 'pnpm test',
        createdAt: 3_000,
      },
      { ...item('answer', 't1'), role: 'assistant', text: 'Done.', createdAt: 7_500 },
    ]

    expect(presentTurns(items).get('t1')).toMatchObject({
      activityGroups: [{ items: [items[2]], firstIndex: 2 }],
      responseText: 'Done.',
      firstResponseIndex: 1,
      finalAnswerIndex: 3,
      elapsedMs: 6_500,
      complete: true,
    })
  })

  it('falls back to item timestamps when a durable boundary is incomplete', () => {
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user', createdAt: 35_000 },
      { ...item('answer', 't1'), role: 'assistant', text: 'Done.', createdAt: 38_000 },
    ]

    expect(presentTurns(items, { t1: { startedAt: 1_000 } }).get('t1')?.elapsedMs).toBe(3_000)
  })

  it('uses durable completion instead of the final item as the elapsed endpoint', () => {
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user', createdAt: 1_000 },
      { ...item('answer', 't1'), role: 'assistant', text: 'Done.', createdAt: 4_000 },
    ]

    expect(
      presentTurns(items, { t1: { startedAt: 1_000, completedAt: 32_000 } }).get('t1')?.elapsedMs,
    ).toBe(31_000)
  })

  it('does not compact activity while the turn is still streaming', () => {
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user' },
      { ...item('command', 't1'), type: 'command', status: 'started' },
    ]

    expect(presentTurns(items).get('t1')?.complete).toBe(false)
  })

  it('only compacts repeated settled reasoning when no answer exists', () => {
    const reasoning = (id: string, status: Item['status'] = 'completed'): Item => ({
      ...item(id, 't1'),
      type: 'reasoning',
      status,
    })

    expect(presentTurns([reasoning('one')]).get('t1')?.complete).toBe(false)
    expect(presentTurns([reasoning('one'), reasoning('two', 'started')]).get('t1')?.complete).toBe(
      false,
    )
    expect(
      presentTurns([
        reasoning('one'),
        { ...item('command', 't1'), type: 'command', command: 'pnpm test' },
      ]).get('t1')?.complete,
    ).toBe(false)
  })

  it('collects activity around assistant narration into one disclosure', () => {
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user', text: 'Fix it.' },
      { ...item('update-1', 't1'), role: 'assistant', text: 'I found the cause.' },
      { ...item('command', 't1'), type: 'command', command: 'pnpm test' },
      { ...item('update-2', 't1'), role: 'assistant', text: 'The focused test passes.' },
      { ...item('files', 't1'), type: 'file_change', text: '2 files changed' },
      { ...item('answer', 't1'), role: 'assistant', text: 'Fixed.' },
    ]

    expect(presentTurns(items).get('t1')).toMatchObject({
      activityGroups: [{ items: [items[2], items[4]], firstIndex: 2 }],
      responseText: 'Fixed.',
      finalAnswerIndex: 5,
      complete: true,
    })
  })

  it('keeps one activity group across empty reasoning placeholders', () => {
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user', text: 'Fix it.' },
      { ...item('command-1', 't1'), type: 'command', command: 'git status --short' },
      { ...item('blank-1', 't1'), type: 'reasoning' },
      { ...item('files', 't1'), type: 'file_change', text: '2 files changed' },
      { ...item('blank-2', 't1'), type: 'reasoning', text: '   ' },
      { ...item('command-2', 't1'), type: 'command', command: 'pnpm test' },
      { ...item('summary', 't1'), type: 'reasoning', text: 'Reviewing test results' },
      { ...item('answer', 't1'), role: 'assistant', text: 'Fixed.' },
    ]

    expect(presentTurns(items).get('t1')?.activityGroups).toMatchObject([
      {
        items: [items[1], items[3], items[5]],
        firstIndex: 1,
        lastIndex: 5,
      },
    ])
  })

  it('keeps the live timer reset while the completed disclosure uses total turn time', () => {
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user', text: 'Fix it.', createdAt: 1_000 },
      { ...item('thinking', 't1'), type: 'reasoning', createdAt: 2_000 },
      {
        ...item('update', 't1'),
        role: 'assistant',
        phase: 'commentary',
        text: 'I found the cause.',
        createdAt: 5_000,
      },
      { ...item('command', 't1'), type: 'command', command: 'pnpm test', createdAt: 6_000 },
      {
        ...item('answer', 't1'),
        role: 'assistant',
        phase: 'final_answer',
        text: 'Fixed.',
        createdAt: 13_000,
      },
    ]

    const presentation = presentTurns(items, {
      t1: { startedAt: 1_000, completedAt: 14_000 },
    }).get('t1')

    expect(presentation?.activityGroups.map(({ elapsedMs }) => elapsedMs)).toEqual([13_000])
    expect(presentation?.workStartedAt).toBe(13_000)
  })

  it('prefers the explicit final-answer phase over a later commentary message', () => {
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user', text: 'Fix it.' },
      {
        ...item('answer', 't1'),
        role: 'assistant',
        phase: 'final_answer',
        text: 'Fixed.',
      },
      {
        ...item('late-update', 't1'),
        role: 'assistant',
        phase: 'commentary',
        text: 'The verification also finished.',
      },
    ]

    expect(presentTurns(items).get('t1')).toMatchObject({
      responseText: 'Fixed.',
      finalAnswerIndex: 1,
      complete: true,
    })
  })

  it('uses the last unphased assistant message only as a legacy final-answer fallback', () => {
    const legacy: Item[] = [
      { ...item('user', 't1'), role: 'user', text: 'Fix it.' },
      { ...item('update', 't1'), role: 'assistant', text: 'Checking.' },
      { ...item('answer', 't1'), role: 'assistant', text: 'Fixed.' },
    ]
    const commentaryOnly: Item[] = [
      { ...item('user', 't2'), role: 'user', text: 'Fix it.' },
      {
        ...item('update', 't2'),
        role: 'assistant',
        phase: 'commentary',
        text: 'Still checking.',
      },
    ]

    expect(presentTurns(legacy).get('t1')).toMatchObject({
      responseText: 'Fixed.',
      finalAnswerIndex: 2,
      complete: true,
    })
    expect(presentTurns(commentaryOnly).get('t2')).toMatchObject({
      responseText: '',
      finalAnswerIndex: undefined,
      complete: false,
    })
  })

  it('projects completed items identically after durable history replay', () => {
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user' },
      { ...item('command', 't1'), type: 'command', command: 'pnpm test' },
      {
        ...item('answer', 't1'),
        role: 'assistant',
        phase: 'final_answer',
        text: 'Done.',
      },
    ]

    expect(presentTurns(items.map((entry) => ({ ...entry })))).toEqual(presentTurns(items))
  })

  it('reuses transcript layout while only the live answer text changes', () => {
    const project = createThreadProjector()
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user', text: 'Question' },
      {
        ...item('answer', 't1'),
        role: 'assistant',
        status: 'started',
        text: 'Hel',
      },
    ]
    const initial = project(items)
    const streamed = project([items[0]!, { ...items[1]!, text: 'Hello' }])

    expect(streamed).toBe(initial)
  })

  it('rebuilds transcript layout when a streamed answer completes or history is replaced', () => {
    const project = createThreadProjector()
    const items: Item[] = [
      { ...item('user', 't1'), role: 'user', text: 'Question' },
      {
        ...item('answer', 't1'),
        role: 'assistant',
        status: 'started',
        text: 'Hello',
      },
    ]
    const initial = project(items)
    const completed = project([items[0]!, { ...items[1]!, status: 'completed', text: 'Hello.' }])
    const replaced = project(items.map((entry) => ({ ...entry })))

    expect(completed).not.toBe(initial)
    expect(completed.presentations.get('t1')?.responseText).toBe('Hello.')
    expect(replaced).not.toBe(completed)
  })
})
