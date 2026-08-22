import { bench, describe } from 'vitest'
import type { Project, Session } from './ui/Sidebar.js'
import { findSession, reconcileProjects, removeSession, updateSession } from './project-store.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }

function session(id: string): Session {
  return {
    id,
    title: id,
    provider: 'codex',
    createdAt: 0,
    status: 'idle',
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  }
}

const projects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) =>
    session(`thread-${projectIndex}-${sessionIndex}`),
  ),
}))
const target = 'thread-99-99'
const refreshedProjects = projects.map((project) => ({
  ...project,
  sessions: project.sessions.map((entry) => ({
    ...entry,
    lifecycle: { ...entry.lifecycle },
  })),
}))

function legacyUpdateSession(
  current: Project[],
  threadId: string,
  update: (entry: Session) => Session,
): Project[] {
  return current.map((project) => ({
    ...project,
    sessions: project.sessions.map((entry) => (entry.id === threadId ? update(entry) : entry)),
  }))
}

function legacyFindSession(current: Project[], threadId: string): Session | undefined {
  for (const project of current) {
    const entry = project.sessions.find((session) => session.id === threadId)
    if (entry) return entry
  }
  return undefined
}

function legacyRemoveSession(current: Project[], threadId: string): Project[] {
  return current.map((project) => ({
    ...project,
    sessions: project.sessions.filter((session) => session.id !== threadId),
  }))
}

function legacyReconcileProjects(current: Project[], snapshot: Project[]): Project[] {
  const currentByPath = new Map(current.map((project) => [project.path, project]))
  let treeChanged = current.length !== snapshot.length
  const nextProjects = snapshot.map((project, projectIndex) => {
    const previous = currentByPath.get(project.path)
    if (!previous) {
      treeChanged = true
      return project
    }

    const currentById = new Map(previous.sessions.map((entry) => [entry.id, entry]))
    let sessionsChanged = previous.sessions.length !== project.sessions.length
    const sessions = project.sessions.map((entry, sessionIndex) => {
      const prior = currentById.get(entry.id)
      if (!prior) {
        sessionsChanged = true
        return entry
      }
      const next = sameSession(prior, entry) ? prior : entry
      if (next !== previous.sessions[sessionIndex]) sessionsChanged = true
      return next
    })
    const sameProject =
      previous.name === project.name && previous.pinned === project.pinned && !sessionsChanged
    const next = sameProject
      ? previous
      : { ...project, sessions: sessionsChanged ? sessions : previous.sessions }
    if (next !== current[projectIndex]) treeChanged = true
    return next
  })
  return treeChanged ? nextProjects : current
}

function sameSession(current: Session, snapshot: Session): boolean {
  return (
    current.title === snapshot.title &&
    current.provider === snapshot.provider &&
    current.agent === snapshot.agent &&
    current.createdAt === snapshot.createdAt &&
    current.status === snapshot.status &&
    current.statusSince === snapshot.statusSince &&
    sameLifecycle(current.lifecycle, snapshot.lifecycle) &&
    current.unread === snapshot.unread &&
    current.pinned === snapshot.pinned &&
    current.worktreeBranch === snapshot.worktreeBranch
  )
}

function sameLifecycle(current: Session['lifecycle'], snapshot: Session['lifecycle']): boolean {
  if (current.state !== snapshot.state) return false
  if (current.state === 'active' && snapshot.state === 'active') {
    return current.keepActive === snapshot.keepActive && current.wokeAt === snapshot.wokeAt
  }
  if (current.state === 'settled' && snapshot.state === 'settled') {
    return current.settledAt === snapshot.settledAt && current.reason === snapshot.reason
  }
  if (current.state === 'snoozed' && snapshot.state === 'snoozed') {
    return current.snoozedAt === snapshot.snoozedAt && current.wakeAt === snapshot.wakeAt
  }
  return false
}

const update = (entry: Session): Session => ({
  ...entry,
  status: entry.status === 'working' ? 'idle' : 'working',
})

describe('many-thread sidebar updates', () => {
  bench(
    'legacy full-tree copy for one of 10,000 sessions',
    () => {
      legacyUpdateSession(projects, target, update)
    },
    OPTIONS,
  )

  bench(
    'indexed structural copy for one of 10,000 sessions',
    () => {
      updateSession(projects, target, update)
    },
    OPTIONS,
  )
})

describe('many-thread sidebar lookups', () => {
  bench(
    'linear lookup for one of 10,000 sessions',
    () => {
      if (!legacyFindSession(projects, target)) throw new Error('missing target')
    },
    OPTIONS,
  )

  bench(
    'indexed lookup for one of 10,000 sessions',
    () => {
      if (!findSession(projects, target)) throw new Error('missing target')
    },
    OPTIONS,
  )
})

describe('many-thread sidebar deletion', () => {
  bench(
    'filters the full 10,000-session tree',
    () => {
      legacyRemoveSession(projects, target)
    },
    OPTIONS,
  )

  bench(
    'removes the indexed session from its owning project',
    () => {
      removeSession(projects, target)
    },
    OPTIONS,
  )
})

describe('unchanged many-thread snapshot reconciliation', () => {
  bench(
    'indexes every project before matching 10,000 stable sessions',
    () => {
      if (legacyReconcileProjects(projects, refreshedProjects) !== projects) {
        throw new Error('legacy snapshot changed')
      }
    },
    OPTIONS,
  )

  bench(
    'matches 10,000 stable sessions by position',
    () => {
      if (reconcileProjects(projects, refreshedProjects) !== projects) {
        throw new Error('snapshot changed')
      }
    },
    OPTIONS,
  )
})
