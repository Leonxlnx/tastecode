import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ItemTypeSchema, type DomainEvent, type ItemType } from '@harness/contracts'
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

const userMessage = (id: string): DomainEvent => ({
  type: 'item.completed',
  item: {
    id,
    turnId: 't1',
    type: 'message',
    role: 'user',
    status: 'completed',
    text: 'hello',
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
    const sidebar = store.sidebarThreads()
    expect(sidebar).toEqual([
      expect.objectContaining({
        id: 'main',
        projectPath: '/repo',
        lifecycle: { state: 'active', keepActive: false },
      }),
    ])
    expect(sidebar[0]).not.toHaveProperty('providerSessionId')
    expect(sidebar[0]).not.toHaveProperty('worktreePath')
    expect(store.sidebarThreads()).toBe(sidebar)
    store.renameThread('main', 'Renamed')
    expect(store.sidebarThreads()).not.toBe(sidebar)
    expect(store.sidebarThreads()[0]?.title).toBe('Renamed')
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

describe('sidebar thread snapshots', () => {
  it('keeps earlier snapshots immutable across a batch and a mid-batch read', () => {
    store.addProject('/repo')
    store.addThread({ id: 'first', projectPath: '/repo', provider: 'codex', title: 'First' })
    store.addThread({ id: 'second', projectPath: '/repo', provider: 'codex', title: 'Second' })
    const initial = store.sidebarThreads()
    let middle: ReturnType<Store['sidebarThreads']> | undefined

    store.batchSidebarThreadUpdates(() => {
      store.touchThread('first', true, 10)
      middle = store.sidebarThreads()
      store.touchThread('second', true, 20)
    })
    const final = store.sidebarThreads()
    const unread = (threads: ReturnType<Store['sidebarThreads']>) =>
      Object.fromEntries(threads.map((thread) => [thread.id, thread.unread]))

    expect(unread(initial)).toEqual({ first: false, second: false })
    expect(middle && unread(middle)).toEqual({ first: true, second: false })
    expect(unread(final)).toEqual({ first: true, second: true })
    expect(middle).not.toBe(initial)
    expect(final).not.toBe(middle)
  })

  it('updates one cached row across every sidebar mutation', () => {
    store.addProject('/repo')
    store.addThread({
      id: 'main',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Main',
      createdAt: 1,
      worktreePath: '/repo-worktree',
      worktreeBranch: 'feature/work',
    })
    const initial = store.sidebarThreads()

    store.renameThread('main', 'Renamed')
    store.setThreadPinned('main', true)
    store.touchThread('main', true, 10)
    expect(initial[0]).toMatchObject({ title: 'Main', pinned: false, unread: false })
    expect(store.sidebarThreads()).toEqual([
      expect.objectContaining({
        title: 'Renamed',
        pinned: true,
        unread: true,
        worktreeBranch: 'feature/work',
      }),
    ])
    expect(store.sidebarThreads()).not.toBe(initial)

    store.markThreadRead('main')
    expect(store.sidebarThreads()[0]?.unread).toBe(false)
    store.snoozeThread('main', 30, 20)
    expect(store.sidebarThreads()[0]?.lifecycle).toEqual({
      state: 'snoozed',
      snoozedAt: 20,
      wakeAt: 30,
    })
    store.activateThread('main', 40)
    store.setThreadKeepActive('main', true, 50)
    expect(store.sidebarThreads()[0]?.lifecycle).toEqual({
      state: 'active',
      keepActive: true,
      wokeAt: 40,
    })
    store.forgetWorktree('main')
    expect(store.sidebarThreads()[0]).not.toHaveProperty('worktreeBranch')
    store.closeThread('main')
    expect(store.sidebarThreads()[0]?.closedAt).toBeTypeOf('number')

    store.addThread({
      id: 'second',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Second',
      createdAt: 2,
    })
    expect(store.sidebarThreads().map((thread) => thread.id)).toEqual(['second', 'main'])
    store.deleteThread('second')
    expect(store.sidebarThreads().map((thread) => thread.id)).toEqual(['main'])
  })
})

describe('retained thread metadata', () => {
  it('stays exact across every thread mutation', () => {
    store.addProject('/repo')
    const added = store.addThread({
      id: 'main',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Main',
      createdAt: 1,
      worktreePath: '/repo-worktree',
      worktreeBranch: 'feature/work',
    })

    expect(store.thread('main')).toBe(added)
    store.renameThread('main', 'Renamed')
    store.setThreadPinned('main', true)
    store.setProviderSessionId('main', 'provider-session')
    store.touchThread('main', true, 10)
    expect(store.thread('main')).toMatchObject({
      title: 'Renamed',
      pinned: true,
      providerSessionId: 'provider-session',
      unread: true,
      lastActiveAt: 10,
    })

    store.markThreadRead('main')
    store.settleThread('main', 'manual', 20)
    expect(store.thread('main')).toMatchObject({
      unread: false,
      lifecycle: { state: 'settled', settledAt: 20, reason: 'manual' },
    })

    store.snoozeThread('main', 40, 30)
    expect(store.thread('main')?.lifecycle).toEqual({
      state: 'snoozed',
      snoozedAt: 30,
      wakeAt: 40,
    })
    store.activateThread('main', 50)
    store.setThreadKeepActive('main', true, 60)
    expect(store.thread('main')?.lifecycle).toEqual({
      state: 'active',
      keepActive: true,
      wokeAt: 50,
    })

    store.forgetWorktree('main')
    expect(store.thread('main')).not.toHaveProperty('worktreePath')
    expect(store.thread('main')).not.toHaveProperty('worktreeBranch')
    store.closeThread('main')
    expect(store.thread('main')?.closedAt).toBeTypeOf('number')
    store.deleteThread('main')
    expect(store.thread('main')).toBeUndefined()
  })

  it('replaces a retained missing entry when that thread is added', () => {
    store.addProject('/repo')
    expect(store.thread('later')).toBeUndefined()

    const added = store.addThread({
      id: 'later',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Later',
    })

    expect(store.thread('later')).toBe(added)
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

  it('reuses queued thread ids and invalidates them across state changes', () => {
    store.addProject('/repo')
    store.addThread({ id: 'thread-1', projectPath: '/repo', provider: 'codex', title: 'Queue' })
    const empty = store.queuedThreadIds()
    expect(store.queuedThreadIds()).toBe(empty)

    store.enqueueQueuedTurn(queued('submission-a'))
    const present = store.queuedThreadIds()
    expect(present).not.toBe(empty)
    expect([...present]).toEqual(['thread-1'])
    expect(store.queuedThreadIds()).toBe(present)

    expect(store.claimQueuedTurn('thread-1', 'submission-a', 'normal')).toBeDefined()
    expect(store.queuedThreadIds()).toEqual(new Set())
    expect(store.restoreQueuedTurn('thread-1', 'submission-a')).toBe(true)
    expect(store.queuedThreadIds()).toEqual(new Set(['thread-1']))
    expect(store.deleteQueuedTurn('thread-1', 'submission-a')).toBe(true)
    expect(store.queuedThreadIds()).toEqual(new Set())
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
    expect(store.queuedThreadIds()).toEqual(new Set(['thread-1']))

    expect(store.claimQueuedTurn('thread-1', 'submission-1', 'normal')).toMatchObject({
      id: 'submission-1',
      intent: 'normal',
    })
    expect(store.queuedThreadIds()).toEqual(new Set())
    expect(store.deleteQueuedTurn('thread-1', 'submission-1')).toBe(false)
    expect(store.restoreQueuedTurn('thread-1', 'submission-1')).toBe(true)
    expect(store.queuedThreadIds()).toEqual(new Set(['thread-1']))
    expect(store.completeQueuedTurn('thread-1', 'submission-1')).toBe(false)
    expect(store.queuedTurns('thread-1').map(({ id }) => id)).toEqual(['submission-1'])

    store.claimQueuedTurn('thread-1', 'submission-1', 'normal')
    store.completeQueuedTurn('thread-1', 'submission-1')
    expect(store.queuedThreadIds()).toEqual(new Set())
    expect(store.queuedTurns('thread-1')).toEqual([])
    expect(store.hasQueuedSubmission('thread-1', 'submission-1')).toBe(false)
  })

  it('cleans queued state for closed and deleted threads', () => {
    store.addProject('/repo')
    for (const threadId of ['closed', 'deleted']) {
      store.addThread({ id: threadId, projectPath: '/repo', provider: 'codex', title: threadId })
      store.enqueueQueuedTurn({ ...queued(`${threadId}-submission`), threadId })
    }

    expect(store.queuedThreadIds()).toEqual(new Set(['closed', 'deleted']))

    store.closeThread('closed')
    store.deleteThread('deleted')

    expect(store.queuedTurns('closed')).toEqual([])
    expect(store.queuedTurns('deleted')).toEqual([])
    expect(store.queuedThreadIds()).toEqual(new Set())
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

  it('backfills active recovery state for an existing event log', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-recovery-index-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seedThread(seeded, 'thread-1')
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.exec(`DELETE FROM recovery_lifecycles; DELETE FROM recovery_errors`)
    raw.prepare(`DELETE FROM schema_migrations WHERE name = ?`).run('recovery_lifecycles_v1')
    raw.close()

    const restarted = new Store(file)
    try {
      expect(restarted.recoverInterruptedThreads()).toEqual(['thread-1'])
    } finally {
      restarted.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes and restores active recovery state with a reversible transcript restore', () => {
    store.addProject('/repo')
    seedThread(store, 'thread-1')

    const token = store.saveRestoreUndo('thread-1', 0, 'before-turn')
    expect(store.recoverInterruptedThreads()).toEqual([])

    store.applyRestoreUndo('thread-1', token)
    expect(store.recoverInterruptedThreads()).toEqual(['thread-1'])
  })

  it('exposes a retained start when transcript restore removes its terminal event', () => {
    store.addProject('/repo')
    seedThread(store, 'thread-1')
    const startedSeq = store.lastSeq('thread-1')
    store.append('thread-1', {
      type: 'turn.completed',
      turnId: 'thread-1-turn',
      status: 'completed',
    })

    store.saveRestoreUndo('thread-1', startedSeq, 'before-completion')

    expect(store.recoverInterruptedThreads()).toEqual(['thread-1'])
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

describe('a database written by a newer build', () => {
  it('skips stored events this build cannot read instead of denying the log', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-forward-events-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'good', projectPath: '/repo', provider: 'codex', title: 'Good' })
    seeded.append('good', {
      type: 'turn.started',
      turn: { id: 'open-turn', threadId: 'good', status: 'running', createdAt: 1 },
    })
    seeded.addThread({ id: 'mixed', projectPath: '/repo', provider: 'codex', title: 'Mixed' })
    seeded.append('mixed', message('before the unknown rows'))
    seeded.close()

    const raw = new DatabaseSync(file)
    // An event type this build does not know, and a row that is not JSON at
    // all — both plausible once a newer build wrote to the same database.
    const badSeq = Number(
      raw
        .prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`)
        .run('mixed', 2, '{"type":"session.compacted","summary":"nightly"}').lastInsertRowid,
    )
    raw
      .prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`)
      .run('mixed', 3, 'not json at all')
    // An open recovery lifecycle whose stored start payload is unreadable.
    raw
      .prepare(
        `INSERT INTO recovery_lifecycles
           (thread_id, lifecycle_key, event_type, started_seq, terminal_seq, payload)
         VALUES ('good', 'turn:unreadable', 'turn.started', ?, NULL, ?)`,
      )
      .run(badSeq, '{"type":"turn.started","turn":{"bogus":true}}')
    raw.close()

    const reopened = new Store(file)
    try {
      expect(reopened.history('mixed').map(({ event }) => event)).toEqual([
        message('before the unknown rows'),
      ])
      // The unreadable row is skipped; the readable open turn still recovers.
      expect(reopened.recoverInterruptedThreads()).toEqual(['good'])
      // The tombstoned rows stay stored for a build that can read them.
      expect(reopened.lastSeq('mixed')).toBe(4)
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finishes a derived-index rebuild when one stored event fails to parse', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-forward-rebuild-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
    seeded.append('one', message('needle that must stay searchable'))
    seeded.append('one', {
      type: 'turn.started',
      turn: { id: 'open-turn', threadId: 'one', status: 'running', createdAt: 1 },
    })
    seeded.append('one', {
      type: 'approval.requested',
      request: { id: 'approval-1', kind: 'command', createdAt: 2 },
    })
    seeded.close()

    const raw = new DatabaseSync(file)
    // A selected event type carrying a shape this build rejects: the SQL
    // prefilter sees 'item.started', then the schema refuses the payload.
    raw
      .prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`)
      .run('one', 3, '{broken')
    raw.prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`).run(
      'one',
      3,
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'x',
          turnId: 'open-turn',
          type: 'hologram',
          status: 'started',
          createdAt: 3,
        },
      }),
    )
    raw.exec(`
      DELETE FROM session_search;
      DELETE FROM usage_events;
      DELETE FROM inbox_events;
      DELETE FROM user_submission_items;
      DELETE FROM turn_diff_events;
      DELETE FROM recovery_lifecycles;
      DELETE FROM recovery_errors;
      DELETE FROM schema_migrations;
    `)
    raw.close()

    const reopened = new Store(file)
    try {
      // The constructor rebuilt every derived index past the unreadable row.
      expect(reopened.searchSessions({ query: 'needle' }).results).toHaveLength(1)
      expect(reopened.inboxProjections().get('one')?.approvals).toEqual(new Set(['approval-1']))
      expect(reopened.recoverInterruptedThreads()).toEqual(['one'])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps lists and search usable when a thread row has an unknown provider', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-forward-provider-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'normal', projectPath: '/repo', provider: 'codex', title: 'Normal' })
    seeded.addThread({ id: 'alien', projectPath: '/repo', provider: 'codex', title: 'Alien' })
    seeded.append('normal', message('shared needle'))
    seeded.append('alien', message('shared needle'))
    seeded.append('alien', {
      type: 'turn.started',
      turn: { id: 'alien-turn', threadId: 'alien', status: 'running', createdAt: 1 },
    })
    seeded.close()

    const raw = new DatabaseSync(file)
    raw
      .prepare(`UPDATE threads SET provider = ? WHERE id = ?`)
      .run('provider-from-nightly', 'alien')
    raw.close()

    const reopened = new Store(file)
    try {
      expect(reopened.threads().map((thread) => thread.id)).toEqual(['normal'])
      expect(reopened.sidebarThreads().map((thread) => thread.id)).toEqual(['normal'])
      expect(reopened.thread('alien')).toBeUndefined()
      const results = reopened.searchSessions({ query: 'needle' }).results
      expect(results.map((result) => result.threadId)).toEqual(['normal'])
      expect(reopened.recoverInterruptedThreads()).toEqual([])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades rows a schema-divergent build could leave behind', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-forward-schema-'))
    const file = path.join(dir, 'harness.db')
    // The shape a newer build could leave: same columns, wider CHECK lists.
    const raw = new DatabaseSync(file)
    raw.exec(`
      CREATE TABLE threads (
        id           TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        provider     TEXT NOT NULL,
        agent        TEXT,
        provider_session_id TEXT,
        title        TEXT NOT NULL,
        pinned       INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        closed_at    INTEGER,
        worktree_path   TEXT,
        worktree_branch TEXT,
        lifecycle_state  TEXT NOT NULL DEFAULT 'active'
          CHECK (lifecycle_state IN ('active', 'settled', 'snoozed', 'dormant')),
        lifecycle_at     INTEGER,
        lifecycle_reason TEXT,
        wake_at          INTEGER,
        keep_active      INTEGER NOT NULL DEFAULT 0,
        woke_at          INTEGER,
        unread           INTEGER NOT NULL DEFAULT 0,
        last_active_at   INTEGER NOT NULL,
        ephemeral        INTEGER NOT NULL DEFAULT 0,
        parent_thread_id TEXT
      );
      CREATE TABLE queued_turns (
        thread_id            TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        queue_id             TEXT NOT NULL,
        client_submission_id TEXT,
        position             INTEGER NOT NULL,
        state                TEXT NOT NULL CHECK (state IN ('queued', 'dispatching')),
        intent               TEXT NOT NULL,
        payload              TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        PRIMARY KEY (thread_id, queue_id)
      );
      CREATE TABLE diff_decisions (
        thread_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        decision  TEXT NOT NULL,
        PRIMARY KEY (thread_id, target_id)
      );
    `)
    raw.close()

    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'weird', projectPath: '/repo', provider: 'codex', title: 'Weird' })
    seeded.close()

    const divergent = new DatabaseSync(file)
    divergent.prepare(`UPDATE threads SET lifecycle_state = 'dormant' WHERE id = 'weird'`).run()
    divergent
      .prepare(
        `INSERT INTO queued_turns
           (thread_id, queue_id, position, state, intent, payload, created_at)
         VALUES ('weird', 'q1', 0, 'queued', 'steer-v2', ?, 1)`,
      )
      .run(JSON.stringify({ text: 'queued prompt', attachments: [], options: {} }))
    divergent
      .prepare(
        `INSERT INTO queued_turns
           (thread_id, queue_id, position, state, intent, payload, created_at)
         VALUES ('weird', 'q2', 1, 'queued', 'normal', ?, 2)`,
      )
      .run('{"prompt":"a shape this build does not know"}')
    divergent
      .prepare(`INSERT INTO diff_decisions (thread_id, target_id, decision) VALUES (?, ?, ?)`)
      .run('weird', 'hunk:1', 'partial')
    divergent.close()

    const reopened = new Store(file)
    try {
      // A lifecycle state only a newer build knows reads as plainly active.
      expect(reopened.thread('weird')?.lifecycle).toEqual({ state: 'active', keepActive: false })
      expect(reopened.sidebarThreads()[0]?.lifecycle).toEqual({
        state: 'active',
        keepActive: false,
      })
      // The unknown intent degrades to a normal turn; the unreadable prompt
      // is a tombstone: never listed, never claimed, still stored for a
      // build that understands it.
      expect(reopened.queuedTurns('weird').map((turn) => turn.intent)).toEqual(['normal'])
      expect(reopened.claimQueuedTurn('weird', 'q2', 'normal')).toBeUndefined()
      expect(reopened.diffDecision('weird', 'hunk:1')).toBeUndefined()
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not keep cache writes a rolled-back recovery made', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-recovery-cache-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    for (const [id, turnId] of [
      ['first', 'turn-first'],
      ['second', 'turn-second'],
    ] as const) {
      seeded.addThread({ id, projectPath: '/repo', provider: 'codex', title: id })
      seeded.append(id, {
        type: 'turn.started',
        turn: { id: turnId, threadId: id, status: 'running', createdAt: 1 },
      })
    }
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON events
      WHEN json_extract(NEW.payload, '$.turnId') = 'turn-second'
      BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END`)
    raw.close()

    const reopened = new Store(file)
    try {
      // Warm both caches so the failure lands on populated in-memory state.
      expect(reopened.thread('first')?.unread).toBe(false)
      expect(reopened.sidebarThreads().every((thread) => !thread.unread)).toBe(true)
      expect(() => reopened.recoverInterruptedThreads()).toThrow('injected recovery failure')
      // First's recovery appended and touched, then rolled back: the caches
      // must agree with the database, not with the lost writes.
      expect(reopened.thread('first')?.unread).toBe(false)
      expect(reopened.sidebarThreads().find((thread) => thread.id === 'first')?.unread).toBe(false)
      expect(reopened.history('first')).toHaveLength(1)
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
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
      expect(migrated.thread('t1')?.providerSessionId).toBeUndefined()
      expect(migrated.thread('t1')?.lifecycle).toEqual({ state: 'active', keepActive: false })

      migrated.setPinned('/repo', true)
      expect(migrated.project('/repo')?.pinned).toBe(true)
      migrated.setThreadPinned('t1', true)
      expect(migrated.thread('t1')?.pinned).toBe(true)
      migrated.setProviderSessionId('t1', 'native-session-after-migration')
      expect(migrated.thread('t1')?.providerSessionId).toBe('native-session-after-migration')
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

  it('reuses unchanged project rows and invalidates them after mutations', () => {
    store.addProject('/repo', 'Repo')
    const initial = store.projects()
    expect(store.projects()).toBe(initial)
    expect(store.addProject('/repo', 'Ignored')).toEqual(initial[0])
    expect(store.projects()).toBe(initial)

    store.renameProject('/repo', 'Renamed')
    expect(store.projects()).not.toBe(initial)
    expect(store.projects()[0]?.name).toBe('Renamed')
    store.setPinned('/repo', true)
    expect(store.projects()[0]?.pinned).toBe(true)
    store.addProject('/second', 'Second')
    expect(store.projects().map((project) => project.path)).toEqual(['/repo', '/second'])
    store.removeProject('/second')
    expect(store.projects().map((project) => project.path)).toEqual(['/repo'])
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

  it('keeps the opaque provider session id separate from the TasteCode thread id', () => {
    store.addThread({ id: 'grok-tastecode', projectPath: '/repo', provider: 'grok', title: 'One' })

    store.setProviderSessionId('grok-tastecode', 'grok-native')

    expect(store.thread('grok-tastecode')).toMatchObject({
      id: 'grok-tastecode',
      providerSessionId: 'grok-native',
    })
    expect(() => store.setProviderSessionId('missing', 'grok-native')).toThrow('thread not found')
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
      target: {
        provider: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'medium',
        serviceTier: 'priority',
      },
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
        target: {
          provider: 'codex',
          model: 'gpt-5.6-luna',
          effort: 'medium',
          serviceTier: 'priority',
        },
      })
      expect(reopened.dueSnoozedThreadIds(99)).toEqual([])
      expect(reopened.dueSnoozedThreadIds(100)).toEqual(['persisted'])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('touches active and snoozed threads without losing lifecycle state', () => {
    store.addThread({ id: 'touched', projectPath: '/repo', provider: 'codex', title: 'Touched' })
    store.setThreadKeepActive('touched', true, 10)

    expect(store.touchThread('touched', true, 20)).toEqual({
      state: 'active',
      keepActive: true,
    })
    expect(store.thread('touched')).toMatchObject({ lastActiveAt: 20, unread: true })

    store.snoozeThread('touched', 100, 30)
    expect(store.touchThread('touched', false, 40)).toEqual({
      state: 'active',
      keepActive: false,
      wokeAt: 40,
    })
    expect(store.thread('touched')).toMatchObject({ lastActiveAt: 40, unread: true })
    expect(() => store.touchThread('missing', false, 50)).toThrow('thread not found')
  })

  it('lists compact inactive candidates with the same eligibility and order', () => {
    store.addThread({
      id: 'early',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Early',
      createdAt: 10,
    })
    store.addThread({
      id: 'late',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Late',
      createdAt: 20,
    })
    store.addThread({ id: 'kept', projectPath: '/repo', provider: 'codex', title: 'Kept' })
    store.addThread({ id: 'snoozed', projectPath: '/repo', provider: 'codex', title: 'Snoozed' })
    store.addThread({ id: 'closed', projectPath: '/repo', provider: 'codex', title: 'Closed' })
    store.touchThread('early', true, 10)
    store.setThreadKeepActive('kept', true)
    store.snoozeThread('snoozed', 100)
    store.closeThread('closed')

    expect(store.inactiveThreadCandidates(15)).toEqual([{ id: 'early', unread: true }])
    expect(store.inactiveThreadCandidates(25)).toEqual([
      { id: 'early', unread: true },
      { id: 'late', unread: false },
    ])
  })

  it('rolls back a failed lifecycle update batch and clears cached projections', () => {
    store.addThread({
      id: 'batched',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Batched',
      createdAt: 10,
    })
    store.thread('batched')
    store.sidebarThreads()

    expect(() =>
      store.batchLifecycleUpdates(() => {
        store.settleInactiveThread('batched', 10, 20)
        throw new Error('stop lifecycle batch')
      }),
    ).toThrow('stop lifecycle batch')

    expect(store.thread('batched')?.lifecycle).toMatchObject({ state: 'active' })
    expect(
      store.sidebarThreads().find((thread) => thread.id === 'batched')?.lifecycle,
    ).toMatchObject({
      state: 'active',
    })
  })

  it('finds the next real lifecycle deadline without scanning thread rows', () => {
    store.updateSidebarSettings({ autoSettleDays: 3 })
    store.addThread({
      id: 'active-deadline',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Active',
      createdAt: 1_000,
    })
    store.addThread({
      id: 'snoozed-deadline',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Snoozed',
      createdAt: 2_000,
    })
    store.snoozeThread('snoozed-deadline', 50_000, 3_000)

    expect(store.nextLifecycleRefreshAt()).toBe(50_000)
    store.activateThread('snoozed-deadline', 4_000)
    expect(store.nextLifecycleRefreshAt()).toBe(1_000 + 3 * 24 * 60 * 60 * 1_000)
    store.setThreadKeepActive('active-deadline', true, 5_000)
    store.setThreadKeepActive('snoozed-deadline', true, 5_000)
    expect(store.nextLifecycleRefreshAt()).toBeUndefined()
  })

  it('starts new profiles with the classic sidebar and three-day settling', () => {
    expect(store.sidebarSettings()).toEqual({ mode: 'classic', autoSettleDays: 3 })
    expect(store.backgroundModelPreference()).toEqual({ mode: 'automatic' })
  })

  it('retains immutable settings snapshots until an update replaces them', () => {
    const sidebar = store.sidebarSettings()
    expect(store.sidebarSettings()).toBe(sidebar)
    const updatedSidebar = store.updateSidebarSettings({ mode: 'inbox' })
    expect(updatedSidebar).not.toBe(sidebar)
    expect(store.sidebarSettings()).toBe(updatedSidebar)
    expect(Object.isFrozen(updatedSidebar)).toBe(true)

    const automatic = store.backgroundModelPreference()
    expect(store.backgroundModelPreference()).toBe(automatic)
    const manual = store.updateBackgroundModelPreference({
      mode: 'manual',
      target: { provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
    })
    expect(manual).not.toBe(automatic)
    expect(store.backgroundModelPreference()).toBe(manual)
    expect(Object.isFrozen(manual)).toBe(true)
    expect(manual.mode === 'manual' && Object.isFrozen(manual.target)).toBe(true)
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

  it('uses replay snapshots only at valid history boundaries', () => {
    const snapshot = [{ seq: 1, event: message('cached') }]
    store.append('t1', message('one'))
    expect(store.saveReplaySnapshot('t1', 1, snapshot)).toBe(JSON.stringify(snapshot))

    expect(store.replaySnapshotBase('t1')).toEqual({ seq: 1, entries: snapshot })
    expect(store.tailReplaySnapshotForResponse('t1')?.entries).toBe(snapshot)

    store.addCheckpoint({ threadId: 't1', seq: 1, commit: 'abc', label: 'One' })
    store.append('t1', message('two'))
    expect(store.tailReplaySnapshotForResponse('t1')).toBeUndefined()
    expect(store.replaySnapshotBase('t1')).toEqual({ seq: 1, entries: snapshot })
    const token = store.saveRestoreUndo('t1', 1, 'def')
    expect(store.replaySnapshotBase('t1')).toBeUndefined()

    store.saveReplaySnapshot('t1', 1, snapshot)
    store.applyRestoreUndo('t1', token)
    expect(store.replaySnapshotBase('t1')).toBeUndefined()
  })

  it('bounds parsed replay snapshots and retains the most recently used threads', () => {
    const snapshots = new Map<string, Array<{ seq: number; event: DomainEvent }>>()
    for (let index = 1; index <= 64; index += 1) {
      const threadId = `t${index}`
      if (index > 1) {
        store.addThread({
          id: threadId,
          projectPath: '/repo',
          provider: 'codex',
          title: `Thread ${index}`,
        })
      }
      const seq = store.append(threadId, message(`thread-${index}`))
      const snapshot = [{ seq, event: message(`snapshot-${index}`) }]
      snapshots.set(threadId, snapshot)
      store.saveReplaySnapshot(threadId, seq, snapshot)
    }

    // Reading t1 makes it newer than t2 before the next snapshot arrives.
    expect(store.tailReplaySnapshotForResponse('t1')?.entries).toBe(snapshots.get('t1'))
    store.addThread({
      id: 't65',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Thread 65',
    })
    const newestSeq = store.append('t65', message('thread-65'))
    const newest = [{ seq: newestSeq, event: message('snapshot-65') }]
    store.saveReplaySnapshot('t65', newestSeq, newest)

    expect(store.tailReplaySnapshotForResponse('t1')?.entries).toBe(snapshots.get('t1'))
    expect(store.tailReplaySnapshotForResponse('t65')?.entries).toBe(newest)
    const restored = store.tailReplaySnapshotForResponse('t2')
    expect(restored?.entries).toEqual(snapshots.get('t2'))
    expect(restored?.entries).not.toBe(snapshots.get('t2'))
    expect(restored?.serializedEntries).toBe(JSON.stringify(snapshots.get('t2')))
    expect(store.tailReplaySnapshotForResponse('t2')).toEqual({ entries: restored?.entries })
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

  it('indexes user submission ids and keeps restore exact', () => {
    store.append('t1', message('assistant'))
    store.append('t1', userMessage('submission-1'))

    expect(store.hasUserSubmission('t1', 'i-assistant')).toBe(false)
    expect(store.hasUserSubmission('t1', 'submission-1')).toBe(true)

    const token = store.saveRestoreUndo('t1', 0, 'before-submission')
    expect(store.hasUserSubmission('t1', 'submission-1')).toBe(false)
    store.applyRestoreUndo('t1', token)
    expect(store.hasUserSubmission('t1', 'submission-1')).toBe(true)
  })

  it('indexes the latest turn diff and keeps restore exact', () => {
    const firstSeq = store.append('t1', {
      type: 'diff.updated',
      turnId: 'turn-1',
      diff: 'first patch',
    })
    store.append('t1', { type: 'diff.updated', turnId: 'turn-1', diff: 'final patch' })
    store.append('t1', { type: 'diff.updated', turnId: 'turn-2', diff: 'other patch' })

    expect(store.turnDiff('t1', 'turn-1')).toBe('final patch')
    expect(store.turnDiff('t1', 'turn-2')).toBe('other patch')
    expect(store.turnDiff('t1', 'missing')).toBeUndefined()

    const token = store.saveRestoreUndo('t1', firstSeq, 'before-final-patch')
    expect(store.turnDiff('t1', 'turn-1')).toBe('first patch')
    expect(store.turnDiff('t1', 'turn-2')).toBeUndefined()

    store.applyRestoreUndo('t1', token)
    expect(store.turnDiff('t1', 'turn-1')).toBe('final patch')
    expect(store.turnDiff('t1', 'turn-2')).toBe('other patch')
  })

  it('backfills user submission ids for an existing event log', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-submission-index-'))
    const file = path.join(dir, 'submissions.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
    seeded.append('one', userMessage('submission-1'))
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.exec(`DELETE FROM user_submission_items`)
    raw.prepare(`DELETE FROM schema_migrations WHERE name = ?`).run('user_submission_items_v1')
    raw.close()

    const reopened = new Store(file)
    try {
      expect(reopened.hasUserSubmission('one', 'submission-1')).toBe(true)
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('backfills turn diffs for an existing event log', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-turn-diff-index-'))
    const file = path.join(dir, 'turn-diffs.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
    seeded.append('one', { type: 'diff.updated', turnId: 'turn-1', diff: 'persisted patch' })
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.exec(`DELETE FROM turn_diff_events`)
    raw.prepare(`DELETE FROM schema_migrations WHERE name = ?`).run('turn_diff_events_v1')
    raw.close()

    const reopened = new Store(file)
    try {
      expect(reopened.turnDiff('one', 'turn-1')).toBe('persisted patch')
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rebuilds every missing derived index together from one existing event log', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-derived-indexes-'))
    const file = path.join(dir, 'derived.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
    seeded.append('one', userMessage('submission-1'))
    seeded.append('one', message('searchable needle'))
    seeded.append('one', usage(7))
    seeded.append('one', { type: 'diff.updated', turnId: 'turn-1', diff: 'persisted patch' })
    seeded.append('one', {
      type: 'turn.started',
      turn: { id: 'open-turn', threadId: 'one', status: 'running', createdAt: 1 },
    })
    seeded.append('one', {
      type: 'approval.requested',
      request: { id: 'approval-1', kind: 'command', createdAt: 2 },
    })
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.exec(`
      DELETE FROM session_search;
      DELETE FROM usage_events;
      DELETE FROM inbox_events;
      DELETE FROM user_submission_items;
      DELETE FROM turn_diff_events;
      DELETE FROM recovery_lifecycles;
      DELETE FROM recovery_errors;
      DELETE FROM schema_migrations;
    `)
    raw.close()

    const reopened = new Store(file)
    try {
      expect(reopened.searchSessions({ query: 'needle' }).results).toHaveLength(1)
      expect(reopened.usageSummary('one', 0).session.totalTokens).toBe(7)
      expect(reopened.inboxProjections().get('one')?.approvals).toEqual(new Set(['approval-1']))
      expect(reopened.hasUserSubmission('one', 'submission-1')).toBe(true)
      expect(reopened.turnDiff('one', 'turn-1')).toBe('persisted patch')
      expect(reopened.recoverInterruptedThreads()).toEqual(['one'])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists a cross-thread event window with ordered sequence numbers', () => {
    store.addThread({ id: 't2', projectPath: '/repo', provider: 'codex', title: 'Two' })
    const sequences = store
      .appendBatchWithSerializedEvents([
        { threadId: 't1', event: message('one') },
        { threadId: 't2', event: message('two') },
      ])
      .map(({ seq }) => seq)

    expect(sequences).toHaveLength(2)
    expect(sequences[1]).toBe((sequences[0] ?? 0) + 1)
    expect(store.history('t1').map(({ event }) => event)).toEqual([message('one')])
    expect(store.history('t2').map(({ event }) => event)).toEqual([message('two')])
  })

  it('never hands one thread another thread events', () => {
    store.addThread({ id: 't2', projectPath: '/repo', provider: 'codex', title: 'Two' })
    store.append('t1', message('mine'))
    store.append('t2', message('theirs'))

    expect(store.history('t1')).toHaveLength(1)
    expect(store.history('t2')).toHaveLength(1)
  })

  it('builds exact inbox projections for every thread in bulk', () => {
    store.addThread({ id: 't2', projectPath: '/repo', provider: 'codex', title: 'Two' })
    store.addThread({ id: 't3', projectPath: '/repo', provider: 'codex', title: 'Three' })
    store.append('t1', message('irrelevant transcript text'))
    store.append('t1', {
      type: 'approval.requested',
      request: { id: 'approval-1', kind: 'command', createdAt: 1 },
    })
    store.append('t1', { type: 'approval.resolved', id: 'approval-1' })
    store.append('t1', userInput('input-1', 'turn-1'))
    store.append('t1', { type: 'thread.error', threadId: 't1', message: 'failed' })
    store.append('t1', { type: 'turn.completed', turnId: 'turn-1', status: 'completed' })
    store.append('t3', { type: 'turn.completed', turnId: 'turn-3', status: 'completed' })
    store.append('t3', { type: 'thread.error', threadId: 't3', message: 'failed last' })
    store.append('t3', {
      type: 'approval.requested',
      request: { id: 'approval-3', kind: 'command', createdAt: 3 },
    })

    const projections = store.inboxProjections()

    expect(projections.size).toBe(2)
    expect(projections.get('t1')).toEqual({
      inputs: new Set(['input-1']),
      last: 'idle',
    })
    expect(projections.get('t2')).toBeUndefined()
    expect(projections.get('t3')).toEqual({
      approvals: new Set(['approval-3']),
      last: 'failed',
    })
  })

  it('stores only current non-default inbox state after a long history', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-inbox-current-'))
    const file = path.join(dir, 'inbox.db')
    try {
      const indexed = new Store(file)
      try {
        indexed.addProject('/repo')
        indexed.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
        for (let index = 0; index < 100; index += 1) {
          indexed.append('one', {
            type: 'turn.completed',
            turnId: `turn-${index}`,
            status: 'completed',
          })
        }
        indexed.append('one', { type: 'thread.error', threadId: 'one', message: 'old failure' })
        indexed.append('one', {
          type: 'turn.completed',
          turnId: 'recovered',
          status: 'completed',
        })
        const approval = {
          type: 'approval.requested' as const,
          request: { id: 'approval-1', kind: 'command' as const, createdAt: 1 },
        }
        indexed.append('one', approval)
        indexed.append('one', approval)
        indexed.append('one', userInput('input-1', 'turn-input'))
        indexed.append('one', { type: 'user_input.resolved', id: 'input-1' })
        indexed.append('one', { type: 'thread.error', threadId: 'one', message: 'current failure' })

        expect(indexed.inboxProjections().get('one')).toEqual({
          approvals: new Set(['approval-1']),
          last: 'failed',
        })
      } finally {
        indexed.close()
      }

      const raw = new DatabaseSync(file)
      try {
        const row = raw.prepare(`SELECT COUNT(*) AS count FROM inbox_events`).get() as {
          count: number | bigint
        }
        expect(Number(row.count)).toBe(2)
      } finally {
        raw.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('backfills the compact inbox index for an existing event log', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-inbox-index-'))
    const file = path.join(dir, 'inbox.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
    seeded.append('one', message('irrelevant history'))
    seeded.append('one', { type: 'thread.error', threadId: 'one', message: 'failed' })
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.exec(`DELETE FROM inbox_events`)
    raw.prepare(`DELETE FROM schema_migrations WHERE name = ?`).run('inbox_events_v2')
    raw.close()

    const reopened = new Store(file)
    try {
      expect(reopened.inboxProjections().get('one')?.last).toBe('failed')
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes and restores indexed inbox state with a reversible transcript restore', () => {
    store.append('t1', {
      type: 'turn.completed',
      turnId: 'turn-1',
      status: 'completed',
    })
    const keepSeq = store.append('t1', {
      type: 'approval.requested',
      request: { id: 'approval-1', kind: 'command', createdAt: 1 },
    })
    store.append('t1', { type: 'approval.resolved', id: 'approval-1' })
    store.append('t1', { type: 'thread.error', threadId: 't1', message: 'temporary failure' })
    expect(store.inboxProjections().get('t1')).toEqual({ last: 'failed' })

    const token = store.saveRestoreUndo('t1', keepSeq, 'before-failure')
    expect(store.inboxProjections().get('t1')).toEqual({
      approvals: new Set(['approval-1']),
      last: 'idle',
    })

    store.applyRestoreUndo('t1', token)
    expect(store.inboxProjections().get('t1')).toEqual({ last: 'failed' })
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
    const repeated = store.searchSessions({ query: 'stableidentity' }).results
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

  it('reuses unchanged rankings and refreshes them after a searchable event', () => {
    for (let index = 0; index < 3; index += 1) {
      store.append('t1', message(`rankingcache old-${index}`))
    }

    const first = store.searchSessions({ query: 'rankingcache', limit: 1 })
    const repeated = store.searchSessions({ query: 'rankingcache', limit: 1 })
    expect(repeated.nextCursor).toBe(first.nextCursor)

    store.append('t1', message('rankingcache newest'))
    const fresh = store.searchSessions({ query: 'rankingcache', limit: 1 })
    expect(fresh.nextCursor).not.toBe(first.nextCursor)
    expect(fresh.results[0]?.snippet.map((part) => part.text).join('')).toBe('rankingcache newest')

    const originalSecondPage = store.searchSessions({
      query: 'rankingcache',
      cursor: first.nextCursor!,
      limit: 1,
    })
    expect(originalSecondPage.results[0]?.snippet.map((part) => part.text).join('')).toBe(
      'rankingcache old-1',
    )
  })

  it('keeps a cached ranking when a new searchable row cannot match it', () => {
    for (let index = 0; index < 3; index += 1) {
      store.append('t1', message(`stablecache result-${index}`))
    }

    const first = store.searchSessions({ query: 'stablecache', limit: 1 })
    store.append('t1', message('unrelated searchable text'))
    const repeated = store.searchSessions({ query: 'stablecache', limit: 1 })

    expect(repeated).toEqual(first)
  })

  it('keeps filtered rankings when matching rows land outside their project or provider', () => {
    store.addProject('/other', 'Other')
    store.addThread({
      id: 'outside-project',
      projectPath: '/other',
      provider: 'codex',
      title: 'Other',
    })
    store.addThread({
      id: 'outside-provider',
      projectPath: '/repo',
      provider: 'grok',
      title: 'Grok',
    })
    for (let index = 0; index < 3; index += 1) {
      store.append('t1', message(`filteredcache result-${index}`))
    }

    const options = {
      query: 'filteredcache',
      projectPath: '/repo',
      provider: 'codex' as const,
      limit: 1,
    }
    const first = store.searchSessions(options)

    store.append('outside-project', message('filteredcache outside project'))
    expect(store.searchSessions(options)).toEqual(first)

    store.append('outside-provider', message('filteredcache outside provider'))
    expect(store.searchSessions(options)).toEqual(first)

    store.append('t1', message('filteredcache included newest'))
    const fresh = store.searchSessions(options)
    expect(fresh.nextCursor).not.toBe(first.nextCursor)
    expect(fresh.results[0]?.snippet.map((part) => part.text).join('')).toBe(
      'filteredcache included newest',
    )
  })

  it('invalidates a cached ranking when ASCII punctuation separates a matching token', () => {
    store.append('t1', message('bar old result'))
    const first = store.searchSessions({ query: 'bar', limit: 1 })

    store.append('t1', message('foo_bar newest result'))
    const fresh = store.searchSessions({ query: 'bar', limit: 1 })

    expect(fresh.nextCursor).not.toBe(first.nextCursor)
    expect(
      store.searchSessions({ query: 'bar' }).results.some((result) =>
        result.snippet
          .map((part) => part.text)
          .join('')
          .includes('foo_bar'),
      ),
    ).toBe(true)
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
        const continuation = z
          .object({ position: z.number() })
          .parse(JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')))
        expect(continuation.position).toBeGreaterThan(pages * 2)
      }
      cursor = page.nextCursor ?? undefined
      pages += 1
    } while (cursor)

    expect(pages).toBe(103)
    expect(seen.size).toBe(205)
  })

  it('paginates row IDs above the uint32 range without truncating them', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-search-wide-rowid-'))
    const file = path.join(dir, 'wide-rowid.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'Search' })
    seeded.append('t1', message('sequence seed'))
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'`).run(0xffff_ffff)
    raw.close()

    const reopened = new Store(file)
    try {
      for (let index = 0; index < 102; index += 1) {
        reopened.append('t1', message(`wide row marker ${String(index).padStart(3, '0')}`))
      }

      const first = reopened.searchSessions({ query: 'wide row marker', limit: 1 })
      const second = reopened.searchSessions({
        query: 'wide row marker',
        limit: 1,
        cursor: first.nextCursor!,
      })

      expect(first.nextCursor).not.toBeNull()
      expect(second.nextCursor).not.toBeNull()
      expect(
        [first.results[0], second.results[0]].map((result) =>
          result?.snippet.map((part) => part.text).join(''),
        ),
      ).toEqual(['wide row marker 101', 'wide row marker 100'])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
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

  it('bounds abandoned search snapshots and retains recently used cursors', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-11T10:00:00Z'))
      const cursors: string[] = []
      for (let index = 0; index < 8; index += 1) {
        store.append('t1', message(`cacheterm${index} first`))
        store.append('t1', message(`cacheterm${index} second`))
        const page = store.searchSessions({ query: `cacheterm${index}`, limit: 1 })
        expect(page.nextCursor).not.toBeNull()
        cursors.push(page.nextCursor!)
      }

      // Touch the oldest snapshot while the clock is fixed. Recency must not
      // depend on timestamp sort stability when several searches share a tick.
      expect(
        store.searchSessions({ query: 'cacheterm0', cursor: cursors[0], limit: 1 }).results,
      ).toHaveLength(1)

      store.append('t1', message('cacheterm8 first'))
      store.append('t1', message('cacheterm8 second'))
      expect(store.searchSessions({ query: 'cacheterm8', limit: 1 }).nextCursor).not.toBeNull()

      expect(() =>
        store.searchSessions({ query: 'cacheterm1', cursor: cursors[1], limit: 1 }),
      ).toThrow('expired')
      expect(
        store.searchSessions({ query: 'cacheterm0', cursor: cursors[0], limit: 1 }).results,
      ).toHaveLength(1)
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

  it('highlights prefix and diacritic-insensitive search matches', () => {
    store.append('t1', message('Résumé performance report'))

    const snippet = store.searchSessions({ query: 'resume perf' }).results[0]!.snippet

    expect(snippet.filter((part) => part.highlighted).map((part) => part.text)).toEqual([
      'Résumé',
      'performance',
    ])
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
    expect(() => store.setDiffDecision('t1', 'hunk:one', 'invalid')).toThrow()
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

  it('backfills the usage index for an existing event log', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-usage-index-'))
    const file = path.join(dir, 'usage.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
    seeded.append('one', usage(75))
    seeded.close()

    const raw = new DatabaseSync(file)
    raw.exec(`DELETE FROM usage_events`)
    raw.prepare(`DELETE FROM schema_migrations WHERE name = ?`).run('usage_events_v1')
    raw.close()

    const reopened = new Store(file)
    try {
      expect(reopened.usageSummary('one', 0).session.totalTokens).toBe(75)
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes and restores indexed usage with a reversible transcript restore', () => {
    store.addProject('/repo')
    store.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
    store.append('one', usage(90))

    const token = store.saveRestoreUndo('one', 0, 'before-usage')
    expect(store.usageSummary('one', 0).session.totalTokens).toBe(0)

    store.applyRestoreUndo('one', token)
    expect(store.usageSummary('one', 0).session.totalTokens).toBe(90)
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
describe('sensitive file permissions', () => {
  const posixOnly = process.platform === 'win32' ? it.skip : it

  posixOnly('creates the database, its sidecars, and its directory with user-only access', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-store-perms-'))
    const file = path.join(dir, 'nested', 'harness.db')
    const db = new Store(file)
    try {
      db.addProject('/repo')
      db.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
      db.append('t1', message('hello'))

      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
      // WAL carries the same rows while the connection is open; SHM goes away
      // on a clean shutdown, so only assert it when present.
      expect(existsSync(`${file}-wal`)).toBe(true)
      expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600)
      if (existsSync(`${file}-shm`)) {
        expect(statSync(`${file}-shm`).mode & 0o777).toBe(0o600)
      }
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  posixOnly('creates private files even under a permissive umask', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-store-perms-umask-'))
    const file = path.join(dir, 'harness.db')
    const previous = process.umask(0o022)
    try {
      const db = new Store(file)
      try {
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(statSync(dir).mode & 0o777).toBe(0o700)
        expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600)
      } finally {
        db.close()
      }
    } finally {
      process.umask(previous)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('closes the handle when opening a corrupt database fails', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-store-perms-corrupt-'))
    const file = path.join(dir, 'harness.db')
    writeFileSync(file, 'not a database at all')
    const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close')
    try {
      expect(() => new Store(file)).toThrow()
      expect(closeSpy).toHaveBeenCalled()
    } finally {
      closeSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('closes the handle when post-open setup fails', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-store-perms-key-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.close()
    const raw = new DatabaseSync(file)
    try {
      raw
        .prepare(`UPDATE app_settings SET value = ? WHERE key = ?`)
        .run('bogus', 'search_result_key_v1')
    } finally {
      raw.close()
    }
    const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close')
    try {
      expect(() => new Store(file)).toThrow('Search result identity key')
      expect(closeSpy).toHaveBeenCalled()
    } finally {
      closeSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  posixOnly('tightens files and directories left readable by an older build', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-store-perms-loose-'))
    const file = path.join(dir, 'harness.db')
    const seeded = new Store(file)
    seeded.addProject('/repo')
    seeded.close()
    chmodSync(file, 0o644)
    chmodSync(dir, 0o755)
    if (existsSync(`${file}-wal`)) chmodSync(`${file}-wal`, 0o644)

    const reopened = new Store(file)
    try {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      if (existsSync(`${file}-wal`)) {
        expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600)
      }
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
