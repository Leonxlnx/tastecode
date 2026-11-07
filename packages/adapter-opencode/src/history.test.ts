import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenCodeHistorySource } from './history.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opencode-history-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

/** The tables OpenCode 2.2.1 writes, narrowed to what the reader uses. */
function database() {
  const db = new DatabaseSync(path.join(root, 'opencode.db'))
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  return db
}

/** The tables builds before 2.x wrote. */
function legacyDatabase() {
  const db = new DatabaseSync(path.join(root, 'opencode.db'))
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      data TEXT NOT NULL);
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);
  `)
  return db
}

const items = (
  events: Awaited<ReturnType<ReturnType<typeof createOpenCodeHistorySource>['read']>>,
) => events.flatMap((event) => (event.type === 'item.completed' ? [event.item] : []))

describe('OpenCode history', () => {
  it('is absent until OpenCode has a database here', async () => {
    const source = createOpenCodeHistorySource({ root })
    expect(source.present()).toBe(false)
    await expect(source.list()).resolves.toEqual([])
  })

  it('lists top-level chats with a prompt and leaves out sub-agent runs', async () => {
    const db = database()
    const insert = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, 1000, 2000, ?)')
    insert.run('ses_a', null, '/work/site', 'Fix the footer', null)
    insert.run('ses_child', 'ses_a', '/work/site', 'Sub-agent', null)
    insert.run('ses_blank', null, '/work/site', 'Never used', null)
    insert.run('ses_old', null, '/work/site', 'Archived', 3000)
    const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, 1000, ?)')
    message.run('m1', 'ses_a', 'user', 1, '{"text":"Hello"}')
    message.run('m2', 'ses_child', 'user', 1, '{"text":"Task"}')
    message.run('m3', 'ses_old', 'user', 1, '{"text":"Old"}')
    db.close()

    const sessions = await createOpenCodeHistorySource({ root }).list()
    expect(sessions.map(({ id, archived }) => [id, archived])).toEqual([
      ['ses_a', undefined],
      ['ses_old', true],
    ])
  })

  it('maps the parts of a 2.x conversation to transcript items', async () => {
    const db = database()
    db.prepare('INSERT INTO session_v2 VALUES (?, NULL, ?, ?, 1000, 2000, NULL)').run(
      'ses_a',
      '/work/site',
      'Fix the footer',
    )
    const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)')
    message.run('s0', 'ses_a', 'system', 0, 900, '{"text":"You are a coding agent"}')
    message.run('m1', 'ses_a', 'user', 1, 1000, '{"text":"Fix the footer"}')
    message.run(
      'm2',
      'ses_a',
      'assistant',
      2,
      1100,
      JSON.stringify({
        content: [
          { type: 'reasoning', text: 'Looking at it', time: { created: 1101 } },
          {
            id: 'call_1',
            type: 'tool',
            name: 'bash',
            time: { created: 1102 },
            state: {
              status: 'completed',
              input: { command: 'pnpm test' },
              content: [{ type: 'text', text: 'passed' }],
            },
          },
          {
            id: 'call_2',
            type: 'tool',
            name: 'edit',
            state: { status: 'completed', input: { filePath: 'src/footer.tsx' }, content: [] },
          },
          {
            id: 'call_3',
            type: 'tool',
            name: 'grep',
            state: {
              status: 'error',
              input: { pattern: 'footer' },
              content: [{ type: 'text', text: 'no matches' }],
            },
          },
          { type: 'text', text: 'Fixed it.' },
        ],
      }),
    )
    message.run(
      'm3',
      'ses_a',
      'assistant',
      3,
      1200,
      JSON.stringify({ content: [], error: { message: 'Rate limited', type: 'api' } }),
    )
    db.close()

    const source = createOpenCodeHistorySource({ root })
    const [session] = await source.list()
    const events = await source.read(session!)
    expect(events[0]).toMatchObject({ type: 'thread.started', thread: { provider: 'opencode' } })
    expect(items(events)).toMatchObject([
      { type: 'message', role: 'user', text: 'Fix the footer' },
      { type: 'reasoning', text: 'Looking at it' },
      { type: 'command', command: 'pnpm test', text: 'passed', status: 'completed' },
      { type: 'file_change', path: 'src/footer.tsx' },
      { type: 'tool_call', status: 'failed', text: 'grep\n{"pattern":"footer"}\nno matches' },
      { type: 'message', role: 'assistant', text: 'Fixed it.' },
      { type: 'error', text: 'Rate limited' },
    ])
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', status: 'failed' })
  })

  it('reads the tables of a build from before 2.x', async () => {
    const db = legacyDatabase()
    db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, 1000, 2000, NULL)').run(
      'ses_a',
      '/work/site',
      'Fix the footer',
    )
    const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
    message.run('m1', 'ses_a', 1000, '{"role":"user"}')
    message.run('m2', 'ses_a', 1100, '{"role":"assistant"}')
    const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
    part.run('p1', 'm1', 'ses_a', '{"type":"text","text":"Fix the footer"}')
    part.run('p2', 'm2', 'ses_a', '{"type":"step-start"}')
    part.run(
      'p3',
      'm2',
      'ses_a',
      JSON.stringify({
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'ls' }, output: 'src' },
      }),
    )
    part.run('p4', 'm2', 'ses_a', '{"type":"text","text":"Done."}')
    db.close()

    const source = createOpenCodeHistorySource({ root })
    const [session] = await source.list()
    expect(items(await source.read(session!))).toMatchObject([
      { type: 'message', role: 'user', text: 'Fix the footer' },
      { type: 'command', command: 'ls', text: 'src' },
      { type: 'message', role: 'assistant', text: 'Done.' },
    ])
  })

  it('reads the older tables of a 1.x build that already has an empty session_message', async () => {
    const db = legacyDatabase()
    // OpenCode 1.14.19 on Windows: the 2.x table exists, but every message is in the old ones.
    db.exec(`
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, 1000, 2000, NULL)').run(
      'ses_a',
      '/work/site',
      'Fix the footer',
    )
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      'm1',
      'ses_a',
      1000,
      '{"role":"user"}',
    )
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(
      'p1',
      'm1',
      'ses_a',
      '{"type":"text","text":"Fix the footer"}',
    )
    db.close()

    const source = createOpenCodeHistorySource({ root })
    const [session] = await source.list()
    expect(items(await source.read(session!))).toMatchObject([
      { type: 'message', role: 'user', text: 'Fix the footer' },
    ])
  })

  it('lists the older tables of a database whose session_v2 is still empty', async () => {
    const db = legacyDatabase()
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    `)
    db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, 1000, 2000, NULL)').run(
      'ses_a',
      '/work/site',
      'Fix the footer',
    )
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      'm1',
      'ses_a',
      1000,
      '{"role":"user"}',
    )
    db.close()

    const sessions = await createOpenCodeHistorySource({ root }).list()
    expect(sessions.map(({ id }) => id)).toEqual(['ses_a'])
  })

  it('returns nothing for a session that is gone', async () => {
    database().close()
    const source = createOpenCodeHistorySource({ root })
    await expect(
      source.read({
        id: 'ses_gone',
        workspacePath: '/work/site',
        title: '',
        createdAt: 1,
        updatedAt: 1,
        revision: '1',
      }),
    ).resolves.toEqual([])
  })
})
