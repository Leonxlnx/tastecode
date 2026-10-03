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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-store-persistence-'))
  roots.push(root)
  const location = path.join(root, 'tastecode.db')
  const store = new Store(location)
  stores.push(store)
  store.addProject(root)
  store.addThread({ id: 'thread', projectPath: root, provider: 'codex', title: 'Saved' })
  return { store, root, location }
}

const message = (text: string, createdAt = 1): DomainEvent => ({
  type: 'item.completed',
  item: {
    id: text,
    turnId: 'turn',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt,
  },
})

describe('durable history ownership', () => {
  it('restores imported membership without reviving retired branches or localizing imports', () => {
    const { store, root, location } = setup()
    store.saveProviderHistory('codex', 'thread', {
      id: 'native',
      workspacePath: root,
      title: 'Native',
      createdAt: 1,
      updatedAt: 2,
      revision: 'latest',
    })
    store.append('thread', message('local'))
    const seq = store.lastSeq('thread')
    store.mergeProviderHistory('thread', 'old', [{ key: 'old', event: message('retired') }])
    store.mergeProviderHistory('thread', 'latest', [{ key: 'new', event: message('visible') }])
    const before = store.history('thread')
    const token = store.saveRestoreUndo('thread', seq, 'a'.repeat(40))
    store.applyRestoreUndo('thread', token)
    expect(store.history('thread')).toEqual(before)
    expect(store.localHistory('thread').map(({ event }) => event)).toEqual([message('local')])
    expect(store.searchSessions({ query: 'retired' }).results).toEqual([])
    expect(store.searchSessions({ query: 'visible' }).results).toHaveLength(1)
    const raw = new DatabaseSync(location)
    try {
      expect(
        raw
          .prepare('SELECT event_key, active FROM provider_history_events ORDER BY event_seq')
          .all(),
      ).toEqual([
        { event_key: 'old', active: 0 },
        { event_key: 'new', active: 1 },
      ])
    } finally {
      raw.close()
    }
  })

  it('retains checkpoints and undo tails for providers absent from this build', () => {
    const { store, root, location } = setup()
    const seq = store.append('thread', message('first'))
    store.addCheckpoint({ threadId: 'thread', seq, commit: 'a'.repeat(40), label: 'first' })
    const tail = store.append('thread', message('second'))
    store.addCheckpoint({ threadId: 'thread', seq: tail, commit: 'b'.repeat(40), label: 'second' })
    store.saveRestoreUndo('thread', seq, 'c'.repeat(40))
    const raw = new DatabaseSync(location)
    try {
      raw.prepare('UPDATE threads SET provider = ? WHERE id = ?').run('nightly-only', 'thread')
    } finally {
      raw.close()
    }
    const reopened = new Store(location)
    stores.push(reopened)
    expect(reopened.checkpointReferences()).toEqual([
      {
        threadId: 'thread',
        projectPath: root,
        commits: new Set(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]),
      },
    ])
  })
})
