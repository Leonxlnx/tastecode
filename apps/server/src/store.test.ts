import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ItemTypeSchema,
  type DiffDecision,
  type DomainEvent,
  type ItemType,
} from '@harness/contracts'
import { Store } from './store.js'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
})

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

const usage = (totalTokens: number, costUsd?: number, cumulative = false): DomainEvent => ({
  type: 'usage.updated',
  usage: {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    ...(cumulative ? { cumulative: true } : {}),
    ...(costUsd === undefined ? {} : { costUsd }),
  },
})

const lifecycleItem = (
  id: string,
  turnId: string,
  type: ItemType,
  status: 'started' | 'completed' = 'started',
): DomainEvent => ({
  type: status === 'started' ? 'item.started' : 'item.completed',
  item: { id, turnId, type, status, text: `${status} ${type}`, createdAt: 2 },
})

const userInput = (id: string, turnId: string): DomainEvent => ({
  type: 'user_input.requested',
  request: {
    id,
    turnId,
    questions: [
      {
        id: 'choice',
        header: 'Choice',
        question: 'Continue?',
        allowOther: false,
        secret: false,
        options: [{ label: 'Yes', description: 'Continue the work.' }],
      },
    ],
    autoResolutionMs: null,
    createdAt: 3,
  },
})

describe('ephemeral Side chats', () => {
  it('keeps Side chats addressable without listing or indexing them', () => {
    store.addProject('/repo')
    store.addThread({ id: 'main', projectPath: '/repo', provider: 'codex', title: 'Main' })
    store.addThread({
      id: 'side',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Side chat',
      ephemeral: true,
      parentThreadId: 'main',
    })
    store.append('side', message('private side answer'))

    expect(store.thread('side')).toMatchObject({ ephemeral: true, parentThreadId: 'main' })
    expect(store.threads('/repo').map((thread) => thread.id)).toEqual(['main'])
    expect(store.searchSessions({ query: 'private side answer' }).results).toEqual([])
  })

  it('purges a crashed Side chat when the store reopens', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-side-chat-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'main', projectPath: '/repo', provider: 'codex', title: 'Main' })
    seeded.addThread({
      id: 'side',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Side chat',
      ephemeral: true,
      parentThreadId: 'main',
    })
    seeded.append('side', message('temporary'))
    seeded.close()

    const reopened = new Store(file)
    try {
      expect(reopened.thread('main')).toBeDefined()
      expect(reopened.thread('side')).toBeUndefined()
      expect(reopened.history('side')).toEqual([])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('durable queued turns', () => {
  const queued = (id: string, text = 'Repeat this.') => ({
    id,
    threadId: 'thread-1',
    clientSubmissionId: id,
    text,
    attachments: [`C:\\private\\${id}.png`],
    options: { model: `model-${id}`, serviceTier: 'fast' },
    createdAt: Number(id.at(-1)?.charCodeAt(0)),
  })

  it('replays exact records and mutations in order after a restart', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-queued-turns-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'thread-1', projectPath: '/repo', provider: 'codex', title: 'Queue' })

    seeded.enqueueQueuedTurn(queued('submission-a'))
    seeded.enqueueQueuedTurn(queued('submission-b'))
    seeded.moveQueuedTurn('thread-1', 'submission-b', 'up')
    seeded.deleteQueuedTurn('thread-1', 'submission-a')
    seeded.enqueueQueuedTurn(queued('submission-c', 'Third.'))
    expect(seeded.claimQueuedTurn('thread-1', 'submission-b', 'steer')?.intent).toBe('steer')
    for (let index = 0; index < 1_000; index += 1) {
      seeded.append('thread-1', message(`old transcript delta ${index}`))
    }
    seeded.close()

    const restarted = new Store(file)
    try {
      const parse = vi.spyOn(JSON, 'parse')
      const replayed = restarted.queuedTurns('thread-1')
      expect(parse).toHaveBeenCalledTimes(2)
      parse.mockRestore()
      expect(replayed.map(({ id, text, intent }) => [id, text, intent])).toEqual([
        ['submission-b', 'Repeat this.', 'normal'],
        ['submission-c', 'Third.', 'normal'],
      ])
      expect(replayed[0]).toMatchObject(queued('submission-b'))
      expect(restarted.hasQueuedSubmission('thread-1', 'submission-b')).toBe(true)
      expect(restarted.hasQueuedSubmission('thread-1', 'missing')).toBe(false)
    } finally {
      restarted.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restores rejected claims and permanently completes accepted ones', () => {
    store.addProject('/repo')
    store.addThread({ id: 'thread-1', projectPath: '/repo', provider: 'api', title: 'Queue' })
    store.enqueueQueuedTurn(queued('submission-1', 'Try this.'))

    expect(store.claimQueuedTurn('thread-1', 'submission-1', 'normal')).toMatchObject({
      id: 'submission-1',
      intent: 'normal',
    })
    expect(store.deleteQueuedTurn('thread-1', 'submission-1')).toBe(false)
    expect(store.restoreQueuedTurn('thread-1', 'submission-1')).toBe(true)
    expect(store.completeQueuedTurn('thread-1', 'submission-1')).toBe(false)
    expect(store.queuedTurns('thread-1').map(({ id }) => id)).toEqual(['submission-1'])

    store.claimQueuedTurn('thread-1', 'submission-1', 'normal')
    store.completeQueuedTurn('thread-1', 'submission-1')
    expect(store.queuedTurns('thread-1')).toEqual([])
    expect(store.hasQueuedSubmission('thread-1', 'submission-1')).toBe(false)
  })

  it('cleans queued state for closed and deleted threads', () => {
    store.addProject('/repo')
    for (const threadId of ['closed', 'deleted']) {
      store.addThread({ id: threadId, projectPath: '/repo', provider: 'codex', title: threadId })
      store.enqueueQueuedTurn({ ...queued(`${threadId}-submission`), threadId })
    }

    store.closeThread('closed')
    store.deleteThread('deleted')

    expect(store.queuedTurns('closed')).toEqual([])
    expect(store.queuedTurns('deleted')).toEqual([])
  })
})

describe('recovering interrupted turns', () => {
  function seedThread(target: Store, id: string, turnId = `${id}-turn`): void {
    target.addThread({ id, projectPath: '/repo', provider: 'codex', title: 'Pending' })
    target.append(id, {
      type: 'turn.started',
      turn: { id: turnId, threadId: id, status: 'running', createdAt: 1 },
    })
  }

  it('settles every process-owned lifecycle while preserving terminal and resumable state', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-interrupted-turn-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seedThread(seeded, 'thread-1', 'turn-1')
    const itemTypes = ItemTypeSchema.options
    for (const type of itemTypes) {
      seeded.append('thread-1', lifecycleItem(`active-${type}`, 'turn-1', type))
    }
    seeded.append('thread-1', lifecycleItem('terminal-item', 'turn-1', 'tool_call', 'completed'))
    seeded.append('thread-1', lifecycleItem('terminal-item', 'turn-1', 'tool_call'))
    seeded.append('thread-1', {
      type: 'approval.requested',
      request: { id: 'approval-1', kind: 'command', createdAt: 3 },
    })
    seeded.append('thread-1', userInput('input-1', 'turn-1'))
    seeded.append('thread-1', {
      type: 'approval.review.started',
      review: {
        id: 'review-1',
        turnId: 'turn-1',
        status: 'in_progress',
        description: 'Run tests',
        startedAt: 13,
      },
    })

    seedThread(seeded, 'resumable-design', 'design-turn')
    seeded.setDesignRun('resumable-design', { phase: 'brief' })
    seeded.append('resumable-design', userInput('design-input', 'design-turn'))

    seedThread(seeded, 'closed-thread')
    seeded.closeThread('closed-thread')
    seeded.close()

    const restarted = new Store(file)
    try {
      expect(restarted.recoverInterruptedThreads()).toEqual(['thread-1', 'resumable-design'])
      const recovered = restarted.history('thread-1').map(({ event }) => event)
      expect(
        recovered
          .filter((event) => event.type === 'item.completed' && event.item.status === 'failed')
          .map((event) => (event.type === 'item.completed' ? event.item.id : '')),
      ).toEqual(itemTypes.map((type) => `active-${type}`))
      expect(recovered).toContainEqual({ type: 'approval.resolved', id: 'approval-1' })
      expect(recovered).toContainEqual({ type: 'user_input.resolved', id: 'input-1' })
      expect(recovered).toContainEqual({
        type: 'approval.review.completed',
        review: expect.objectContaining({ id: 'review-1', status: 'aborted' }),
      })
      expect(recovered).toContainEqual({
        type: 'turn.completed',
        turnId: 'turn-1',
        status: 'interrupted',
      })
      expect(
        recovered.filter(
          (event) => event.type === 'item.completed' && event.item.id === 'terminal-item',
        ),
      ).toHaveLength(1)
      expect(restarted.thread('thread-1')?.unread).toBe(true)
      const designEvents = restarted.history('resumable-design').map(({ event }) => event)
      expect(designEvents).toContainEqual({
        type: 'turn.completed',
        turnId: 'design-turn',
        status: 'interrupted',
      })
      expect(designEvents.some((event) => event.type === 'user_input.resolved')).toBe(false)
      expect(designEvents.some((event) => event.type === 'thread.error')).toBe(false)
      expect(restarted.history('closed-thread')).toHaveLength(1)

      const recoveredLength = restarted.history('thread-1').length
      expect(restarted.recoverInterruptedThreads()).toEqual([])
      expect(restarted.history('thread-1')).toHaveLength(recoveredLength)
    } finally {
      restarted.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rolls back the whole recovery when one terminal event cannot be written', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-recovery-atomic-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seedThread(seeded, 'thread-1')
    seeded.append('thread-1', {
      type: 'approval.requested',
      request: { id: 'approval-1', kind: 'command', createdAt: 2 },
    })
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.exec(`CREATE TRIGGER fail_recovery BEFORE INSERT ON events
      WHEN json_extract(NEW.payload, '$.type') = 'turn.completed'
      BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END`)
    raw.close()

    const restarted = new Store(file)
    try {
      expect(() => restarted.recoverInterruptedThreads()).toThrow('injected recovery failure')
      expect(restarted.history('thread-1')).toHaveLength(2)
      expect(restarted.thread('thread-1')?.unread).toBe(false)
    } finally {
      restarted.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('filters old lifecycle history within the cold-start budget', () => {
    store.addProject('/repo')
    store.addThread({ id: 'thread-1', projectPath: '/repo', provider: 'codex', title: 'Scale' })
    for (let index = 0; index < 5_000; index += 1) {
      const turnId = `completed-${index}`
      store.append('thread-1', {
        type: 'turn.started',
        turn: { id: turnId, threadId: 'thread-1', status: 'running', createdAt: index },
      })
      store.append('thread-1', { type: 'turn.completed', turnId, status: 'completed' })
    }
    store.append('thread-1', {
      type: 'turn.started',
      turn: { id: 'open-turn', threadId: 'thread-1', status: 'running', createdAt: 100 },
    })
    const parse = vi.spyOn(JSON, 'parse')
    const startedAt = performance.now()

    expect(store.recoverInterruptedThreads()).toEqual(['thread-1'])
    expect(performance.now() - startedAt).toBeLessThan(1_500)
    expect(parse).toHaveBeenCalledTimes(1)
    parse.mockRestore()
  })
})

describe('opening a database written by an older build', () => {
  /**
   * The break this guards against only ever hits people who used the app
   * before the change, so it cannot show up in development — a fresh database
   * always has every column.
   */
  it('adds columns that did not exist yet instead of failing every query', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-store-'))
    const file = path.join(dir, 'old.db')

    // Exactly the shape shipped before worktrees and pinning existed.
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE projects (path TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, project_path TEXT NOT NULL, provider TEXT NOT NULL,
        agent TEXT, title TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER);
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        at INTEGER NOT NULL, payload TEXT NOT NULL);
    `)
    old.prepare(`INSERT INTO projects VALUES (?, ?, ?)`).run('/repo', 'Old project', 1)
    old
      .prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('t1', '/repo', 'codex', null, 'Old session', 1, null)
    old
      .prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`)
      .run('t1', 2, JSON.stringify(message('legacy regression')))
    old.close()

    const migrated = new Store(file)
    try {
      // The old rows survive, and the new columns answer rather than throw.
      expect(migrated.project('/repo')?.name).toBe('Old project')
      expect(migrated.project('/repo')?.pinned).toBe(false)
      expect(migrated.thread('t1')?.title).toBe('Old session')
      expect(migrated.thread('t1')?.pinned).toBe(false)
      expect(migrated.thread('t1')?.worktreePath).toBeUndefined()
      expect(migrated.thread('t1')?.lifecycle).toEqual({ state: 'active', keepActive: false })

      migrated.setPinned('/repo', true)
      expect(migrated.project('/repo')?.pinned).toBe(true)
      migrated.setThreadPinned('t1', true)
      expect(migrated.thread('t1')?.pinned).toBe(true)
      expect(migrated.searchSessions({ query: 'legacy' }).results[0]?.threadId).toBe('t1')
    } finally {
      migrated.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rebuilds a search migration that never reached its completion marker', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-search-migration-'))
    const file = path.join(dir, 'partial.db')
    const partial = new DatabaseSync(file)
    partial.exec(`
      CREATE TABLE projects (
        path TEXT PRIMARY KEY, name TEXT NOT NULL, pinned INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, project_path TEXT NOT NULL, provider TEXT NOT NULL,
        agent TEXT, title TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER,
        worktree_path TEXT, worktree_branch TEXT);
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE VIRTUAL TABLE session_search USING fts5 (
        thread_id UNINDEXED, event_seq UNINDEXED, turn_id UNINDEXED,
        created_at UNINDEXED, text);
    `)
    partial.prepare(`INSERT INTO projects VALUES (?, ?, 0, ?)`).run('/repo', 'Repo', 1)
    partial
      .prepare(`INSERT INTO threads VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`)
      .run('t1', '/repo', 'codex', 'Thread', 1)
    partial
      .prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?), (?, ?, ?)`)
      .run(
        't1',
        1,
        JSON.stringify(message('first migration result')),
        't1',
        2,
        JSON.stringify(message('second migration result')),
      )
    partial
      .prepare(
        `INSERT INTO session_search
           (rowid, thread_id, event_seq, turn_id, created_at, text)
         VALUES (1, 't1', 1, 't1', 1, 'first migration result')`,
      )
      .run()
    partial.close()

    const migrated = new Store(file)
    try {
      expect(migrated.searchSessions({ query: 'migration' }).results).toHaveLength(2)
    } finally {
      migrated.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('design runs', () => {
  it('replaces and removes the durable workflow payload', () => {
    store.setDesignRun('t1', { phase: 'brief', status: 'waiting' })
    expect(store.designRun('t1')).toEqual({ phase: 'brief', status: 'waiting' })

    store.setDesignRun('t1', { phase: 'brand', status: 'running' })
    expect(store.designRun('t1')).toEqual({ phase: 'brand', status: 'running' })

    store.deleteDesignRun('t1')
    expect(store.designRun('t1')).toBeUndefined()
  })
})

describe('projects', () => {
  it('names a project after its folder when no name is given', () => {
    const project = store.addProject('/home/me/work/harness')
    expect(project.name).toBe('harness')
  })

  it('does not overwrite a name when the same project is added again', () => {
    store.addProject('/repo')
    store.renameProject('/repo', 'My thing')
    store.addProject('/repo')

    // Adding a folder twice is a normal thing to do, and it must not silently
    // undo the name the user chose.
    expect(store.project('/repo')?.name).toBe('My thing')
  })

  it('removes a project from the sidebar without deleting its chat history', () => {
    store.addProject('/repo')
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    store.append('t1', message('hello'))
    store.addCheckpoint({ threadId: 't1', seq: 1, commit: 'abc', label: 'a turn' })

    store.removeProject('/repo')

    expect(store.project('/repo')).toBeUndefined()
    expect(store.thread('t1')).toBeDefined()
    expect(store.history('t1')).toHaveLength(1)
    expect(store.checkpoints('t1')).toHaveLength(1)

    store.addProject('/repo')
    expect(store.threads('/repo')).toHaveLength(1)
  })
})

describe('threads', () => {
  beforeEach(() => {
    store.addProject('/repo')
  })

  it('keeps the ACP agent, because the provider alone cannot start the session', () => {
    store.addThread({
      id: 't1',
      projectPath: '/repo',
      provider: 'acp',
      agent: 'gemini',
      title: 'One',
    })
    expect(store.thread('t1')?.agent).toBe('gemini')
  })

  it('leaves the agent unset for providers that are a single engine', () => {
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    expect(store.thread('t1')?.agent).toBeUndefined()
  })

  it('refuses to delete an isolated checkout before it is discarded', () => {
    store.addThread({
      id: 'isolated',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Isolated',
      worktreePath: '/trees/isolated',
      worktreeBranch: 'harness/isolated',
    })

    expect(() => store.deleteThread('isolated')).toThrow('discard the isolated session checkout')
    expect(store.thread('isolated')).toBeDefined()
  })

  it('lists newest first', () => {
    store.addThread({
      id: 'old',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Old',
      createdAt: 1000,
    })
    store.addThread({
      id: 'new',
      projectPath: '/repo',
      provider: 'codex',
      title: 'New',
      createdAt: 2000,
    })

    expect(store.threads('/repo').map((t) => t.id)).toEqual(['new', 'old'])
  })

  it('keeps a closed session rather than discarding it', () => {
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    store.append('t1', message('hello'))

    store.closeThread('t1')

    // Ending the process is not the same as wanting the transcript gone.
    expect(store.thread('t1')?.closedAt).toBeGreaterThan(0)
    expect(store.history('t1')).toHaveLength(1)
  })

  it('separates threads by project', () => {
    store.addProject('/other')
    store.addThread({ id: 'a', projectPath: '/repo', provider: 'codex', title: 'A' })
    store.addThread({ id: 'b', projectPath: '/other', provider: 'codex', title: 'B' })

    expect(store.threads('/repo').map((t) => t.id)).toEqual(['a'])
    expect(
      store
        .threads()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['a', 'b'])
  })

  it('persists inbox shelves and settings across a restart without closing the thread', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-inbox-'))
    const file = path.join(dir, 'inbox.db')
    const persistent = new Store(file)
    persistent.addProject('/persisted')
    persistent.addThread({
      id: 'persisted',
      projectPath: '/persisted',
      provider: 'codex',
      title: 'Persisted',
      createdAt: 10,
    })
    persistent.snoozeThread('persisted', 100, 20)
    persistent.updateSidebarSettings({ mode: 'classic', autoSettleDays: null })
    persistent.updateBackgroundModelPreference({
      mode: 'manual',
      target: { provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
    })
    persistent.close()

    const reopened = new Store(file)
    try {
      expect(reopened.thread('persisted')?.closedAt).toBeUndefined()
      expect(reopened.thread('persisted')?.lifecycle).toEqual({
        state: 'snoozed',
        snoozedAt: 20,
        wakeAt: 100,
      })
      expect(reopened.sidebarSettings()).toEqual({ mode: 'classic', autoSettleDays: null })
      expect(reopened.backgroundModelPreference()).toEqual({
        mode: 'manual',
        target: { provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
      })
      expect(reopened.dueSnoozedThreads(99)).toEqual([])
      expect(reopened.dueSnoozedThreads(100).map((thread) => thread.id)).toEqual(['persisted'])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts new profiles with the classic sidebar and three-day settling', () => {
    expect(store.sidebarSettings()).toEqual({ mode: 'classic', autoSettleDays: 3 })
    expect(store.backgroundModelPreference()).toEqual({ mode: 'automatic' })
  })
})

describe('events', () => {
  beforeEach(() => {
    store.addProject('/repo')
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
  })

  it('replays a thread in the order it happened', () => {
    store.append('t1', message('one'))
    store.append('t1', message('two'))
    store.append('t1', message('three'))

    const texts = store.history('t1').map((entry) => {
      const event = entry.event
      return event.type === 'item.completed' ? event.item.text : undefined
    })
    expect(texts).toEqual(['one', 'two', 'three'])
  })

  it('returns only what happened after a sequence number', () => {
    store.append('t1', message('one'))
    const seq = store.append('t1', message('two'))
    store.append('t1', message('three'))

    // A client that fell behind asks for the tail; the same call serves both.
    const tail = store.history('t1', seq)
    expect(tail).toHaveLength(1)
    const event = tail[0]?.event
    expect(event?.type === 'item.completed' ? event.item.text : undefined).toBe('three')
  })

  it('never hands one thread another thread events', () => {
    store.addThread({ id: 't2', projectPath: '/repo', provider: 'codex', title: 'Two' })
    store.append('t1', message('mine'))
    store.append('t2', message('theirs'))

    expect(store.history('t1')).toHaveLength(1)
    expect(store.history('t2')).toHaveLength(1)
  })

  it('reports zero for a thread that has produced nothing', () => {
    expect(store.lastSeq('t1')).toBe(0)
  })

  it('survives an event carrying text that would break naive escaping', () => {
    const nasty = 'quote " backslash \\ newline \n null-ish \\u0000 emoji 🙂'
    store.append('t1', message(nasty))

    const event = store.history('t1')[0]?.event
    expect(event?.type === 'item.completed' ? event.item.text : undefined).toBe(nasty)
  })
})

describe('cross-session search', () => {
  beforeEach(() => {
    store.addProject('/repo', 'TasteCode')
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'Search work' })
  })

  it('indexes messages and useful tool output but not reasoning', () => {
    store.append('t1', message('Find the regression'))
    store.append('t1', {
      type: 'item.completed',
      item: {
        id: 'command',
        turnId: 't2',
        type: 'command',
        status: 'completed',
        command: 'pnpm test',
        text: 'regression suite passed',
        createdAt: 2,
      },
    })
    store.append('t1', {
      type: 'item.completed',
      item: {
        id: 'reasoning',
        turnId: 't3',
        type: 'reasoning',
        status: 'completed',
        text: 'private-thought-marker',
        createdAt: 3,
      },
    })

    expect(store.searchSessions({ query: 'regression' }).results).toHaveLength(2)
    expect(store.searchSessions({ query: 'pnpm' }).results[0]?.turnId).toBe('t2')
    expect(store.searchSessions({ query: 'private-thought-marker' }).results).toEqual([])
  })

  it('identifies otherwise indistinguishable content results without exposing their source', () => {
    const duplicate = message('opaque collision marker')
    store.append('t1', duplicate)
    store.append('t1', duplicate)

    const results = store.searchSessions({ query: 'opaque collision' }).results
    const resultIds = results.map((result) => result.resultId)

    expect(results).toHaveLength(2)
    expect(new Set(resultIds).size).toBe(2)
    for (const resultId of resultIds) {
      expect(resultId).toMatch(/^sr1_[A-Za-z0-9_-]{22}$/)
      expect(resultId!.length).toBeLessThanOrEqual(256)
    }
  })

  it('keeps result identity stable across queries, pagination, and title changes', () => {
    for (let index = 0; index < 3; index += 1) {
      store.append('t1', message(`stableidentity shared result-${index}`))
    }

    const first = store.searchSessions({ query: 'stableidentity', limit: 2 })
    const second = store.searchSessions({
      query: 'stableidentity',
      cursor: first.nextCursor!,
      limit: 2,
    })
    const original = [...first.results, ...second.results]
    store.renameThread('t1', 'Renamed after the first search')
    const repeated = store.searchSessions({ query: 'stableidentity shared' }).results
    const identityBySnippet = new Map(
      original.map((result) => [result.snippet.map((part) => part.text).join(''), result.resultId]),
    )

    expect(original.map((result) => result.resultId)).not.toContain(undefined)
    expect(new Set(original.map((result) => result.resultId)).size).toBe(3)
    expect(
      repeated.map((result) => [result.snippet.map((part) => part.text).join(''), result.resultId]),
    ).toEqual(
      expect.arrayContaining(
        [...identityBySnippet].map(([snippet, resultId]) => [snippet, resultId]),
      ),
    )
    expect(
      repeated.every((result) => result.threadTitle === 'Renamed after the first search'),
    ).toBe(true)
  })

  it('preserves result identity across process restarts and index rebuilds', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-search-identity-'))
    const file = path.join(dir, 'identity.db')
    const seeded = new Store(file)
    seeded.addProject('/private/repository', 'Private')
    seeded.addThread({
      id: 'private-thread',
      projectPath: '/private/repository',
      provider: 'codex',
      title: 'Private title',
    })
    seeded.append('private-thread', message('persistent opaque identity'))
    const before = seeded.searchSessions({ query: 'persistent' }).results[0]?.resultId
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.prepare(`DELETE FROM schema_migrations WHERE name = ?`).run('session_search_v1')
    raw.close()

    const rebuilt = new Store(file)
    try {
      const after = rebuilt.searchSessions({ query: 'identity' }).results[0]?.resultId
      expect(before).toBeDefined()
      expect(after).toBe(before)
    } finally {
      rebuilt.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ranks exact words ahead of prefixes and ignores punctuation-only queries', () => {
    store.append('t1', message('testing the performance budget'))
    store.append('t1', message('test the performance budget'))

    const matches = store.searchSessions({ query: 'test perf' }).results
    expect(matches).toHaveLength(2)
    expect(matches[0]?.snippet.map((part) => part.text).join('')).toContain('test the')
    expect(store.searchSessions({ query: '---' }).results).toEqual([])
  })

  it('filters and paginates without repeating results', () => {
    store.addProject('/other', 'Other')
    store.addThread({
      id: 't2',
      projectPath: '/other',
      provider: 'claude-code',
      title: 'Other work',
    })
    store.append('t1', message('shared marker'))
    store.append('t2', message('shared marker'))

    expect(store.searchSessions({ query: 'shared', provider: 'codex' }).results[0]?.threadId).toBe(
      't1',
    )
    expect(
      store.searchSessions({ query: 'shared', projectPath: '/other' }).results[0]?.threadId,
    ).toBe('t2')

    const first = store.searchSessions({ query: 'shared', limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    const second = store.searchSessions({ query: 'shared', limit: 1, cursor: first.nextCursor! })
    expect(second.results[0]?.threadId).not.toBe(first.results[0]?.threadId)
    expect(second.nextCursor).toBeNull()
  })

  it('keeps the original ranked snapshot when matching rows arrive between pages', () => {
    for (let index = 0; index < 20; index += 1) {
      store.append('t1', message(`pagefreeze old-${index}`))
    }
    const first = store.searchSessions({ query: 'pagefreeze', limit: 5 })

    for (let index = 0; index < 100; index += 1) {
      store.append(
        't1',
        message(`pagefreeze newly inserted result with different document length ${index}`),
      )
    }
    const second = store.searchSessions({
      query: 'pagefreeze',
      limit: 5,
      cursor: first.nextCursor!,
    })
    const snippetText = (result: SessionSearchResult): string =>
      result.snippet.map((part) => part.text).join('')

    expect(first.results.map(snippetText)).toEqual([
      'pagefreeze old-19',
      'pagefreeze old-18',
      'pagefreeze old-17',
      'pagefreeze old-16',
      'pagefreeze old-15',
    ])
    expect(second.results.map(snippetText)).toEqual([
      'pagefreeze old-14',
      'pagefreeze old-13',
      'pagefreeze old-12',
      'pagefreeze old-11',
      'pagefreeze old-10',
    ])
  })

  it('traverses more than 100 unchanged pages without gaps or repeats', () => {
    for (let index = 0; index < 205; index += 1) {
      store.append('t1', message(`longpagination result-${index}`))
    }

    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    do {
      const page = store.searchSessions({
        query: 'longpagination',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      })
      for (const result of page.results) {
        const text = result.snippet.map((part) => part.text).join('')
        expect(seen.has(text)).toBe(false)
        seen.add(text)
      }
      if (page.nextCursor) {
        const continuation = JSON.parse(
          Buffer.from(page.nextCursor, 'base64url').toString('utf8'),
        ) as { position: number }
        expect(continuation.position).toBeGreaterThan(pages * 2)
      }
      cursor = page.nextCursor ?? undefined
      pages += 1
    } while (cursor)

    expect(pages).toBe(103)
    expect(seen.size).toBe(205)
  })

  it('binds continuation cursors to the original query and filters', () => {
    store.append('t1', message('filtered snapshot first'))
    store.append('t1', message('filtered snapshot second'))
    const first = store.searchSessions({ query: 'filtered', projectPath: '/repo', limit: 1 })

    expect(
      store.searchSessions({
        query: 'filtered',
        projectPath: '/repo',
        cursor: first.nextCursor!,
        limit: 1,
      }).results,
    ).toHaveLength(1)
    expect(() =>
      store.searchSessions({
        query: 'different',
        projectPath: '/repo',
        cursor: first.nextCursor!,
        limit: 1,
      }),
    ).toThrow('does not match')
    expect(() =>
      store.searchSessions({ query: 'filtered', cursor: first.nextCursor!, limit: 1 }),
    ).toThrow('does not match')
  })

  it('expires abandoned search snapshots', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-11T10:00:00Z'))
      store.append('t1', message('expiring snapshot first'))
      store.append('t1', message('expiring snapshot second'))
      const first = store.searchSessions({ query: 'expiring', limit: 1 })

      vi.advanceTimersByTime(5 * 60 * 1_000 + 1)

      expect(() =>
        store.searchSessions({ query: 'expiring', cursor: first.nextCursor!, limit: 1 }),
      ).toThrow('expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clamps internal page sizes and treats malformed cursors as a fresh search', () => {
    for (let index = 0; index < 101; index += 1) {
      store.append('t1', message(`bounded result ${index}`))
    }

    expect(store.searchSessions({ query: 'bounded', limit: 1_000 }).results).toHaveLength(100)
    expect(store.searchSessions({ query: 'bounded', limit: 0 }).results).toHaveLength(1)
    const fresh = store.searchSessions({ query: 'bounded', limit: 1 })
    const malformed = store.searchSessions({ query: 'bounded', limit: 1, cursor: 'not-json' })
    expect(malformed.results).toEqual(fresh.results)
  })

  it('rolls back the event when indexing the same row fails', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-search-atomic-'))
    const file = path.join(dir, 'atomic.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    seeded.close()

    const raw = new DatabaseSync(file)
    raw
      .prepare(
        `INSERT INTO session_search
           (rowid, thread_id, event_seq, turn_id, created_at, text)
         VALUES (1, 't1', 1, 't1', 1, 'collision')`,
      )
      .run()
    raw.close()

    const reopened = new Store(file)
    try {
      expect(() => reopened.append('t1', message('atomic result'))).toThrow()
      expect(reopened.history('t1')).toEqual([])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps rollback, undo and deletion consistent with the index', () => {
    const keepSeq = store.append('t1', message('keep this result'))
    store.append('t1', message('temporary marker'))

    const undo = store.saveRestoreUndo('t1', keepSeq, 'snapshot')
    expect(store.searchSessions({ query: 'temporary' }).results).toEqual([])
    store.applyRestoreUndo('t1', undo)
    expect(store.searchSessions({ query: 'temporary' }).results).toHaveLength(1)

    store.deleteThread('t1')
    expect(store.searchSessions({ query: 'temporary' }).results).toEqual([])
  })

  it('returns structured plain-text highlights without adding HTML', () => {
    const dangerous = '<img src=x onerror=alert(1)> regression'
    store.append('t1', message(dangerous))

    const snippet = store.searchSessions({ query: 'regression' }).results[0]!.snippet
    expect(snippet.map((part) => part.text).join('')).toContain(dangerous)
    expect(snippet).toContainEqual({ text: 'regression', highlighted: true })
    expect(snippet.map((part) => part.text).join('')).not.toContain('<mark>')
  })
})

describe('diff review decisions', () => {
  beforeEach(() => {
    store.addProject('/repo')
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'Review' })
  })

  it('persists the latest decision and removes it with the thread', () => {
    store.setDiffDecision('t1', 'hunk:one', 'accept')
    expect(store.diffDecision('t1', 'hunk:one')).toBe('accept')

    store.setDiffDecision('t1', 'hunk:one', 'reject')
    expect(store.diffDecision('t1', 'hunk:one')).toBe('reject')

    store.deleteThread('t1')
    expect(store.diffDecision('t1', 'hunk:one')).toBeUndefined()
  })

  it('rejects invalid persisted decisions', () => {
    expect(() => store.setDiffDecision('t1', 'hunk:one', 'invalid' as DiffDecision)).toThrow(
      /CHECK constraint failed/,
    )
  })
})

describe('usage totals', () => {
  it('turns cumulative Codex updates into session and daily increments', () => {
    vi.useFakeTimers()
    try {
      store.addProject('/repo')
      store.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
      store.addThread({ id: 'two', projectPath: '/repo', provider: 'codex', title: 'Two' })
      vi.setSystemTime(new Date('2026-07-30T23:50:00'))
      store.append('one', usage(100, undefined, true))
      vi.setSystemTime(new Date('2026-07-31T00:10:00'))
      store.append('one', usage(140, undefined, true))
      store.append('two', usage(50, undefined, true))

      expect(store.usageSummary('one', new Date('2026-07-31T00:00:00').getTime())).toEqual({
        session: expect.objectContaining({ totalTokens: 140 }),
        today: expect.objectContaining({ totalTokens: 90 }),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('adds per-turn Claude usage and provider-reported cost', () => {
    store.addProject('/repo')
    store.addThread({ id: 'one', projectPath: '/repo', provider: 'claude-code', title: 'One' })
    store.addThread({ id: 'two', projectPath: '/repo', provider: 'claude-code', title: 'Two' })
    store.append('one', usage(10, 0.02))
    store.append('one', usage(20, 0.03))
    store.append('two', usage(40, 0.04))

    expect(store.usageSummary('one', 0)).toEqual({
      session: expect.objectContaining({ totalTokens: 30, costUsd: 0.05 }),
      today: expect.objectContaining({ totalTokens: 70, costUsd: 0.09 }),
    })
  })

  it('exposes persisted usage metadata for the historical usage page', () => {
    store.addProject('/repo')
    store.addThread({ id: 'one', projectPath: '/repo', provider: 'api', title: 'One' })
    store.append('one', {
      type: 'usage.updated',
      usage: {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningTokens: 5,
        totalTokens: 120,
        model: 'gpt-5.6-luna',
        inputIncludesCached: true,
      },
    })

    expect(store.usageEvents()).toEqual([
      expect.objectContaining({
        threadId: 'one',
        provider: 'api',
        usage: expect.objectContaining({
          model: 'gpt-5.6-luna',
          inputTokens: 100,
          inputIncludesCached: true,
        }),
      }),
    ])
  })
})

describe('usage totals across providers', () => {
  it("counts every provider in today's total, not only the selected thread's", () => {
    // The bug this pins: the day total was provider-scoped by accident, so a
    // Codex+Claude user saw only one side of their day.
    store.addProject('/repo')
    store.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
    store.addThread({ id: 'two', projectPath: '/repo', provider: 'claude-code', title: 'Two' })
    store.append('one', usage(100))
    store.append('two', usage(40))

    const summary = store.usageSummary('one', 0)
    expect(summary.session).toEqual(expect.objectContaining({ totalTokens: 100 }))
    expect(summary.today).toEqual(expect.objectContaining({ totalTokens: 140 }))
  })
})
