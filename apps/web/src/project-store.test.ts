import { describe, expect, it } from 'vitest'
import type { ResultOf } from '@harness/contracts'
import type { Project, Session } from './ui/Sidebar.js'
import {
  findSession,
  markSessionRead,
  promoteSession,
  reconcileProjectList,
  reconcileProjects,
  removeSession,
  takeProjectSessionChanges,
  updateSession,
} from './project-store.js'

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

function projects(projectCount: number, sessionsPerProject: number): Project[] {
  return Array.from({ length: projectCount }, (_, projectIndex) => ({
    path: `/project-${projectIndex}`,
    sessions: Array.from({ length: sessionsPerProject }, (_, sessionIndex) =>
      session(`thread-${projectIndex}-${sessionIndex}`),
    ),
  }))
}

function serverProjects(
  projectCount: number,
  sessionsPerProject: number,
): ResultOf<'projects.list'>['projects'] {
  return Array.from({ length: projectCount }, (_, projectIndex) => ({
    path: `/project-${projectIndex}`,
    name: `Project ${projectIndex}`,
    pinned: projectIndex === 0,
    createdAt: projectIndex,
    sessions: Array.from({ length: sessionsPerProject }, (_, sessionIndex) => ({
      id: `thread-${projectIndex}-${sessionIndex}`,
      title: `Thread ${projectIndex}-${sessionIndex}`,
      provider: 'codex' as const,
      createdAt: sessionIndex,
      running: false,
      pinned: false,
      status: 'idle' as const,
      unread: false,
      lifecycle: { state: 'active' as const, keepActive: false },
    })),
  }))
}

describe('project session updates', () => {
  it('copies only the project and session array that changed', () => {
    const current = projects(100, 100)
    const next = updateSession(current, 'thread-50-50', (entry) => ({
      ...entry,
      status: 'working',
    }))

    expect(next).not.toBe(current)
    expect(next[49]).toBe(current[49])
    expect(next[50]).not.toBe(current[50])
    expect(next[50]?.sessions).not.toBe(current[50]?.sessions)
    expect(next[50]?.sessions[49]).toBe(current[50]?.sessions[49])
    expect(next[50]?.sessions[50]?.status).toBe('working')
    expect(next[51]).toBe(current[51])
  })

  it('retains the complete tree when the target or value did not change', () => {
    const current = projects(2, 2)

    expect(updateSession(current, 'missing', (entry) => entry)).toBe(current)
    expect(updateSession(current, 'thread-1-1', (entry) => entry)).toBe(current)
  })

  it('reuses exact locations across consecutive immutable updates', () => {
    const current = projects(100, 100)
    const first = updateSession(current, 'thread-99-99', (entry) => ({
      ...entry,
      status: 'working',
    }))
    const second = updateSession(first, 'thread-0-0', (entry) => ({
      ...entry,
      unread: true,
    }))

    expect(findSession(second, 'thread-99-99')?.session.status).toBe('working')
    expect(findSession(second, 'thread-0-0')?.session.unread).toBe(true)
    expect(second[1]).toBe(current[1])
  })

  it('retains precise locations across batched immutable updates', () => {
    const current = projects(2, 2)
    const first = updateSession(current, 'thread-0-1', (entry) => ({
      ...entry,
      status: 'working',
    }))
    const second = updateSession(first, 'thread-1-0', (entry) => ({
      ...entry,
      unread: true,
    }))

    expect(takeProjectSessionChanges(current, second)).toEqual([
      { projectIndex: 0, sessionIndex: 1 },
      { projectIndex: 1, sessionIndex: 0 },
    ])
    expect(takeProjectSessionChanges(current, second)).toBeUndefined()
  })

  it('rebuilds the index after external reordering and promotes the right chat', () => {
    const current = projects(2, 3)
    const reordered = [current[1]!, current[0]!]
    const promoted = promoteSession(reordered, 'thread-0-2')

    expect(findSession(reordered, 'thread-0-2')?.project.path).toBe('/project-0')
    expect(promoted[1]?.sessions.map(({ id }) => id)).toEqual([
      'thread-0-2',
      'thread-0-0',
      'thread-0-1',
    ])
    expect(promoted[0]).toBe(reordered[0])
  })

  it('removes one chat without copying unrelated projects', () => {
    const current = projects(100, 100)
    const next = removeSession(current, 'thread-50-50')

    expect(next[49]).toBe(current[49])
    expect(next[50]).not.toBe(current[50])
    expect(next[50]?.sessions).toHaveLength(99)
    expect(findSession(next, 'thread-50-50')).toBeUndefined()
    expect(next[51]).toBe(current[51])
    expect(removeSession(current, 'missing')).toBe(current)
  })
})

describe('full project snapshot reconciliation', () => {
  it('retains the complete tree for an unchanged server snapshot', () => {
    const current = projects(100, 100)
    const snapshot = current.map((project) => ({
      ...project,
      sessions: project.sessions.map((entry) => ({
        ...entry,
        lifecycle: { ...entry.lifecycle },
      })),
    }))

    expect(reconcileProjects(current, snapshot)).toBe(current)
  })

  it('copies only one changed chat and preserves a stable working clock', () => {
    const current = projects(2, 2)
    current[1]!.sessions[1] = {
      ...current[1]!.sessions[1]!,
      status: 'working',
      statusSince: 100,
    }
    const snapshot = current.map((project) => ({
      ...project,
      sessions: project.sessions.map((entry) => ({
        ...entry,
        statusSince: entry.status === 'working' ? 999 : entry.statusSince,
        lifecycle: { ...entry.lifecycle },
      })),
    }))
    snapshot[1]!.sessions[1] = { ...snapshot[1]!.sessions[1]!, title: 'Updated title' }

    const next = reconcileProjects(current, snapshot)

    expect(next).not.toBe(current)
    expect(next[0]).toBe(current[0])
    expect(next[1]?.sessions[0]).toBe(current[1]?.sessions[0])
    expect(next[1]?.sessions[1]).toMatchObject({
      title: 'Updated title',
      status: 'working',
      statusSince: 100,
    })
    expect(next[1]?.sessions[1]?.lifecycle).toBe(current[1]?.sessions[1]?.lifecycle)
  })

  it('retains exact changed locations from a stable server snapshot', () => {
    const current = projects(2, 2)
    const snapshot = current.map((project) => ({
      ...project,
      sessions: project.sessions.map((entry) => ({
        ...entry,
        lifecycle: { ...entry.lifecycle },
      })),
    }))
    snapshot[1]!.sessions[0] = { ...snapshot[1]!.sessions[0]!, status: 'working' }

    const next = reconcileProjects(current, snapshot)

    expect(takeProjectSessionChanges(current, next)).toEqual([{ projectIndex: 1, sessionIndex: 0 }])
  })

  it('uses the exact snapshot order and removes missing projects and chats', () => {
    const current = projects(2, 3)
    const snapshot = [
      {
        ...current[1]!,
        sessions: [current[1]!.sessions[2]!, current[1]!.sessions[0]!],
      },
    ]

    const next = reconcileProjects(current, snapshot)

    expect(next.map(({ path }) => path)).toEqual(['/project-1'])
    expect(next[0]?.sessions.map(({ id }) => id)).toEqual(['thread-1-2', 'thread-1-0'])
    expect(next[0]?.sessions[0]).toBe(current[1]?.sessions[2])
  })
})

describe('server project snapshot reconciliation', () => {
  it('converts once, retains an unchanged tree, and copies one changed status', () => {
    const snapshot = serverProjects(2, 2)
    const current = reconcileProjectList([], snapshot, [], {}, 100)

    expect(reconcileProjectList(current, snapshot, [], {}, 200)).toBe(current)

    const changed = serverProjects(2, 2)
    changed[1]!.sessions[0] = {
      ...changed[1]!.sessions[0]!,
      running: true,
      status: 'working',
    }
    const next = reconcileProjectList(current, changed, [], {}, 300)

    expect(next[0]).toBe(current[0])
    expect(next[1]?.sessions[1]).toBe(current[1]?.sessions[1])
    expect(next[1]?.sessions[0]).toMatchObject({ status: 'working', statusSince: 300 })
    expect(takeProjectSessionChanges(current, next)).toEqual([{ projectIndex: 1, sessionIndex: 0 }])
  })

  it('applies saved project and chat order while adding defaults', () => {
    const snapshot = serverProjects(2, 2)
    delete snapshot[1]!.sessions[1]!.status
    delete snapshot[1]!.sessions[1]!.lifecycle

    const next = reconcileProjectList(
      [],
      snapshot,
      ['/project-1', '/project-0'],
      { '/project-1': ['thread-1-1', 'thread-1-0'] },
      100,
    )

    expect(next.map(({ path }) => path)).toEqual(['/project-1', '/project-0'])
    expect(next[0]?.sessions.map(({ id }) => id)).toEqual(['thread-1-1', 'thread-1-0'])
    expect(next[0]?.sessions[0]).toMatchObject({
      status: 'idle',
      statusSince: 1,
      lifecycle: { state: 'active', keepActive: false },
    })
  })
})

describe('marking a session read', () => {
  it('retains an already-read idle session', () => {
    const current = session('thread')
    expect(markSessionRead(current)).toBe(current)
  })

  it('clears unread, ready, and wake metadata together', () => {
    const current: Session = {
      ...session('thread'),
      unread: true,
      status: 'ready',
      lifecycle: { state: 'active', keepActive: true, wokeAt: 42 },
    }

    expect(markSessionRead(current)).toEqual({
      ...current,
      unread: false,
      status: 'idle',
      lifecycle: { state: 'active', keepActive: true },
    })
  })
})
