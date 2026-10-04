import type { DomainEvent } from '@harness/contracts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  it('retains distinct direct API connection identities after reopening and sidebar projection', () => {
    const { store, root, location } = setup()
    for (const connectionId of ['first', 'second']) {
      store.addThread({
        id: connectionId,
        projectPath: root,
        provider: 'api',
        connectionId,
        title: connectionId,
      })
    }
    const reopened = new Store(location)
    stores.push(reopened)
    for (const connectionId of ['first', 'second']) {
      expect(reopened.thread(connectionId)).toMatchObject({ provider: 'api', connectionId })
      expect(reopened.sidebarThreads().find((thread) => thread.id === connectionId)).toMatchObject({
        connectionId,
      })
    }
    expect(reopened.thread('thread')?.connectionId).toBeUndefined()
  })

  it('keeps nightly usage history available through the indexed event log', () => {
    const { store, root, location } = setup()
    store.addThread({
      id: 'api',
      projectPath: root,
      provider: 'api',
      connectionId: 'first',
      title: 'API',
    })
    store.append('thread', message('ordinary message'))
    store.append('thread', {
      type: 'usage.updated',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        totalTokens: 30,
      },
    })
    store.append('api', {
      type: 'usage.updated',
      usage: {
        inputTokens: 30,
        cachedInputTokens: 0,
        outputTokens: 40,
        reasoningTokens: 0,
        totalTokens: 70,
      },
    })
    const reopened = new Store(location)
    stores.push(reopened)
    expect(
      reopened
        .usageEvents()
        .map(({ threadId, provider, usage }) => ({ threadId, provider, usage })),
    ).toEqual([
      {
        threadId: 'api',
        provider: 'api',
        usage: {
          inputTokens: 30,
          cachedInputTokens: 0,
          outputTokens: 40,
          reasoningTokens: 0,
          totalTokens: 70,
        },
      },
      {
        threadId: 'thread',
        provider: 'codex',
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
          totalTokens: 30,
        },
      },
    ])
  })

  it.each(['before', 'between'])(
    'fills search pages after removing a project %s page requests',
    (when) => {
      const { store, root } = setup()
      const removed = path.join(root, 'removed')
      store.addProject(removed)
      store.addThread({ id: 'removed', projectPath: removed, provider: 'codex', title: 'Removed' })
      for (let index = 0; index < 12; index += 1) {
        store.append(index % 3 === 0 ? 'thread' : 'removed', message('needle', index))
      }
      if (when === 'before') store.removeProject(removed)
      const first = store.searchSessions({ query: 'needle', limit: 2 })
      if (when === 'between') store.removeProject(removed)
      const results = [...first.results]
      let cursor = first.nextCursor
      while (cursor) {
        const page = store.searchSessions({ query: 'needle', limit: 2, cursor })
        expect(page.results.length).toBeGreaterThan(0)
        results.push(...page.results)
        cursor = page.nextCursor
      }
      expect(results.filter((result) => result.threadId === 'thread')).toHaveLength(4)
      expect(new Set(results.map((result) => result.resultId)).size).toBe(results.length)
    },
  )

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

  it('archives provider import metadata and active membership before pruning', () => {
    const { store, root } = setup()
    store.saveProviderHistory('codex', 'thread', {
      id: 'native',
      workspacePath: root,
      title: 'Native',
      createdAt: 1,
      updatedAt: 2,
      revision: 'new',
    })
    store.mergeProviderHistory('thread', 'old', [{ key: 'old', event: message('retired') }])
    store.mergeProviderHistory('thread', 'new', [{ key: 'new', event: message('visible') }])
    store.closeThread('thread')
    const archive = path.join(root, 'archive.ndjson')
    expect(store.pruneHistory(Date.now() + 1_000, archive)).toBe(1)
    const rows = readFileSync(archive, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows[0]).toMatchObject({ format: 'tastecode-history', version: 2 })
    expect(rows.filter((entry) => entry.table === 'provider_history')).toEqual([
      expect.objectContaining({
        row: expect.objectContaining({ thread_id: 'thread', loaded_revision: 'new' }),
      }),
    ])
    expect(
      rows
        .filter((entry) => entry.table === 'provider_history_events')
        .map((entry) => entry.row.active),
    ).toEqual([0, 1])
    // Provider identities remain tombstones after local deletion.
    expect(store.providerHistories()).toHaveLength(1)
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
