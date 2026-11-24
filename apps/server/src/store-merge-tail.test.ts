import type { DomainEvent } from '@harness/contracts'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from './sqlite.js'
import { importedEvents } from './provider-history.js'
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
  const rewritten = history.map((entry, index) =>
    // The open turn's pending approval saved again under another id.
    index === 24 && entry.event.type === 'approval.requested'
      ? { ...entry, event: { ...entry.event, request: { ...entry.event.request, id: 'ask-4b' } } }
      : entry,
  )

  it.each([
    ['an appended tail', history.slice(0, 16), history],
    ['an appended tail after a failed turn', history.slice(0, 14), history.slice(0, 22)],
    ['a rewritten transcript', history, rewritten],
    ['a shrunk transcript', history, history.slice(0, 16)],
  ])(
    'leaves the same thread state as a rebuild from the event log after %s',
    (_name, first, second) => {
      const { store, location } = setup()
      seedLink(store)
      store.mergeProviderHistory(THREAD, 'first', first)
      store.append(THREAD, { type: 'thread.error', threadId: THREAD, message: 'Local failure' })
      expect(store.mergeProviderHistory(THREAD, 'second', second)).toBe(true)
      close(store)
      const merged = state(location)
      // The log itself, checked apart from the indexes: active keys, one row each, in order.
      const active = (
        merged.links as Array<{ event_key: string; event_seq: number; active: number }>
      ).filter((link) => link.active)
      expect(active.map((link) => link.event_key).sort()).toEqual(
        second.map((entry) => entry.key).sort(),
      )
      const seqs = active.map((link) => link.event_seq)
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
      expect(loadedRevision(location)).toBe('second')
      expect(merged.inbox.length + merged.lifecycles.length).toBeGreaterThan(0)
      expect(rebuilt(location)).toEqual(merged)
    },
  )

  it('rebuilds on the first change of a thread per store, and folds later appended merges', () => {
    const { store, location } = setup()
    seedLink(store)
    // A local row first, outside the inbox, for the planted row to point at.
    store.append(THREAD, {
      type: 'item.completed',
      item: {
        id: 'local',
        turnId: 'local',
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'Local',
        createdAt: 1,
      },
    })
    const merge = (revision: string, entries: typeof history) => {
      plant(location)
      store.mergeProviderHistory(THREAD, revision, entries)
      return planted(location) ? 'folded' : 'rebuilt'
    }
    expect(merge('one', history.slice(0, 7))).toBe('rebuilt')
    expect(merge('two', history.slice(0, 14))).toBe('folded')
    unplant(location)
    expect(merge('three', history.slice(0, 22))).toBe('folded')
    unplant(location)
    expect(merge('four', history)).toBe('folded')
    unplant(location)
    expect(merge('rewritten', rewritten)).toBe('rebuilt')
    expect(merge('shrunk', rewritten.slice(0, 16))).toBe('rebuilt')
    close(store)
    // A new store trusts nothing an earlier one, or another build, left behind.
    const reopened = open(location)
    expect(
      (() => {
        plant(location)
        reopened.mergeProviderHistory(THREAD, 'grown', rewritten.slice(0, 22))
        return planted(location) ? 'folded' : 'rebuilt'
      })(),
    ).toBe('rebuilt')
  })

  it('rebuilds state an older build left behind, on the first change after a restart', () => {
    const { store, location } = setup()
    seedLink(store)
    // A background agent's launcher, still running: its item stays open for recovery.
    store.append(THREAD, {
      type: 'item.completed',
      item: {
        id: 'I',
        turnId: 'T',
        type: 'tool_call',
        status: 'completed',
        createdAt: 1,
        subagent: { id: 'S', state: 'running' },
      },
    })
    close(store)
    // A build before the v3 recovery index settled every completed item, under the same marker.
    const db = new DatabaseSync(location)
    db.prepare(
      `UPDATE recovery_lifecycles SET terminal_seq = started_seq WHERE thread_id = ? AND lifecycle_key = 'item:I'`,
    ).run(THREAD)
    db.close()
    const reopened = open(location)
    reopened.mergeProviderHistory(THREAD, 'one', history.slice(0, 7))
    close(reopened)
    const merged = state(location)
    expect(rebuilt(location)).toEqual(merged)
  })

  it('rebuilds after an imported event that replay cannot read back', () => {
    const { store, location } = setup()
    seedLink(store)
    store.mergeProviderHistory(THREAD, 'one', history.slice(0, 7))
    store.append(THREAD, {
      type: 'turn.started',
      turn: { id: 'local', threadId: THREAD, status: 'running', createdAt: 50_000 },
    })
    store.append(THREAD, {
      type: 'turn.completed',
      turnId: 'local',
      status: 'failed',
      completedAt: 50_001,
    })
    // As a Codex rollout's completed_at of -1e308 arrives: a time of minus infinity, which
    // JSON stores as null.
    const rollout: DomainEvent[] = [
      {
        type: 'turn.started',
        turn: { id: 'import:T', threadId: THREAD, status: 'running', createdAt: 60_000 },
      },
      {
        type: 'item.completed',
        item: {
          id: 'import:T:prompt',
          turnId: 'import:T',
          type: 'message',
          role: 'user',
          status: 'completed',
          text: 'Imported prompt',
          createdAt: 60_000,
        },
      },
      { type: 'turn.completed', turnId: 'import:T', status: 'failed', completedAt: -Infinity },
    ]
    const imported = importedEvents(rollout, THREAD, [])
    expect(imported.length).toBeGreaterThan(0)
    store.mergeProviderHistory(THREAD, 'two', [...history.slice(0, 7), ...imported])
    close(store)
    const merged = state(location)
    expect(rebuilt(location)).toEqual(merged)
  })

  it('rebuilds after a local event that replay cannot read back', () => {
    const { store, location } = setup()
    seedLink(store)
    store.mergeProviderHistory(THREAD, 'one', history.slice(0, 7))
    store.append(THREAD, {
      type: 'turn.completed',
      turnId: 'turn-1',
      status: 'failed',
      completedAt: NaN,
    })
    store.mergeProviderHistory(THREAD, 'two', history.slice(0, 11))
    close(store)
    const merged = state(location)
    expect(rebuilt(location)).toEqual(merged)
  })
})

function close(store: Store) {
  store.close()
  stores.splice(stores.indexOf(store), 1)
}

/** The provider-history row a merge records its loaded revision on. */
function seedLink(store: Store) {
  store.saveProviderHistory('claude-code', THREAD, {
    id: 'merge',
    workspacePath: os.tmpdir(),
    title: 'Merged',
    createdAt: 1,
    updatedAt: 2,
    revision: 'first',
  })
}

function loadedRevision(location: string) {
  const db = new DatabaseSync(location)
  try {
    return (
      db.prepare('SELECT loaded_revision FROM provider_history WHERE thread_id = ?').get(THREAD) as
        { loaded_revision: string | null } | undefined
    )?.loaded_revision
  } finally {
    db.close()
  }
}

// An inbox row no event explains, a question no merge here answers: a rebuild of the thread's
// state removes it, a fold keeps it.
const PLANTED = JSON.stringify({
  type: 'approval.requested',
  request: { id: 'planted', kind: 'command', command: 'planted', createdAt: 0 },
})

function plant(location: string) {
  const db = new DatabaseSync(location)
  try {
    const { seq } = db
      .prepare('SELECT MIN(seq) AS seq FROM events WHERE thread_id = ?')
      .get(THREAD) as { seq: number | null }
    if (seq === null) throw new Error('plant needs an event of the thread')
    const at = seq
    db.prepare(
      'INSERT OR REPLACE INTO inbox_events (event_seq, thread_id, payload) VALUES (?, ?, ?)',
    ).run(at, THREAD, PLANTED)
  } finally {
    db.close()
  }
}

function planted(location: string) {
  const db = new DatabaseSync(location)
  try {
    return (
      db
        .prepare('SELECT 1 FROM inbox_events WHERE thread_id = ? AND payload = ?')
        .get(THREAD, PLANTED) !== undefined
    )
  } finally {
    db.close()
  }
}

function unplant(location: string) {
  const db = new DatabaseSync(location)
  try {
    db.prepare('DELETE FROM inbox_events WHERE thread_id = ? AND payload = ?').run(THREAD, PLANTED)
  } finally {
    db.close()
  }
}
