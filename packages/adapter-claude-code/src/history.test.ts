import { afterEach, describe, expect, it } from 'vitest'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DomainEventSchema, type DomainEvent } from '@harness/contracts'
import { createClaudeHistorySource } from './history.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const AT = Date.parse('2026-09-15T10:00:00.000Z')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function row(
  uuid: string,
  type: string,
  content: unknown,
  parentUuid: string | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    uuid,
    parentUuid,
    sessionId: SESSION,
    cwd: path.join(os.tmpdir(), 'claude-workspace'),
    timestamp: new Date(AT).toISOString(),
    message: { role: type, content },
    ...extra,
  }
}

async function fixture(rows: unknown[], id = SESSION) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-history-'))
  directories.push(configDir)
  const project = path.join(configDir, 'projects', '-fixture')
  await mkdir(project, { recursive: true })
  const file = path.join(project, `${id}.jsonl`)
  await writeFile(file, rows.map((item) => JSON.stringify(item)).join('\n') + '\n')
  const source = createClaudeHistorySource({ configDir })
  return { configDir, project, file, source }
}

function items(events: DomainEvent[]) {
  return events.flatMap((event) => (event.type === 'item.completed' ? [event.item] : []))
}

describe('Claude Code saved history', () => {
  it('maps legacy TasteCode thread IDs to native session IDs', () => {
    const source = createClaudeHistorySource()
    expect(source.resolveSessionId?.('claude-11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    )
    expect(source.resolveSessionId?.('11111111-1111-4111-8111-111111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111111',
    )
  })
  it('finds sessions without an index, respects native titles and timestamps, and notices updates', async () => {
    const f = await fixture([
      row('u1', 'user', 'First **prompt**'),
      { type: 'ai-title', sessionId: SESSION, aiTitle: 'Native title' },
    ])
    await writeFile(
      path.join(f.project, 'sessions-index.json'),
      JSON.stringify({
        entries: [
          { sessionId: SECOND, firstPrompt: 'Stale missing file', projectPath: '/missing' },
        ],
      }),
    )
    const first = await f.source.list()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ id: SESSION, title: 'Native title', createdAt: AT })
    const before = await readFile(f.file, 'utf8')
    const info = await stat(f.file)
    await f.source.read(first[0]!)
    expect(await readFile(f.file, 'utf8')).toBe(before)
    expect((await stat(f.file)).mtimeMs).toBe(info.mtimeMs)
    await appendFile(
      f.file,
      JSON.stringify({ type: 'custom-title', customTitle: 'Renamed', sessionId: SESSION }) + '\n',
    )
    const next = await f.source.list()
    expect(next[0]?.title).toBe('Renamed')
    expect(next[0]?.revision).not.toBe(first[0]?.revision)
  })

  it('preserves Markdown, reasoning, attachments, typed tool output, native times, and distinct turns', async () => {
    const prompt = '  Keep whitespace\n\n```ts\nconst x = 1\n```\n'
    const answer = '## Done\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    const f = await fixture([
      row('u1', 'user', [
        { type: 'text', text: prompt },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ]),
      row(
        'a1',
        'assistant',
        [
          { type: 'thinking', thinking: '  Think\n' },
          { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'node --version' } },
        ],
        'u1',
        {
          message: {
            id: 'msg1',
            content: [
              { type: 'thinking', thinking: '  Think\n' },
              { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'node --version' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ),
      row(
        'r1',
        'user',
        [{ type: 'tool_result', tool_use_id: 'tool1', content: '  v22\n', is_error: true }],
        'a1',
        {
          toolUseResult: { code: 1, durationMs: 12 },
          timestamp: new Date(AT + 1000).toISOString(),
        },
      ),
      row('a2', 'assistant', [], 'r1', {
        message: { id: 'msg2', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' },
        timestamp: new Date(AT + 2000).toISOString(),
      }),
      row('u2', 'user', 'Second prompt', 'a2', { timestamp: new Date(AT + 3000).toISOString() }),
    ])
    const session = (await f.source.list())[0]!
    const events = await f.source.read(session)
    events.forEach((event) => expect(DomainEventSchema.safeParse(event).success).toBe(true))
    const saved = items(events)
    expect(saved.find((item) => item.role === 'user')).toMatchObject({
      text: prompt,
      attachments: ['data:image/png;base64,AA=='],
      createdAt: AT,
    })
    expect(saved.find((item) => item.type === 'reasoning')?.text).toBe('  Think\n')
    expect(saved.find((item) => item.command === 'node --version')).toMatchObject({
      id: 'a1:1',
      text: '  v22\n',
      status: 'failed',
      exitCode: 1,
      durationMs: 12,
    })
    expect(saved.find((item) => item.role === 'assistant')?.text).toBe(answer)
    expect(events.filter((event) => event.type === 'turn.completed')).toMatchObject([
      { status: 'completed', completedAt: AT + 2000 },
      { status: 'interrupted', completedAt: AT + 3000 },
    ])
    expect(await f.source.read(session)).toEqual(events)
  })

  it('recovers sibling tool results and assistant blocks without including an abandoned branch or subagent', async () => {
    const f = await fixture([
      row('u1', 'user', 'Run both'),
      row('a1', 'assistant', [], 'u1', {
        message: {
          id: 'shared',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'first' } }],
        },
      }),
      row('a2', 'assistant', [], 'a1', {
        message: {
          id: 'shared',
          content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'second' } }],
        },
      }),
      row(
        'r1',
        'user',
        [{ type: 'tool_result', tool_use_id: 't1', content: 'first result' }],
        'a1',
      ),
      row(
        'r2',
        'user',
        [{ type: 'tool_result', tool_use_id: 't2', content: 'second result' }],
        'a2',
      ),
      row('old', 'assistant', [{ type: 'text', text: 'Abandoned answer' }], 'r2'),
      row('active', 'assistant', [{ type: 'text', text: 'Current answer' }], 'r2'),
      row('side', 'assistant', [{ type: 'text', text: 'Subagent answer' }], 'active', {
        isSidechain: true,
      }),
    ])
    await writeFile(
      path.join(f.project, `${SECOND}.jsonl`),
      JSON.stringify(
        row('only-side', 'assistant', [{ type: 'text', text: 'Only subagent' }], null, {
          isSidechain: true,
        }),
      ),
    )
    await mkdir(path.join(f.project, SESSION, 'subagents'), { recursive: true })
    await writeFile(
      path.join(f.project, SESSION, 'subagents', 'agent-worker.jsonl'),
      JSON.stringify(row('nested', 'user', 'Nested')),
    )
    const sessions = await f.source.list()
    expect(sessions).toHaveLength(1)
    const text = items(await f.source.read(sessions[0]!))
      .map((item) => item.text)
      .join('\n')
    expect(text).toContain('first result')
    expect(text).toContain('second result')
    expect(text).toContain('Current answer')
    expect(text).not.toContain('Abandoned answer')
    expect(text).not.toContain('Subagent answer')
  })

  it('keeps the visible conversation before compaction and hides the synthetic summary', async () => {
    const f = await fixture([
      row('u1', 'user', 'Original prompt'),
      row('a1', 'assistant', [{ type: 'text', text: 'Original answer' }], 'u1'),
      {
        type: 'system',
        uuid: 'compact',
        parentUuid: null,
        logicalParentUuid: 'a1',
        subtype: 'compact_boundary',
        compactMetadata: { preservedMessages: {} },
      },
      row('summary', 'user', 'Synthetic compact summary', 'compact', { isCompactSummary: true }),
      row('u2', 'user', 'New prompt', 'summary'),
      row('a2', 'assistant', [{ type: 'text', text: 'New answer' }], 'u2'),
    ])
    const saved = items(await f.source.read((await f.source.list())[0]!))
    expect(saved.filter((item) => item.type === 'message').map((item) => item.text)).toEqual([
      'Original prompt',
      'Original answer',
      'New prompt',
      'New answer',
    ])
  })

  it('hides SDK task notifications while preserving identical text pasted by the user', async () => {
    // Captured Claude 2.1.273 records use origin.kind, without isMeta or isSidechain.
    const notification =
      '<task-notification>\n<task-id>background</task-id>\n<status>stopped</status>\n</task-notification>'
    const f = await fixture([
      row('notification-before', 'user', notification, null, {
        origin: { kind: 'task-notification' },
        promptSource: 'sdk',
      }),
      row('u1', 'user', 'Start the preview', 'notification-before'),
      row('a1', 'assistant', [{ type: 'text', text: 'Checking the port.' }], 'u1'),
      row('notification', 'user', notification, 'a1', {
        origin: { kind: 'task-notification' },
        promptSource: 'sdk',
      }),
      row('u2', 'user', notification, 'notification'),
      row('a2', 'assistant', [{ type: 'text', text: 'That is a task notification.' }], 'u2'),
    ])
    const session = (await f.source.list())[0]!
    expect(session.title).toBe('Start the preview')
    const events = await f.source.read(session)
    expect(items(events).map((item) => item.text)).toEqual([
      'Start the preview',
      'Checking the port.',
      notification,
      'That is a task notification.',
    ])
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(2)
  })

  it('keeps tool identity stable when a result arrives, including image output and file changes', async () => {
    const f = await fixture([
      row('u1', 'user', 'Edit then inspect'),
      row(
        'a1',
        'assistant',
        [
          {
            type: 'tool_use',
            id: 'edit',
            name: 'Edit',
            input: { file_path: 'src/example.ts', old_string: 'before', new_string: 'after' },
          },
        ],
        'u1',
      ),
    ])
    const first = (await f.source.list())[0]!
    const before = await f.source.read(first)
    const call = before.find((event) => event.type === 'item.started')
    expect(call).toMatchObject({
      item: { id: 'a1:0', type: 'file_change', path: 'src/example.ts' },
    })
    await appendFile(
      f.file,
      JSON.stringify(
        row(
          'r1',
          'user',
          [
            {
              type: 'tool_result',
              tool_use_id: 'edit',
              content: [
                { type: 'text', text: 'Saved\n' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
                },
              ],
            },
          ],
          'a1',
        ),
      ) + '\n',
    )
    const result = items(await f.source.read((await f.source.list())[0]!)).find(
      (item) => item.id === 'a1:0',
    )
    expect(result).toMatchObject({
      type: 'file_change',
      path: 'src/example.ts',
      status: 'completed',
      attachments: ['data:image/png;base64,AA=='],
    })
    expect(result?.text).toContain('"new_string": "after"')
    expect(result?.text).toContain('Saved\n')
    expect(result?.text).not.toContain('base64')
  })

  it('isolates bad JSON, incomplete records, missing stores, and removed transcripts', async () => {
    const f = await fixture([row('u1', 'user', 'Valid')])
    await appendFile(f.file, 'not json\n{"type":"assistant"')
    await writeFile(path.join(f.project, `${SECOND}.jsonl`), '{bad')
    const session = (await f.source.list())[0]!
    expect(items(await f.source.read(session)).map((item) => item.text)).toEqual(['Valid'])
    expect(
      await createClaudeHistorySource({ configDir: path.join(f.configDir, 'absent') }).list(),
    ).toEqual([])
    await rm(f.file)
    expect(await f.source.read(session)).toEqual([])
    expect(await f.source.list()).toEqual([])
  })

  it('refuses transcript paths outside its configured history root', async () => {
    const f = await fixture([row('u1', 'user', 'Inside')])
    const session = (await f.source.list())[0]!
    const outside = path.join(f.configDir, `${SESSION}.jsonl`)
    await writeFile(outside, JSON.stringify(row('outside', 'user', 'Outside')))
    expect(await f.source.read({ ...session, locator: outside })).toEqual([])
    await rm(f.file)
    await symlink(outside, f.file)
    expect(await f.source.read(session)).toEqual([])
  })
})
