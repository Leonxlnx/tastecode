import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadModel } from '../state/thread-model'
import {
  approvalView,
  buildRows,
  relative,
  rowView,
  stepRuns,
  stepView,
  summarize,
  toolName,
  toolTitle,
} from './thread'

const step = (patch: Partial<Item> & Pick<Item, 'id' | 'type'>): Item => ({
  turnId: 't1',
  status: 'completed',
  createdAt: 1,
  ...patch,
})

describe('thread rows', () => {
  it('folds the work between messages into one row that names its latest step while live', () => {
    const model = new ThreadModel()
    model.apply({
      type: 'turn.started',
      turn: { id: 't1', threadId: 'x', status: 'running', createdAt: 1_000 },
    })
    model.apply({
      type: 'item.completed',
      item: step({ id: 'u', type: 'message', role: 'user', text: 'Fix it' }),
    })
    model.apply({
      type: 'item.completed',
      item: step({ id: 'f', type: 'file_change', path: '/p/src/App.tsx' }),
    })
    model.apply({
      type: 'item.started',
      item: step({ id: 'c', type: 'command', status: 'started', command: 'npm test\n--watch' }),
    })
    const view = model.view()
    const rows = buildRows(view)
    expect(rows.map((row) => row.kind)).toEqual(['user', 'steps'])
    expect(rowView(rows[1]!, view)).toMatchObject({
      kind: 'steps',
      live: true,
      summary: 'Running npm test',
      duration: null,
    })
  })

  it('words finished work as one sentence with the turn’s duration', () => {
    const model = new ThreadModel()
    model.apply({
      type: 'turn.started',
      turn: { id: 't1', threadId: 'x', status: 'running', createdAt: 1_000 },
    })
    model.apply({
      type: 'item.completed',
      item: step({ id: 'a', type: 'file_change', path: 'a.ts' }),
    })
    model.apply({
      type: 'item.completed',
      item: step({ id: 'b', type: 'file_change', path: 'b.ts' }),
    })
    model.apply({
      type: 'item.completed',
      item: step({ id: 'c', type: 'command', command: 'ls', exitCode: 1 }),
    })
    model.apply({ type: 'turn.completed', turnId: 't1', status: 'completed', completedAt: 43_000 })
    const view = model.view()
    expect(rowView(buildRows(view)[0]!, view)).toMatchObject({
      summary: 'Edited 2 files and ran 1 command',
      duration: '42s',
      failed: true,
    })
  })

  it('folds a settled turn into one Worked for group above its answer, notes inside', () => {
    const model = new ThreadModel()
    const say = (id: string, text: string, createdAt: number) =>
      step({ id, type: 'message', role: 'assistant', text, createdAt })
    model.apply({
      type: 'turn.started',
      turn: { id: 't1', threadId: 'x', status: 'running', createdAt: 1_000 },
    })
    model.apply({
      type: 'item.completed',
      item: step({ id: 'u', type: 'message', role: 'user', text: 'Fix it' }),
    })
    model.apply({ type: 'item.completed', item: step({ id: 'r', type: 'reasoning', text: '' }) })
    model.apply({ type: 'item.completed', item: step({ id: 'a', type: 'command', command: 'ls' }) })
    model.apply({ type: 'item.completed', item: say('n', 'Found it, fixing now.', 2_000) })
    model.apply({
      type: 'item.completed',
      item: step({ id: 'b', type: 'file_change', path: 'a.ts' }),
    })
    model.apply({ type: 'item.completed', item: say('f', 'Fixed.', 3_000) })
    // While it works, the note sits between the batches as it came.
    const live = model.view()
    expect(
      buildRows({ ...live, running: true, activeTurnId: 't1' }).map((row) => row.kind),
    ).toEqual(['user', 'steps', 'assistant', 'steps', 'assistant'])
    model.apply({ type: 'turn.completed', turnId: 't1', status: 'completed', completedAt: 199_000 })
    const view = model.view()
    const rows = buildRows(view)
    expect(rows.map((row) => row.key)).toEqual(['u', 'work:t1', 'f'])
    expect(rowView(rows[1]!, view)).toMatchObject({
      summary: 'Worked for 3m 18s',
      duration: null,
      steps: [
        { kind: 'command' },
        { kind: 'note', title: 'Found it, fixing now.' },
        { kind: 'file' },
      ],
    })
  })

  it('folds everything between two notes under one summary', () => {
    const runs = stepRuns([
      step({ id: 'a', type: 'command', command: 'ls' }),
      step({ id: 'r', type: 'reasoning', text: 'Hm.' }),
      step({ id: 'b', type: 'command', command: 'pwd' }),
      step({ id: 'd', type: 'tool_call', text: 'Read\n{"file_path":"/x/a.ts"}' }),
      step({ id: 'n', type: 'message', role: 'assistant', text: 'Looked around.' }),
      step({ id: 't', type: 'reasoning', text: 'Which file?', durationMs: 12_000 }),
      step({ id: 'm', type: 'message', role: 'assistant', text: 'This one.' }),
      step({ id: 'c', type: 'file_change', path: 'a.ts' }),
    ])
    expect(runs.map((run) => [run.summary, run.steps.map((entry) => entry.id)])).toEqual([
      ['Ran 2 commands and read 1 file', ['a', 'r', 'b', 'd']],
      [null, ['n']],
      ['Thought for 12s', ['t']],
      [null, ['m']],
      ['Edited 1 file', ['c']],
    ])
  })

  it('names a thought by its first line and a file read as a read', () => {
    const thought = '**Checking the list**\nThe second entry is stale.'
    expect(stepView(step({ id: 't', type: 'reasoning', text: thought }))).toMatchObject({
      kind: 'thinking',
      title: 'Checking the list',
      detail: thought,
    })
    expect(
      stepView(step({ id: 'r', type: 'tool_call', text: 'Read\n{"file_path":"/x/a.ts"}' })),
    ).toMatchObject({ kind: 'read', title: 'Read a.ts' })
  })

  it('summarizes steps of every kind in reading order', () => {
    expect(
      summarize([
        step({ id: '1', type: 'file_change', path: 'a' }),
        step({ id: '2', type: 'command' }),
        step({ id: '3', type: 'tool_call' }),
        step({ id: '4', type: 'tool_call' }),
      ]),
    ).toBe('Edited 1 file, ran 1 command and used 2 tools')
    expect(summarize([step({ id: '1', type: 'reasoning' })])).toBe('Thought it through')
  })

  it('names a tool call after the thing it acted on', () => {
    expect(toolTitle('Read\n{"file_path":"/tmp/demo/README.md"}\n1\t# Demo')).toBe('Read README.md')
    expect(toolTitle('WebSearch\n\n{\n  "query": "swift {braces}"\n}')).toBe(
      'Web search swift {braces}',
    )
    expect(toolTitle('grep [{"match":1}]')).toBe('Grep')
    expect(toolTitle('TodoWrite')).toBe('Todo write')
  })

  it('reads a tool’s identifier as words and leaves phrases alone', () => {
    expect(toolName('AskUserQuestion')).toBe('Ask user question')
    expect(toolName('web_search')).toBe('Web search')
    expect(toolName('readURL')).toBe('Read URL')
    expect(toolName('Read README.md')).toBe('Read README.md')
  })
})

describe('approvals', () => {
  it('names a file from the project folder, through macOS’s /private paths', () => {
    expect(relative('/private/tmp/demo/notes.md', '/tmp/demo')).toBe('notes.md')
    expect(relative('C:\\work\\app\\src\\a.ts', 'C:\\work\\app')).toBe('src\\a.ts')
    expect(relative('/etc/hosts', '/tmp/demo')).toBe('/etc/hosts')
  })

  it('drops a reason that only repeats the file and names a working folder elsewhere', () => {
    expect(
      approvalView(
        {
          id: 'a',
          kind: 'file_change',
          path: '/tmp/demo/notes.md',
          reason: 'notes.md',
          createdAt: 1,
        },
        '/tmp/demo',
      ),
    ).toEqual({
      id: 'a',
      title: 'Change this file?',
      subject: 'notes.md',
      reason: null,
      where: null,
    })
    expect(
      approvalView(
        {
          id: 'b',
          kind: 'command',
          command: 'rm -rf build',
          cwd: '/tmp/demo/web',
          reason: 'Clean',
          createdAt: 1,
        },
        '/tmp/demo',
      ),
    ).toEqual({
      id: 'b',
      title: 'Run this command?',
      subject: 'rm -rf build',
      reason: 'Clean',
      where: 'web',
    })
  })
})
