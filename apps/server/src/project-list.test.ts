import { describe, expect, it } from 'vitest'
import type { ThreadInboxStatus } from '@harness/contracts'
import { createProjectListProjector, type ProjectListState } from './project-list.js'
import type { StoredProject, StoredSidebarThread } from './store.js'

const projects: StoredProject[] = [
  { path: '/one', name: 'One', pinned: false, createdAt: 1 },
  { path: '/two', name: 'Two', pinned: true, createdAt: 2 },
]
const threads: StoredSidebarThread[] = [
  {
    id: 'a',
    projectPath: '/one',
    provider: 'codex',
    title: 'A',
    pinned: false,
    createdAt: 2,
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  },
  {
    id: 'b',
    projectPath: '/two',
    provider: 'claude-code',
    title: 'B',
    pinned: true,
    createdAt: 1,
    lifecycle: { state: 'settled', settledAt: 3, reason: 'manual' },
    unread: true,
  },
]

describe('projects.list projector', () => {
  it('reuses unchanged rows and replaces only changed status or metadata', () => {
    const statuses = new Map<string, ThreadInboxStatus>([
      ['a', 'idle'],
      ['b', 'ready'],
    ])
    const running = new Set<string>()
    let revision = 0
    let stateReads = 0
    const state: ProjectListState = {
      isTurnRunning: (threadId) => {
        stateReads += 1
        return running.has(threadId)
      },
      inboxStatus: (threadId, queued) => {
        stateReads += 1
        return queued ? 'queued' : (statuses.get(threadId) ?? 'idle')
      },
      revision: () => revision,
    }
    const queuedThreadIds = new Set<string>()
    const project = createProjectListProjector()
    const first = project(projects, threads, queuedThreadIds, state)
    const readsAfterFirst = stateReads
    const unchanged = project(projects, threads, queuedThreadIds, state)
    expect(unchanged).toBe(first)
    expect(stateReads).toBe(readsAfterFirst)

    running.add('a')
    statuses.set('a', 'working')
    revision += 1
    const active = project(projects, threads, new Set(), state)
    expect(active).not.toBe(first)
    expect(active.projects[0]?.sessions[0]).toMatchObject({ running: true, status: 'working' })
    expect(active.projects[1]).toBe(first.projects[1])

    const renamedThreads = [{ ...threads[0]!, title: 'Renamed' }, threads[1]!]
    const renamed = project(projects, renamedThreads, new Set(['b']), state)
    expect(renamed.projects[0]?.sessions[0]?.title).toBe('Renamed')
    expect(renamed.projects[1]?.sessions[0]?.status).toBe('queued')
  })

  it('reads only the rows named by an in-memory status change', () => {
    const statuses = new Map<string, ThreadInboxStatus>([
      ['a', 'idle'],
      ['b', 'ready'],
    ])
    const running = new Set<string>()
    const queuedThreadIds = new Set<string>()
    let revision = 0
    let changes: readonly string[] = []
    let stateReads = 0
    const state: ProjectListState = {
      isTurnRunning: (threadId) => {
        stateReads += 1
        return running.has(threadId)
      },
      inboxStatus: (threadId) => {
        stateReads += 1
        return statuses.get(threadId) ?? 'idle'
      },
      revision: () => revision,
      changesSince: (previousRevision) => (previousRevision < revision ? changes : []),
    }
    const project = createProjectListProjector()
    const first = project(projects, threads, queuedThreadIds, state)
    const readsAfterFirst = stateReads

    running.add('a')
    statuses.set('a', 'working')
    changes = ['a']
    revision += 1
    const active = project(projects, threads, queuedThreadIds, state)

    expect(stateReads - readsAfterFirst).toBe(2)
    expect(active.projects[0]?.sessions[0]).toMatchObject({ running: true, status: 'working' })
    expect(active.projects[1]).toBe(first.projects[1])

    changes = ['side-chat-thread']
    revision += 1
    const sideChatOnly = project(projects, threads, queuedThreadIds, state)
    expect(sideChatOnly).toBe(active)
    expect(stateReads - readsAfterFirst).toBe(2)
  })
})
