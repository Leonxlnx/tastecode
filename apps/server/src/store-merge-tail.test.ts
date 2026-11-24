import type { DomainEvent } from '@harness/contracts'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from './sqlite.js'
import { Store } from './store.js'

const stores: Store[] = []
const roots: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const THREAD = 'external:claude-code:merge'

function open(location: string) {
  const store = new Store(location)
  stores.push(store)
  return store
}

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-merge-tail-'))
  roots.push(root)
  const location = path.join(root, 'tastecode.db')
  const store = open(location)
  store.addProject(root)
  store.addThread({ id: THREAD, projectPath: root, provider: 'claude-code', title: 'Merged' })
  return { store, location }
}

/** A provider turn: prompt, a pending approval resolved or not, and how it ended. */
function turn(index: number, options: { failed?: boolean; open?: boolean; error?: boolean } = {}) {
  const turnId = `turn-${index}`
  const at = 1_000 * index
  const events: DomainEvent[] = [
    {
      type: 'turn.started',
      turn: { id: turnId, threadId: THREAD, status: 'running', createdAt: at },
    },
    {
      type: 'item.completed',
      item: {
        id: `prompt-${index}`,
        turnId,
        type: 'message',
        role: 'user',
        status: 'completed',
        text: `Prompt ${index}`,
        createdAt: at,
      },
    },
    {
      type: 'approval.requested',
      request: { id: `ask-${index}`, kind: 'command', command: `run ${index}`, createdAt: at },
    },
    {
      type: 'item.started',
      item: {
        id: `tool-${index}`,
        turnId,
        type: 'command',
        status: 'started',
        command: `run ${index}`,
        createdAt: at + 1,
      },
    },
    {
      type: 'item.completed',
      item: {
        id: `tool-${index}`,
        turnId,
        type: 'command',
        status: 'completed',
        command: `run ${index}`,
        createdAt: at + 2,
      },
    },
  ]
  if (!options.open) events.push({ type: 'approval.resolved', id: `ask-${index}` })
  if (options.error)
    events.push({ type: 'thread.error', threadId: THREAD, message: `Failure ${index}` })
  if (!options.open)
    events.push({
      type: 'turn.completed',
      turnId,
      status: options.failed ? 'failed' : 'completed',
      completedAt: at + 3,
    })
  return events.map((event, position) => ({ key: `${turnId}:${position}`, event }))
}

/** Every row the thread's history, inbox and recovery state consist of. */
function state(location: string) {
  const db = new DatabaseSync(location)
  try {
    const all = (sql: string) => db.prepare(sql).all(THREAD)
    return {
      events: all('SELECT seq, at, payload FROM events WHERE thread_id = ? ORDER BY seq'),
      links: all(
        'SELECT event_key, event_seq, active FROM provider_history_events WHERE thread_id = ? ORDER BY event_seq',
      ),
      inbox: all('SELECT * FROM inbox_events WHERE thread_id = ? ORDER BY event_seq'),
      lifecycles: all('SELECT * FROM recovery_lifecycles WHERE thread_id = ? ORDER BY 1, 2, 3'),
      errors: all('SELECT * FROM recovery_errors WHERE thread_id = ? ORDER BY event_seq'),
    }
  } finally {
    db.close()
  }
}

/** The same state rebuilt from the event log alone, as a store does after an index migration. */
function rebuilt(location: string) {
  const db = new DatabaseSync(location)
  db.prepare(
    `DELETE FROM schema_migrations WHERE name IN ('inbox_events_v2', 'recovery_lifecycles_v3')`,
  ).run()
  db.close()
  new Store(location).close()
  return state(location)
}

describe('merging a provider transcript into the store', () => {
  const history = [
    ...turn(1),
    ...turn(2, { failed: true }),
    ...turn(3, { error: true }),
    ...turn(4, { open: true }),
  ]

  it.each([
    ['an appended tail', history.slice(0, 16), history],
    ['an appended tail after a failed turn', history.slice(0, 14), history.slice(0, 22)],
    [
      'a rewritten transcript',
      history,
      // The open turn's pending approval saved again under another id.
      history.map((entry, index) =>
        index === 24 && entry.event.type === 'approval.requested'
          ? {
              ...entry,
              event: { ...entry.event, request: { ...entry.event.request, id: 'ask-4b' } },
            }
          : entry,
      ),
    ],
    ['a shrunk transcript', history, history.slice(0, 16)],
  ])(
    'leaves the same thread state as a rebuild from the event log after %s',
    (_name, first, second) => {
      const { store, location } = setup()
      store.mergeProviderHistory(THREAD, 'first', first)
      store.append(THREAD, { type: 'thread.error', threadId: THREAD, message: 'Local failure' })
      expect(store.mergeProviderHistory(THREAD, 'second', second)).toBe(true)
      store.close()
      stores.splice(stores.indexOf(store), 1)
      const merged = state(location)
      expect(merged.inbox.length + merged.lifecycles.length).toBeGreaterThan(0)
      expect(rebuilt(location)).toEqual(merged)
    },
  )
})
