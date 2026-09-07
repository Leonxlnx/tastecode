import { describe, expect, it } from 'vitest'
import type { ResultOf } from '@harness/contracts'
import type { Project, Session } from './ui/Sidebar.js'
import {
  findSession,
  markSessionRead,
  promoteSession,
  reconcileProjectList,
  removeSession,
  takeProjectSessionChanges,
  updateSession,
  updateSessions,
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

  it('updates a known chat batch without copying unrelated projects', () => {
    const current = projects(100, 100)
    const updates = new Map([
      ['thread-10-10', 'working' as const],
      ['thread-10-20', 'ready' as const],
      ['thread-90-90', 'failed' as const],
    ])
    const next = updateSessions(current, updates, (entry, status) => ({ ...entry, status }))

    expect(next[9]).toBe(current[9])
    expect(next[10]).not.toBe(current[10])
    expect(next[10]?.sessions[10]?.status).toBe('working')
    expect(next[10]?.sessions[20]?.status).toBe('ready')
    expect(next[11]).toBe(current[11])
    expect(next[90]?.sessions[90]?.status).toBe('failed')
    expect(takeProjectSessionChanges(current, next)).toEqual([
      { projectIndex: 10, sessionIndex: 10 },
      { projectIndex: 10, sessionIndex: 20 },
      { projectIndex: 90, sessionIndex: 90 },
    ])
  })

  it('stops tracking exact locations after a large chat batch exceeds the hint cap', () => {
    const current = projects(1, 40)
    const updates = new Map(
      Array.from({ length: 33 }, (_, index) => [`thread-0-${index}`, 'working' as const]),
    )
    const next = updateSessions(current, updates, (entry, status) => ({ ...entry, status }))

    expect(next[0]?.sessions.slice(0, 33).every(({ status }) => status === 'working')).toBe(true)
    expect(takeProjectSessionChanges(current, next)).toBeUndefined()
  })

  it('retains the complete tree for an empty, missing, or unchanged chat batch', () => {
    const current = projects(2, 2)
    expect(updateSessions(current, new Map(), (entry) => entry)).toBe(current)
    expect(updateSessions(current, new Map([['missing', true]]), (entry) => entry)).toBe(current)
    expect(updateSessions(current, new Map([['thread-1-1', true]]), (entry) => entry)).toBe(current)
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
    expect(findSession(promoted, 'thread-0-2')?.session.id).toBe('thread-0-2')
    expect(findSession(promoted, 'thread-0-0')?.session.id).toBe('thread-0-0')
    expect(promoted[0]).toBe(reordered[0])
  })

  it('materializes exact indices after deep promotion and deletion', () => {
    const current = projects(1, 1_000)
    expect(findSession(current, 'thread-0-999')?.session.id).toBe('thread-0-999')

    const promoted = promoteSession(current, 'thread-0-999')
    expect(promoted[0]?.sessions[0]?.id).toBe('thread-0-999')
    expect(findSession(promoted, 'thread-0-500')?.session.id).toBe('thread-0-500')

    const removed = removeSession(promoted, 'thread-0-999')
    expect(findSession(removed, 'thread-0-999')).toBeUndefined()
    expect(findSession(removed, 'thread-0-500')?.session.id).toBe('thread-0-500')
  })

  it('keeps every lookup exact beyond the bounded mutation cap', () => {
    let current = projects(2, 1_000)
    expect(findSession(current, 'thread-0-999')?.session.id).toBe('thread-0-999')
    for (let index = 999; index >= 920; index -= 1) {
      current = promoteSession(current, `thread-0-${index}`)
    }
    current = removeSession(current, 'thread-0-500')

    for (const project of current) {
      for (const entry of project.sessions) {
        expect(findSession(current, entry.id)).toEqual({ project, session: entry })
      }
    }
    expect(findSession(current, 'thread-0-500')).toBeUndefined()
  })

  it('keeps mixed promotions, removals, and stable updates exact', () => {
    let current = projects(2, 300)
    const expected = current.map((project) => project.sessions.map(({ id }) => id))
    const removed = new Set<string>()
    expect(findSession(current, 'thread-1-299')?.session.id).toBe('thread-1-299')

    for (let step = 0; step < 96; step += 1) {
      const projectIndex = step % expected.length
      const ids = expected[projectIndex]!
      if (step % 5 === 4) {
        const sessionIndex = (step * 37) % ids.length
        const [threadId] = ids.splice(sessionIndex, 1)
        removed.add(threadId!)
        current = removeSession(current, threadId!)
      } else {
        const sessionIndex = 1 + ((step * 53) % (ids.length - 1))
        const [threadId] = ids.splice(sessionIndex, 1)
        ids.unshift(threadId!)
        current = promoteSession(current, threadId!)
      }

      if (step % 8 === 0) {
        const threadId = ids[Math.floor(ids.length / 2)]!
        current = updateSession(current, threadId, (entry) => ({
          ...entry,
          unread: !entry.unread,
        }))
      }
    }

    expect(current.map((project) => project.sessions.map(({ id }) => id))).toEqual(expected)
    for (const project of current) {
      for (const entry of project.sessions) {
        expect(findSession(current, entry.id)).toEqual({ project, session: entry })
      }
    }
    for (const threadId of removed) expect(findSession(current, threadId)).toBeUndefined()
  })

  it('inherits transformed indices through stable batches and snapshots', () => {
    let current = projects(1, 1_000)
    expect(findSession(current, 'thread-0-999')?.session.id).toBe('thread-0-999')
    current = promoteSession(current, 'thread-0-999')
    current = removeSession(current, 'thread-0-500')
    current = updateSessions(
      current,
      new Map([
        ['thread-0-250', 'working' as const],
        ['thread-0-750', 'ready' as const],
      ]),
      (entry, status) => ({ ...entry, status }),
    )

    for (const project of current) {
      for (const entry of project.sessions) {
        expect(findSession(current, entry.id)).toEqual({ project, session: entry })
      }
    }
    expect(findSession(current, 'thread-0-500')).toBeUndefined()
  })

  it('rebuilds a transformed index after an in-place session reorder', () => {
    const current = projects(1, 10)
    expect(findSession(current, 'thread-0-9')?.session.id).toBe('thread-0-9')
    const promoted = promoteSession(current, 'thread-0-9')
    const sessions = promoted[0]!.sessions
    ;[sessions[2], sessions[5]] = [sessions[5]!, sessions[2]!]

    expect(findSession(promoted, sessions[2]!.id)?.session).toBe(sessions[2])
    expect(findSession(promoted, sessions[5]!.id)?.session).toBe(sessions[5])
  })

  it('removes one chat without copying unrelated projects', () => {
    const current = projects(100, 100)
    const next = removeSession(current, 'thread-50-50')

    expect(next[49]).toBe(current[49])
    expect(next[50]).not.toBe(current[50])
    expect(next[50]?.sessions).toHaveLength(99)
    expect(findSession(next, 'thread-50-50')).toBeUndefined()
    expect(findSession(next, 'thread-50-51')?.session.id).toBe('thread-50-51')
    expect(next[51]).toBe(current[51])
    expect(removeSession(current, 'missing')).toBe(current)
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
