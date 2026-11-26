import type { DomainEvent } from '@harness/contracts'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from './sqlite.js'
import { Store } from './store.js'

// Indexes on the columns that reference events(seq). Without them every deleted
// event row scans each of these tables for the foreign-key check.
const EVENT_REFERENCE_INDEXES = [
  'recovery_lifecycles_started_seq',
  'recovery_lifecycles_terminal_seq',
  'user_submission_items_event_seq',
  'recovery_errors_event_seq',
]

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function folder() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-store-delete-'))
  roots.push(root)
  return root
}

function turn(threadId: string, n: number, open = false): DomainEvent[] {
  const turnId = `${threadId}-turn-${n}`
  const item = (id: string, extra: object) =>
    ({ id: `${turnId}-${id}`, turnId, createdAt: n, ...extra }) as never
  const events: DomainEvent[] = [
    { type: 'turn.started', turn: { id: turnId, threadId, status: 'running', createdAt: n } },
    {
      type: 'item.completed',
      item: item('user', { type: 'message', role: 'user', status: 'completed', text: `ask ${n}` }),
    },
    {
      type: 'item.started',
      item: item('command', { type: 'command', status: 'started', command: 'pnpm test' }),
    },
  ]
  if (open) return events
  events.push(
    {
      type: 'item.completed',
      item: item('command', { type: 'command', status: 'completed', command: 'pnpm test' }),
    },
    {
      type: 'item.completed',
      item: item('answer', {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: `searchable answer ${threadId} ${n}`,
      }),
    },
    {
      type: 'usage.updated',
      usage: {
        inputTokens: 10 + n,
        cachedInputTokens: 0,
        outputTokens: n,
        reasoningTokens: 0,
        totalTokens: 10 + 2 * n,
        costUsd: 0.01,
      },
    },
    { type: 'turn.completed', turnId, status: 'completed' } as DomainEvent,
  )
  return events
}

function seed(location: string, root: string) {
  const store = new Store(location)
  store.addProject(root)
  for (const id of ['keep', 'gone']) {
    store.addThread({ id, projectPath: root, provider: 'codex', title: id })
    for (let n = 0; n < 4; n++) for (const event of turn(id, n)) store.append(id, event)
    for (const event of turn(id, 9, true)) store.append(id, event)
  }
  store.addThread({
    id: 'gone-agent',
    projectPath: root,
    provider: 'codex',
    title: 'sub-agent',
    ownerThreadId: 'gone',
  })
  for (const event of turn('gone-agent', 0)) store.append('gone-agent', event)
  const session = {
    id: 'session-imported',
    workspacePath: root,
    title: 'imported',
    createdAt: 1,
    updatedAt: 2,
    revision: 'r1',
  }
  store.addProviderThread('imported', 'codex', session)
  store.saveProviderHistory('codex', 'imported', session)
  store.mergeProviderHistory(
    'imported',
    'r1',
    [...turn('imported', 0), ...turn('imported', 1)].map((event, i) => ({ key: `k${i}`, event })),
  )
  for (const id of ['keep', 'gone', 'imported']) {
    const entries = store.history(id)
    store.saveReplaySnapshot(id, entries.at(-1)!.seq, entries)
  }
  store.close()
}

function contents(location: string) {
  const db = new DatabaseSync(location)
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>
  ).map(({ name }) => name)
  const result = Object.fromEntries(
    tables
      .sort()
      .map((name) => [
        name,
        (db.prepare(`SELECT * FROM "${name}"`).all() as object[])
          .map((row) =>
            JSON.stringify(row, (_, value) => (value instanceof Uint8Array ? [...value] : value)),
          )
          .sort(),
      ]),
  )
  db.close()
  return result
}

it('deletes a chat with the event-reference indexes exactly as without them', () => {
  const root = folder()
  const indexed = path.join(root, 'indexed.db')
  const plain = path.join(root, 'plain.db')
  seed(indexed, root)
  copyFileSync(indexed, plain)

  const withIndexes = new Store(indexed)
  const without = new Store(plain)
  // The database as the previous schema left it: a second connection drops the indexes.
  const raw = new DatabaseSync(plain)
  for (const name of EVENT_REFERENCE_INDEXES) raw.exec(`DROP INDEX ${name}`)
  raw.close()

  // The delete stamps when the chat left its session; both copies get the same time.
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  for (const store of [withIndexes, without]) store.deleteThread('gone', { keepSessionOut: true })
  now.mockRestore()
  const query = (store: Store) => ({
    search: store.searchSessions({ query: 'searchable' }),
    usage: ['keep', 'imported'].map((id) => store.usageSummary(id, 0)),
    events: store.usageEvents(),
  })
  expect(query(withIndexes)).toEqual(query(without))
  expect(query(withIndexes).search.results.length).toBeGreaterThan(0)
  withIndexes.close()
  without.close()

  const after = contents(indexed)
  expect(after).toEqual(contents(plain))
  expect(after.threads.map((row) => JSON.parse(row).id).sort()).toEqual(['imported', 'keep'])
  expect(after.events.length).toBeGreaterThan(0)
})

it('adds the event-reference indexes to a database written without them', () => {
  const root = folder()
  const location = path.join(root, 'older.db')
  seed(location, root)
  const raw = new DatabaseSync(location)
  for (const name of EVENT_REFERENCE_INDEXES) raw.exec(`DROP INDEX ${name}`)
  raw.close()

  new Store(location).close()

  const db = new DatabaseSync(location)
  const plan = (sql: string) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as Array<{ detail: string }>)
      .map(({ detail }) => detail)
      .join(' ')
  expect(plan('SELECT 1 FROM recovery_lifecycles WHERE started_seq = ?')).toContain(
    'recovery_lifecycles_started_seq',
  )
  expect(plan('SELECT 1 FROM recovery_lifecycles WHERE terminal_seq = ?')).toContain(
    'recovery_lifecycles_terminal_seq',
  )
  expect(plan('SELECT 1 FROM user_submission_items WHERE event_seq = ?')).toContain(
    'user_submission_items_event_seq',
  )
  expect(plan('SELECT 1 FROM recovery_errors WHERE event_seq = ?')).toContain(
    'recovery_errors_event_seq',
  )
  db.close()
})
