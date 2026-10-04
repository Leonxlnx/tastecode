import { bench, describe } from 'vitest'
import type { ThreadInboxStatus } from '@harness/contracts'
import type { StoredProject, StoredSidebarThread } from './store.js'
import { createProjectListProjector, type ProjectListState } from './project-list.js'
import { createSerializedResultCache, serializeSuccessResponse } from './response-serializer.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const projects: StoredProject[] = Array.from({ length: 100 }, (_, index) => ({
  path: `/project-${index}`,
  name: `Project ${index}`,
  pinned: index < 3,
  createdAt: index,
}))
const threads: StoredSidebarThread[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `thread-${index}`,
  projectPath: `/project-${index % projects.length}`,
  provider: 'codex',
  title: `Thread ${index}`,
  pinned: index % 100 === 0,
  createdAt: index,
  lifecycle: { state: 'active', keepActive: false },
  unread: index % 25 === 0,
}))
const statuses = new Map<string, ThreadInboxStatus>(
  threads.map((thread) => [thread.id, thread.unread ? 'ready' : 'idle']),
)
let statusRevision = 0
const state: ProjectListState = {
  isTurnRunning: (threadId) => statuses.get(threadId) === 'working',
  inboxStatus: (threadId) => statuses.get(threadId) ?? 'idle',
  revision: () => statusRevision,
  changesSince: (previousRevision) => (previousRevision < statusRevision ? ['thread-9999'] : []),
}
const queuedThreadIds = new Set<string>()
const projector = createProjectListProjector()
projector(projects, threads, queuedThreadIds, state)
const scanningStatuses = new Map(statuses)
let scanningStatusRevision = 0
let scanningChangedStatus: ThreadInboxStatus = 'working'
const scanningState: ProjectListState = {
  isTurnRunning: (threadId) => scanningStatuses.get(threadId) === 'working',
  inboxStatus: (threadId) => scanningStatuses.get(threadId) ?? 'idle',
  revision: () => scanningStatusRevision,
}
const scanningProjector = createProjectListProjector()
scanningProjector(projects, threads, queuedThreadIds, scanningState)
const serializeProjectList = createSerializedResultCache()
let requestId = 0
let changedStatus: ThreadInboxStatus = 'working'

function projectOneStatusChange() {
  changedStatus = changedStatus === 'working' ? 'idle' : 'working'
  statuses.set('thread-9999', changedStatus)
  statusRevision += 1
  return projector(projects, threads, queuedThreadIds, state)
}

function scanOneStatusChange() {
  scanningChangedStatus = scanningChangedStatus === 'working' ? 'idle' : 'working'
  scanningStatuses.set('thread-9999', scanningChangedStatus)
  scanningStatusRevision += 1
  return scanningProjector(projects, threads, queuedThreadIds, scanningState)
}

function legacyProjectList() {
  const threadsByProject = new Map<string, StoredSidebarThread[]>(
    projects.map((project) => [project.path, []]),
  )
  for (const thread of threads) threadsByProject.get(thread.projectPath)?.push(thread)
  return {
    projects: projects.map((project) => ({
      ...project,
      sessions: (threadsByProject.get(project.path) ?? []).map((thread) => ({
        id: thread.id,
        title: thread.title,
        pinned: thread.pinned,
        provider: thread.provider,
        ...(thread.agent === undefined ? {} : { agent: thread.agent }),
        createdAt: thread.createdAt,
        running: statuses.get(thread.id) === 'working',
        status: statuses.get(thread.id) ?? 'idle',
        unread: thread.unread,
        lifecycle: thread.lifecycle,
        ...(thread.worktreeBranch === undefined ? {} : { worktreeBranch: thread.worktreeBranch }),
        ...(thread.closedAt === undefined ? {} : { closedAt: thread.closedAt }),
      })),
    })),
  }
}

describe('many-thread projects.list response', () => {
  bench(
    'rebuilds all 10,000 session response objects',
    () => {
      if (legacyProjectList().projects.length !== projects.length) throw new Error('bad projection')
    },
    OPTIONS,
  )

  bench(
    'rebuilds and serializes all 10,000 session response objects',
    () => {
      if (JSON.stringify(legacyProjectList()).length < 1_000_000) throw new Error('bad response')
    },
    OPTIONS,
  )

  bench(
    'reuses unchanged response objects',
    () => {
      if (
        projector(projects, threads, queuedThreadIds, state).projects.length !== projects.length
      ) {
        throw new Error('bad retained projection')
      }
    },
    OPTIONS,
  )

  bench(
    'rescans 10,000 sessions for one changed status',
    () => {
      if (scanOneStatusChange().projects.length !== projects.length) {
        throw new Error('bad scanned projection')
      }
    },
    OPTIONS,
  )

  bench(
    'updates the exact changed status row',
    () => {
      if (projectOneStatusChange().projects.length !== projects.length) {
        throw new Error('bad changed projection')
      }
    },
    OPTIONS,
  )

  bench(
    'reuses objects and serializes all 10,000 sessions',
    () => {
      if (JSON.stringify(projector(projects, threads, queuedThreadIds, state)).length < 1_000_000) {
        throw new Error('bad retained response')
      }
    },
    OPTIONS,
  )

  bench(
    'reuses the encoded immutable response',
    () => {
      const response = serializeSuccessResponse(
        String((requestId += 1)),
        serializeProjectList(projector(projects, threads, queuedThreadIds, state)),
      )
      if (response.length < 1_000_000) throw new Error('bad cached response')
    },
    OPTIONS,
  )
})
