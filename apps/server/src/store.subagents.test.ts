import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { DatabaseSync } from './sqlite.js'
import { Store } from './store.js'
import type { StoredSubagentRun } from './subagent-runs.js'

const message = (text: string): DomainEvent => ({
  type: 'item.completed',
  item: {
    id: `i-${text}`,
    turnId: 't1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt: 0,
  },
})

const run = (change: Partial<StoredSubagentRun> = {}): StoredSubagentRun => ({
  itemId: 'subagent-1',
  parentThreadId: 'main',
  shortId: 'a1',
  turnId: 't1',
  threadId: 'child',
  provider: 'codex',
  model: 'gpt-5.5',
  task: 'Write the tests',
  state: 'running',
  snapshot: { id: 'a1', state: 'running', threadId: 'child', provider: 'codex' },
  createdAt: 10,
  ...change,
})

function seed(store: Store): void {
  store.addProject('/repo')
  store.addThread({ id: 'main', projectPath: '/repo', provider: 'claude-code', title: 'Main' })
  store.addThread({
    id: 'child',
    projectPath: '/repo',
    provider: 'codex',
    title: 'Write the tests',
    ephemeral: true,
    ownerThreadId: 'main',
  })
  store.append('child', message('private sub-agent answer'))
}

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'harness-subagents-'))
  file = path.join(dir, 'harness.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('sub-agent chats in the store', () => {
  it('keeps a sub-agent chat addressable but out of every chat list and search', () => {
    const store = new Store(':memory:')
    seed(store)
    expect(store.thread('child')).toMatchObject({ ephemeral: true, ownerThreadId: 'main' })
    expect(store.thread('child')).not.toHaveProperty('parentThreadId')
    expect(store.history('child')).toHaveLength(1)
    expect(store.threads().map((thread) => thread.id)).toEqual(['main'])
    expect(store.threads('/repo').map((thread) => thread.id)).toEqual(['main'])
    expect(store.sidebarThreads().map((thread) => thread.id)).toEqual(['main'])
    expect(store.inactiveThreadCandidates(Date.now() + 1_000).map(({ id }) => id)).toEqual(['main'])
    expect(store.searchSessions({ query: 'private sub-agent answer' }).results).toEqual([])
    expect(store.ownedThreadIds('main')).toEqual(['child'])
    expect(store.ownedThreadIds('child')).toEqual([])
    store.close()
  })

  it('keeps a sub-agent chat across a restart, still unlisted and unsearched, and drops Side chats', () => {
    const seeded = new Store(file)
    seed(seeded)
    seeded.addThread({
      id: 'side',
      projectPath: '/repo',
      provider: 'claude-code',
      title: 'Side chat',
      ephemeral: true,
      parentThreadId: 'main',
    })
    seeded.subagents.add(run())
    seeded.close()

    const reopened = new Store(file)
    try {
      expect(reopened.thread('side')).toBeUndefined()
      expect(reopened.thread('child')).toMatchObject({ ownerThreadId: 'main' })
      expect(reopened.history('child')).toHaveLength(1)
      expect(reopened.sidebarThreads().map((thread) => thread.id)).toEqual(['main'])
      reopened.append('child', message('answer after restart'))
      expect(reopened.searchSessions({ query: 'answer after restart' }).results).toEqual([])
      expect(reopened.subagents.ofParent('main')).toEqual([run()])
    } finally {
      reopened.close()
    }
  })

  it('records runs, newest first, and changes only the fields given', () => {
    const store = new Store(':memory:')
    seed(store)
    store.subagents.add(run())
    store.subagents.add(
      run({
        itemId: 'subagent-2',
        shortId: 'a2',
        threadId: undefined,
        state: 'waiting_for_approval',
        snapshot: { id: 'a2', state: 'running', attention: 'approval' },
        createdAt: 20,
      }),
    )
    expect(store.subagents.ofParent('main').map((entry) => entry.shortId)).toEqual(['a2', 'a1'])
    expect(store.subagents.forThread('child')?.shortId).toBe('a1')
    store.subagents.update('subagent-1', {
      state: 'completed',
      result: 'Done: 3 tests',
      finishedAt: 30,
      snapshot: { id: 'a1', state: 'completed', threadId: 'child', provider: 'codex' },
    })
    expect(store.subagents.get('subagent-1')).toMatchObject({
      state: 'completed',
      result: 'Done: 3 tests',
      finishedAt: 30,
      model: 'gpt-5.5',
      task: 'Write the tests',
    })
    expect(() => store.subagents.add(run({ itemId: 'subagent-3' }))).toThrow()
    store.close()
  })

  it('settles runs a previous process left unfinished as interrupted', () => {
    const store = new Store(':memory:')
    seed(store)
    store.subagents.add(run({ snapshot: { id: 'a1', state: 'running', background: true } }))
    store.subagents.add(
      run({
        itemId: 'subagent-2',
        shortId: 'a2',
        threadId: undefined,
        state: 'waiting_for_approval',
        snapshot: { id: 'a2', state: 'running', attention: 'approval' },
      }),
    )
    store.subagents.add(
      run({
        itemId: 'subagent-3',
        shortId: 'a3',
        threadId: 'other',
        state: 'completed',
        snapshot: { id: 'a3', state: 'completed' },
        finishedAt: 5,
      }),
    )
    const settled = store.subagents.interruptUnfinished(99)
    expect(settled.map((entry) => [entry.shortId, entry.state, entry.snapshot])).toEqual([
      ['a1', 'interrupted', { id: 'a1', state: 'interrupted', background: false }],
      ['a2', 'interrupted', { id: 'a2', state: 'interrupted', background: false }],
    ])
    expect(store.subagents.get('subagent-3')?.state).toBe('completed')
    expect(store.subagents.interruptUnfinished(100)).toEqual([])
    store.close()
  })

  it('deletes a chat’s sub-agent chats and runs with it', () => {
    const store = new Store(':memory:')
    seed(store)
    store.subagents.add(run())
    store.deleteThread('main')
    expect(store.thread('main')).toBeUndefined()
    expect(store.thread('child')).toBeUndefined()
    expect(store.history('child')).toEqual([])
    expect(store.subagents.ofParent('main')).toEqual([])
    store.close()
  })

  it('adds the owner column to a database written before it existed', () => {
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'main', projectPath: '/repo', provider: 'codex', title: 'Main' })
    seeded.close()
    const old = new DatabaseSync(file)
    old.exec('DROP INDEX threads_by_owner; ALTER TABLE threads DROP COLUMN owner_thread_id')
    old.close()
    const reopened = new Store(file)
    try {
      reopened.addThread({
        id: 'child',
        projectPath: '/repo',
        provider: 'codex',
        title: 'Child',
        ephemeral: true,
        ownerThreadId: 'main',
      })
      expect(reopened.ownedThreadIds('main')).toEqual(['child'])
    } finally {
      reopened.close()
    }
  })
})
