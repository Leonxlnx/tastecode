import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DomainEventSchema, type DomainEvent } from '@harness/contracts'
import { createCodexHistorySource } from './history.js'

const roots: string[] = []
const at = '2026-09-15T10:00:00.000Z'
const record = (type: string, payload: unknown, timestamp = at) => ({ type, timestamp, payload })
const response = (payload: unknown) => record('response_item', payload)
const event = (payload: unknown) => record('event_msg', payload)
const rich = (item: unknown, turn_id = 'turn-one') =>
  event({ type: 'item_completed', turn_id, item, started_at_ms: Date.parse(at) })
const items = (events: DomainEvent[]) =>
  events.flatMap((entry) => (entry.type === 'item.completed' ? [entry.item] : []))

async function store(records: unknown[], archived = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-history-'))
  roots.push(root)
  const directory = path.join(root, archived ? 'archived_sessions' : 'sessions', '2026', '09', '15')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'rollout-native-session.jsonl')
  await writeFile(
    file,
    [record('session_meta', { id: 'native-session', cwd: '/project', timestamp: at }), ...records]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  )
  return { root, file, source: createCodexHistorySource({ codexHome: root }) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('native Codex history', () => {
  it('bounds native prompt previews and hashes revisions without truncating chat content', async () => {
    const prompt = 'Full user prompt '.repeat(7000)
    const { root, file, source } = await store([event({ type: 'user_message', message: prompt })])
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
    db.exec(
      'CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, preview TEXT, name TEXT, created_at INTEGER, updated_at INTEGER)',
    )
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'native-session',
      file,
      '/project',
      prompt,
      `Current preview ${prompt}`,
      null,
      1,
      2,
    )
    db.close()
    const session = (await source.list())[0]!
    expect(session.title).toBe(`Current preview ${prompt}`.slice(0, 200).trim())
    expect(session.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(session).length).toBeLessThan(1200)
    expect(items(await source.read(session))[0]?.text).toBe(prompt)
  })

  it('uses current native names and newer sidecar renames instead of prompt titles', async () => {
    const { root, file, source } = await store([])
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
    db.exec(
      'CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, created_at INTEGER, updated_at INTEGER)',
    )
    const now = Date.parse(at)
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'native-session',
      file,
      '/project',
      'Original user prompt',
      'Current native name',
      now / 1000,
      now / 1000 + 20,
    )
    const sidecar = (thread_name: string, offset: number) =>
      JSON.stringify({
        id: 'native-session',
        thread_name,
        updated_at: new Date(now + offset).toISOString(),
      })
    await writeFile(path.join(root, 'session_index.jsonl'), `${sidecar('Old index name', 10000)}\n`)
    const initial = (await source.list())[0]!
    expect(initial.title).toBe('Current native name')
    db.prepare('UPDATE threads SET name = ?').run('Renamed in the provider')
    const renamed = (await source.list())[0]!
    expect(renamed.title).toBe('Renamed in the provider')
    expect(renamed.revision).not.toBe(initial.revision)
    await writeFile(
      path.join(root, 'session_index.jsonl'),
      `${sidecar('New index name', 30000)}\n${sidecar('Stale appended name', 5000)}\n`,
    )
    expect((await source.list())[0]!.title).toBe('New index name')
    db.prepare('UPDATE threads SET name = NULL, updated_at = ?').run(now / 1000 + 40)
    expect((await source.list())[0]!.title).toBe('New index name')
    db.close()
  })

  it('uses the name index with older schemas and bounds metadata-only fallback titles', async () => {
    const { root, file, source } = await store([])
    const db = new DatabaseSync(path.join(root, 'state_4.sqlite'))
    db.exec(
      'CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER)',
    )
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(
      'native-session',
      file,
      '/project',
      'Prompt text '.repeat(5000),
      1,
      9999999999,
    )
    db.close()
    await writeFile(
      path.join(root, 'session_index.jsonl'),
      `${JSON.stringify({ id: 'native-session', thread_name: 'User chosen name', updated_at: at })}\n`,
    )
    expect((await source.list())[0]!.title).toBe('User chosen name')
    await rm(path.join(root, 'state_4.sqlite'))
    await rm(path.join(root, 'session_index.jsonl'))
    await writeFile(
      file,
      `${JSON.stringify(record('session_meta', { id: 'native-session', cwd: '/project', title: 'Header preview '.repeat(5000), timestamp: at }))}\n`,
    )
    const fallback = (await source.list())[0]!
    expect(fallback.title.length).toBeLessThanOrEqual(200)
    expect(fallback.revision.length).toBe(64)
  })

  it('discovers active, archived, indexed, and unindexed sessions without changing the native store', async () => {
    const { root, file, source } = await store([], true)
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
    db.exec(
      'CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)',
    )
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'native-session',
      file,
      '/project',
      'Saved title',
      1,
      2,
      Date.parse(at),
      Date.parse(at) + 7,
    )
    db.close()
    const before = await readFile(path.join(root, 'state_5.sqlite'))
    const session = (await source.list())[0]
    expect(session).toMatchObject({
      id: 'native-session',
      title: 'Saved title',
      archived: true,
      createdAt: Date.parse(at),
    })
    expect(await readFile(path.join(root, 'state_5.sqlite'))).toEqual(before)
    expect(await source.read({ ...session!, locator: '/etc/passwd' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'thread.started' })]),
    )
    expect(await source.read({ ...session!, id: 'not-discovered', locator: file })).toEqual([])

    const directory = path.join(root, 'sessions')
    await mkdir(directory)
    await writeFile(
      path.join(directory, 'extra.jsonl'),
      JSON.stringify(record('session_meta', { id: 'unindexed', cwd: '/another', timestamp: at })),
    )
    expect((await source.list()).map((entry) => entry.id).sort()).toEqual([
      'native-session',
      'unindexed',
    ])
  })

  it('preserves native rich messages, reasoning, command output, files, tools, images, and turn IDs once', async () => {
    const markdown = '  # Hello\n\n```ts\nconst x = 1\n```\n'
    const image = 'data:image/png;base64,iVBORw0KGgo='
    const { source } = await store([
      event({ type: 'task_started', turn_id: 'turn-one' }),
      response({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'private configuration' }],
      }),
      response({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'injected environment' }],
      }),
      event({ type: 'user_message', message: 'Actual user', local_images: ['/project/shot.png'] }),
      rich({
        type: 'UserMessage',
        id: 'user-one',
        content: [
          { type: 'text', text: 'Actual user' },
          { type: 'image', image_url: image },
        ],
      }),
      rich({
        type: 'Reasoning',
        id: 'reasoning-one',
        summary_text: ['A thought\n\n'],
        raw_content: [],
      }),
      response({
        type: 'reasoning',
        id: 'reasoning-one',
        summary: [{ type: 'summary_text', text: 'A thought\n\n' }],
        encrypted_content: 'opaque',
      }),
      response({
        type: 'function_call',
        call_id: 'command-one',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}',
      }),
      rich({
        type: 'CommandExecution',
        id: 'command-one',
        command: ['pwd'],
        aggregated_output: '/project\n',
        exit_code: 0,
        duration: { secs: 1, nanos: 500000000 },
      }),
      response({
        type: 'function_call_output',
        call_id: 'command-one',
        output: 'duplicate output',
      }),
      rich({
        type: 'FileChange',
        id: 'files-one',
        changes: {
          'a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' },
          'b.ts': { type: 'add', content: 'new file\n' },
        },
      }),
      rich({
        type: 'McpToolCall',
        id: 'mcp-one',
        server: 'images',
        tool: 'preview',
        arguments: { size: 1 },
        result: {
          content: [
            { type: 'text', text: 'tool result\n' },
            { type: 'image', data: 'YWJj', mimeType: 'image/png' },
          ],
        },
      }),
      response({
        type: 'message',
        id: 'answer-one',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: markdown }],
      }),
      rich({
        type: 'AgentMessage',
        id: 'answer-one',
        phase: 'final_answer',
        content: [{ type: 'text', text: markdown }],
      }),
      event({ type: 'agent_message', phase: 'final_answer', message: markdown }),
      event({ type: 'task_complete', turn_id: 'turn-one', completed_at: Date.parse(at) + 3000 }),
    ])
    const session = (await source.list())[0]!
    const events = await source.read(session)
    events.forEach((entry) => expect(DomainEventSchema.safeParse(entry).success).toBe(true))
    expect(events).toEqual(await source.read(session))
    expect(items(events).filter((entry) => entry.type === 'message')).toEqual([
      expect.objectContaining({ id: 'user-one', text: 'Actual user', attachments: [image] }),
      expect.objectContaining({ id: 'answer-one', text: markdown, phase: 'final_answer' }),
    ])
    expect(items(events).filter((entry) => entry.type === 'reasoning')).toHaveLength(1)
    expect(items(events).filter((entry) => entry.type === 'command')).toEqual([
      expect.objectContaining({
        command: 'pwd',
        text: '/project\n',
        exitCode: 0,
        durationMs: 1500,
      }),
    ])
    expect(items(events).filter((entry) => entry.type === 'file_change')).toHaveLength(2)
    expect(items(events).find((entry) => entry.id === 'mcp-one')).toMatchObject({
      attachments: ['data:image/png;base64,YWJj'],
      text: expect.stringContaining('tool result\n'),
    })
    expect(events.find((entry) => entry.type === 'diff.updated')).toMatchObject({
      diff: expect.stringContaining('-old\n+new\n'),
    })
    expect(events.at(-1)).toEqual({
      type: 'turn.completed',
      turnId: 'turn-one',
      status: 'completed',
      completedAt: Date.parse(at) + 3000,
    })
  })

  it('reads older response/event transcripts and preserves repeated messages and separate turns', async () => {
    const { source } = await store([
      response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First' }] }),
      record('turn_context', { turn_id: 'old-turn' }),
      event({ type: 'user_message', message: 'First', local_images: ['/project/image.png'] }),
      response({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Same' }],
      }),
      event({ type: 'agent_message', message: 'Same' }),
      response({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Same' }],
      }),
      event({ type: 'agent_message', message: 'Same' }),
      response({
        type: 'function_call',
        call_id: 'shell',
        name: 'functions.exec_command',
        arguments: '{"cmd":"false"}',
      }),
      response({
        type: 'function_call_output',
        call_id: 'shell',
        output: '{"output":"failed\\n","exit_code":1}',
      }),
      event({ type: 'task_complete', turn_id: 'old-turn' }),
      event({ type: 'task_started', turn_id: 'second-turn' }),
      event({ type: 'user_message', message: 'Next' }),
      event({ type: 'agent_reasoning', text: 'Open thought' }),
      event({ type: 'turn_aborted', turn_id: 'second-turn' }),
    ])
    const events = await source.read((await source.list())[0]!)
    expect(
      events.filter((entry) => entry.type === 'turn.started').map((entry) => entry.turn.id),
    ).toEqual(['old-turn', 'second-turn'])
    expect(items(events).filter((entry) => entry.text === 'Same')).toHaveLength(2)
    expect(items(events).find((entry) => entry.text === 'First')).toMatchObject({
      attachments: ['/project/image.png'],
    })
    expect(items(events).find((entry) => entry.type === 'command')).toMatchObject({
      text: 'failed\n',
      exitCode: 1,
      status: 'failed',
    })
    expect(events.at(-1)).toMatchObject({ turnId: 'second-turn', status: 'interrupted' })
  })

  it('isolates corrupt rows, corrupt indexes, missing stores, and unfinished writes', async () => {
    const { root, file, source } = await store([
      event({ type: 'task_started', turn_id: 'turn-one' }),
      event({ type: 'user_message', message: 'Keep this' }),
      response({ type: 'reasoning', encrypted_content: 'not readable' }),
    ])
    await writeFile(path.join(root, 'state_99.sqlite'), 'not sqlite')
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}malformed row\n${JSON.stringify(event({ type: 'agent_message', message: 'Still readable' }))}\n{"partial":`,
    )
    await writeFile(path.join(root, 'sessions', 'bad.jsonl'), 'broken')
    const listed = await source.list()
    expect(listed).toHaveLength(1)
    const events = await source.read(listed[0]!)
    expect(items(events).map((entry) => entry.text)).toEqual(['Keep this', 'Still readable'])
    expect(events.at(-1)).toMatchObject({ status: 'interrupted' })
    expect(
      await createCodexHistorySource({ codexHome: path.join(root, 'missing') }).list(),
    ).toEqual([])
  })

  it('refreshes changed transcripts and sidecar names while retaining earlier item IDs', async () => {
    const { root, file, source } = await store([event({ type: 'user_message', message: 'One' })])
    await writeFile(
      path.join(root, 'session_index.jsonl'),
      `${JSON.stringify({ id: 'native-session', thread_name: 'Named chat', updated_at: at })}\n`,
    )
    const first = (await source.list())[0]!
    const previous = items(await source.read(first))[0]!
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}${JSON.stringify(event({ type: 'agent_message', message: 'Two' }))}\n`,
    )
    const second = (await source.list())[0]!
    expect(second.title).toBe('Named chat')
    expect(second.revision).not.toBe(first.revision)
    expect(items(await source.read(second))[0]!.id).toBe(previous.id)
  })

  it('does not let malformed rich items hide other messages and preserves unknown future items', async () => {
    const { source } = await store([
      event({ type: 'task_started', turn_id: 'turn-one' }),
      rich({ type: 'FutureActivity', description: 'Future details' }),
      response({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Keep this answer' }],
      }),
      rich({ type: 'Reasoning', id: 'reasoning', summary_text: ['First', 'Second'] }),
      rich({
        type: 'FileChange',
        id: 'added',
        changes: { 'new.ts': { type: 'add', content: 'one\ntwo\n' } },
      }),
    ])
    const events = await source.read((await source.list())[0]!)
    expect(items(events).find((entry) => entry.type === 'message')?.text).toBe('Keep this answer')
    expect(items(events).find((entry) => entry.type === 'unknown')?.text).toContain(
      'Future details',
    )
    expect(items(events).find((entry) => entry.type === 'reasoning')?.text).toBe('First\n\nSecond')
    expect(items(events).find((entry) => entry.type === 'file_change')).toMatchObject({
      linesAdded: 2,
      text: '@@ -0,0 +1,2 @@\n+one\n+two\n',
    })
  })

  it('keeps late native activities in their completed turn without duplicating the turn', async () => {
    const { source } = await store([
      event({ type: 'task_started', turn_id: 'turn-one' }),
      rich({ type: 'UserMessage', id: 'user', content: [{ type: 'text', text: 'Start' }] }),
      event({ type: 'task_complete', turn_id: 'turn-one' }),
      rich({ type: 'SubAgentActivity', id: 'late', kind: 'interacted' }),
      event({ type: 'user_message', message: 'Next turn' }),
      record('turn_context', { turn_id: 'turn-two' }),
    ])
    const events = await source.read((await source.list())[0]!)
    expect(
      events.filter((entry) => entry.type === 'turn.started').map((entry) => entry.turn.id),
    ).toEqual(['turn-one', 'turn-two'])
    expect(items(events).find((entry) => entry.id === 'late')?.turnId).toBe('turn-one')
  })
})
