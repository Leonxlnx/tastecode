import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DomainEventSchema, type DomainEvent } from '@harness/contracts'
import { createGrokHistorySource } from './history.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const start = 1_787_396_400_000

async function fixture(id = 'saved-session') {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-history-'))
  roots.push(root)
  const workspace = path.join(root, 'project with spaces')
  const directory = path.join(root, 'sessions', encodeURIComponent(workspace), id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'summary.json'),
    JSON.stringify({
      info: { id, cwd: workspace },
      generated_title: 'Native Grok chat',
      created_at: new Date(start).toISOString(),
      updated_at: new Date(start + 10_000).toISOString(),
    }),
  )
  const source = createGrokHistorySource({ root })
  return { root, directory, source, workspace }
}

function update(sessionUpdate: string, values = {}, tick = 0, promptId?: string) {
  return {
    timestamp: start / 1000 + tick,
    method: 'session/update',
    params: {
      sessionId: 'saved-session',
      update: { sessionUpdate, ...values },
      _meta: {
        eventId: `event-${tick}-${sessionUpdate}`,
        agentTimestampMs: start + tick * 1000,
        ...(promptId ? { promptId } : {}),
      },
    },
  }
}

async function save(directory: string, filename: string, rows: unknown[]) {
  await writeFile(
    path.join(directory, filename),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  )
}

function items(events: DomainEvent[]) {
  return events.flatMap((event) => (event.type === 'item.completed' ? [event.item] : []))
}

describe('Grok native history', () => {
  it.skipIf(process.platform === 'win32')(
    'does not read transcript files linked outside their session folder',
    async () => {
      const { source, directory, root } = await fixture()
      const outside = path.join(root, 'outside.jsonl')
      await save(root, 'outside.jsonl', [
        update('user_message_chunk', { content: { type: 'text', text: 'Outside content' } }),
      ])
      await symlink(outside, path.join(directory, 'updates.jsonl'))
      const [session] = await source.list()
      expect(session).toBeDefined()
      const events = await source.read(session!)
      expect(items(events)).toEqual([])
      expect(JSON.stringify(events)).not.toContain('Outside content')
    },
  )

  it('discovers all workspace stores, retains metadata, and isolates incomplete summaries', async () => {
    const { source, directory, root, workspace } = await fixture()
    await save(directory, 'updates.jsonl', [
      update('user_message_chunk', { content: { type: 'text', text: 'hello' } }),
    ])
    const second = path.join(
      root,
      'sessions',
      encodeURIComponent(path.join(root, 'other')),
      'other-session',
    )
    await mkdir(second, { recursive: true })
    await writeFile(path.join(second, 'summary.json'), '{partial')
    await save(second, 'chat_history.jsonl', [{ type: 'user', content: 'Saved elsewhere' }])
    const sessions = await source.list()
    expect(sessions).toHaveLength(2)
    expect(sessions.find((s) => s.id === 'saved-session')).toMatchObject({
      title: 'Native Grok chat',
      workspacePath: workspace,
      createdAt: start,
    })
    const oldRevision = sessions.find((s) => s.id === 'saved-session')!.revision
    await save(directory, 'updates.jsonl', [
      update('user_message_chunk', { content: { type: 'text', text: 'longer changed content' } }),
    ])
    expect((await source.list()).find((s) => s.id === 'saved-session')!.revision).not.toBe(
      oldRevision,
    )
  })

  it('replays exact Markdown, thought text, tools, command output, diffs, images and turns', async () => {
    const { source, directory, workspace } = await fixture()
    const markdown = '  # Heading\n\n```ts\nconst n = 1\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n'
    const attachment = path.join(workspace, 'screen.png')
    const rows = [
      update('user_message_chunk', {
        content: { type: 'text', text: 'Use this\n\n' },
        _meta: { promptIndex: 0 },
      }),
      update(
        'user_message_chunk',
        {
          content: { type: 'resource_link', uri: pathToFileURL(attachment).href },
          _meta: { promptIndex: 0 },
        },
        1,
      ),
      update(
        'agent_thought_chunk',
        { content: { type: 'text', text: '  Think\n\ncarefully.  ' } },
        2,
        'native-turn-1',
      ),
      update(
        'tool_call',
        {
          toolCallId: 'command',
          title: 'Run checks',
          rawInput: { command: 'node check.mjs' },
          _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } },
        },
        3,
        'native-turn-1',
      ),
      update(
        'tool_call_update',
        {
          toolCallId: 'command',
          status: 'completed',
          rawOutput: { type: 'Bash', output: [...Buffer.from('  output\n\n')], exit_code: 7 },
        },
        4,
        'native-turn-1',
      ),
      update(
        'tool_call',
        {
          toolCallId: 'edit',
          title: 'Edit file',
          rawInput: { file_path: 'app.ts' },
          _meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit' } },
        },
        5,
        'native-turn-1',
      ),
      update(
        'tool_call_update',
        {
          toolCallId: 'edit',
          kind: 'edit',
          content: [{ type: 'diff', path: 'app.ts', oldText: 'old\n', newText: 'new\nmore\n' }],
        },
        6,
        'native-turn-1',
      ),
      update('tool_call_update', { toolCallId: 'edit', status: 'completed' }, 7, 'native-turn-1'),
      update(
        'plan',
        { entries: [{ content: 'Do the work', status: 'completed' }] },
        8,
        'native-turn-1',
      ),
      update(
        'agent_message_chunk',
        { content: { type: 'text', text: markdown.slice(0, 15) } },
        9,
        'native-turn-1',
      ),
      update(
        'agent_message_chunk',
        { content: { type: 'text', text: markdown.slice(15) } },
        10,
        'native-turn-1',
      ),
      update('turn_completed', { prompt_id: 'native-turn-1', stop_reason: 'end_turn' }, 11),
      update(
        'user_message_chunk',
        { content: { type: 'text', text: 'Again' }, _meta: { promptIndex: 1 } },
        12,
      ),
      update(
        'agent_message_chunk',
        { content: { type: 'text', text: 'Done.' } },
        13,
        'native-turn-2',
      ),
      update('turn_completed', { prompt_id: 'native-turn-2', stop_reason: 'end_turn' }, 14),
    ]
    await save(directory, 'updates.jsonl', rows)
    const before = await readFile(path.join(directory, 'updates.jsonl'), 'utf8')
    const [session] = await source.list()
    const events = await source.read(session!)
    events.forEach((event) => expect(DomainEventSchema.safeParse(event).success).toBe(true))
    expect(items(events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: 'Use this\n\n', attachments: [attachment] }),
        expect.objectContaining({ type: 'reasoning', text: '  Think\n\ncarefully.  ' }),
        expect.objectContaining({
          type: 'command',
          command: 'node check.mjs',
          text: '  output\n\n',
          exitCode: 7,
          status: 'failed',
          durationMs: 1000,
        }),
        expect.objectContaining({
          type: 'file_change',
          path: 'app.ts',
          text: '--- a/app.ts\n+++ b/app.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+more',
          linesAdded: 2,
          linesRemoved: 1,
        }),
        expect.objectContaining({
          role: 'assistant',
          text: markdown,
          phase: 'final_answer',
          turnId: 'native-turn-1',
        }),
      ]),
    )
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(2)
    expect(events).toContainEqual({
      type: 'plan.updated',
      turnId: 'native-turn-1',
      steps: [{ text: 'Do the work', status: 'done' }],
    })
    expect(await source.read(session!)).toEqual(events)
    expect(await readFile(path.join(directory, 'updates.jsonl'), 'utf8')).toBe(before)
  })

  it('ignores corrupt lines and duplicate events and marks unfinished saved work interrupted', async () => {
    const { source, directory } = await fixture()
    const message = update(
      'agent_message_chunk',
      { content: { type: 'text', text: 'One copy' } },
      1,
      'native-partial',
    )
    await writeFile(
      path.join(directory, 'updates.jsonl'),
      [
        JSON.stringify(update('user_message_chunk', { content: { type: 'text', text: 'Hi' } })),
        '{broken}',
        JSON.stringify(message),
        JSON.stringify(message),
        '{unfinished',
      ].join('\n'),
    )
    const [session] = await source.list()
    const events = await source.read(session!)
    expect(
      items(events)
        .filter((item) => item.role === 'assistant')
        .map((item) => item.text),
    ).toEqual(['One copy'])
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', status: 'interrupted' })
  })

  it('keeps tool input and late background output on the original tool item', async () => {
    const { source, directory } = await fixture()
    await save(directory, 'updates.jsonl', [
      update('user_message_chunk', { content: { type: 'text', text: 'Check it' } }),
      update(
        'tool_call',
        { toolCallId: 'search', title: 'Search', rawInput: { pattern: 'needle' } },
        1,
        'turn',
      ),
      update(
        'tool_call_update',
        {
          toolCallId: 'search',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: '  match\n' } }],
        },
        2,
        'turn',
      ),
      update(
        'tool_call',
        { toolCallId: 'background', rawInput: { command: 'node slow.mjs' } },
        3,
        'turn',
      ),
      update('task_backgrounded', { tool_call_id: 'background', task_id: 'task-1' }, 4),
      update(
        'tool_call_update',
        {
          toolCallId: 'background',
          status: 'completed',
          content: [{ type: 'text', text: 'Running in background' }],
        },
        5,
        'turn',
      ),
      update('turn_completed', { prompt_id: 'turn', stop_reason: 'end_turn' }, 6),
      update(
        'task_completed',
        { task_snapshot: { task_id: 'task-1', output: '  final stdout\n', exit_code: 0 } },
        7,
      ),
    ])
    const [session] = await source.list()
    const events = await source.read(session!)
    expect(items(events)).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        text: 'Search\n{\n  "pattern": "needle"\n}\n  match\n',
      }),
    )
    expect(items(events).filter((item) => item.type === 'command')).toEqual([
      expect.objectContaining({
        command: 'node slow.mjs',
        text: '  final stdout\n',
        exitCode: 0,
        durationMs: 4000,
      }),
    ])
  })

  it('uses native model history when UI updates are missing without exposing system context or encrypted reasoning', async () => {
    const { source, directory } = await fixture()
    await save(directory, 'chat_history.jsonl', [
      { type: 'system', content: 'internal system text' },
      { type: 'user', content: [{ type: 'text', text: 'injected context' }] },
      {
        type: 'user',
        content: [{ type: 'text', text: 'synthetic reminder' }],
        synthetic_reason: 'system_reminder',
      },
      { type: 'user', content: [{ type: 'text', text: '  User\n\n' }], prompt_index: 0 },
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Thought\n' }],
        encrypted_content: 'encrypted-private-state',
      },
      {
        type: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'native-tool',
            name: 'run_terminal_command',
            arguments: JSON.stringify({ command: 'node file.mjs' }),
          },
        ],
      },
      { type: 'tool_result', tool_call_id: 'native-tool', content: '  stdout\n' },
      {
        type: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'write',
            name: 'write',
            arguments: JSON.stringify({ file_path: 'new.ts', content: 'const x = 1\n' }),
          },
        ],
      },
      { type: 'tool_result', tool_call_id: 'write', content: 'Saved' },
      { type: 'assistant', content: '**Finished**\n\n' },
    ])
    const [session] = await source.list()
    const events = await source.read(session!)
    expect(items(events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: '  User\n\n' }),
        expect.objectContaining({ type: 'reasoning', text: 'Thought\n' }),
        expect.objectContaining({
          type: 'command',
          command: 'node file.mjs',
          text: '  stdout\n',
          status: 'completed',
        }),
        expect.objectContaining({
          type: 'file_change',
          path: 'new.ts',
          text: '--- a/new.ts\n+++ b/new.ts\n@@ -1,0 +1,1 @@\n+const x = 1\nSaved',
        }),
        expect.objectContaining({
          role: 'assistant',
          text: '**Finished**\n\n',
          phase: 'final_answer',
        }),
      ]),
    )
    expect(JSON.stringify(events)).not.toMatch(
      /internal system text|injected context|synthetic reminder|encrypted-private-state/,
    )
  })

  it('returns empty for absent stores and refuses locators outside the provider store', async () => {
    const { source, directory, root } = await fixture()
    await save(directory, 'updates.jsonl', [
      update('user_message_chunk', { content: { type: 'text', text: 'Hello' } }),
    ])
    const [session] = await source.list()
    expect(await createGrokHistorySource({ root: path.join(root, 'missing') }).list()).toEqual([])
    expect(await source.read({ ...session!, locator: root })).toEqual([])
  })
})
