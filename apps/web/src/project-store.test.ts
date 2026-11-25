import { describe, expect, it } from 'vitest'
import type { ResultOf } from '@harness/contracts'
import type { Project, Session } from './ui/Sidebar.js'
import {
  findSession,
  markSessionRead,
  promoteSession,
  reconcileProjectList,
  removeSession,
  sessionOnProvider,
  takeProjectSessionChanges,
  updateSession,
  updateSessions,
  withoutDeletedSessions,
  withoutHiddenSessions,
  withStoppingSessions,
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

describe('deleted chats in a server list', () => {
  it('leaves out a chat deleted after the server read the list, and nothing else', () => {
    const snapshot = serverProjects(3, 3)
    const stale = withoutDeletedSessions(snapshot, new Set(['thread-1-2']))
    expect(stale[0]).toBe(snapshot[0])
    expect(stale[1]?.sessions.map(({ id }) => id)).toEqual(['thread-1-0', 'thread-1-1'])
    expect(stale[2]).toBe(snapshot[2])
    // The reconciled sidebar no longer lists it.
    const reconciled = reconcileProjectList(projects(3, 3), stale, [], {})
    expect(findSession(reconciled, 'thread-1-2')).toBeUndefined()
  })

  it('returns the same list when it holds no deleted chat', () => {
    const snapshot = serverProjects(2, 2)
    expect(withoutDeletedSessions(snapshot, new Set())).toBe(snapshot)
    expect(withoutDeletedSessions(snapshot, new Set(['gone']))).toBe(snapshot)
  })
})

describe('chats waiting for Undo', () => {
  /** A library whose chat ids count how often they are read. */
  function countedLibrary(projectCount: number, sessionsPerProject: number) {
    const reads = { count: 0 }
    const library = projects(projectCount, sessionsPerProject).map((project) => ({
      ...project,
      sessions: project.sessions.map(
        ({ id, ...rest }) =>
          Object.defineProperty(rest, 'id', {
            enumerable: true,
            get: () => {
              reads.count += 1
              return id
            },
          }) as Session,
      ),
    }))
    return { library, reads }
  }

  it('copies only the project holding a hidden chat, and keeps it through a change elsewhere', () => {
    const { library, reads } = countedLibrary(300, 100)
    // The session index the app builds for its own lookups anyway.
    findSession(library, 'thread-0-0')
    reads.count = 0

    const hidden = ['thread-150-7']
    const shown = withoutHiddenSessions(library, hidden)
    const firstReads = reads.count
    expect(shown[150]?.sessions).toHaveLength(99)
    expect(findSession(shown, 'thread-150-7')).toBeUndefined()
    for (const [index, project] of shown.entries()) {
      if (index !== 150) expect(project).toBe(library[index])
    }
    // One lookup and the one project's chats, not every chat in the library.
    expect(firstReads).toBeLessThanOrEqual(101)

    // Another chat changes status while the deleted one waits for Undo.
    const changed = updateSession(library, 'thread-20-3', (entry) => ({
      ...entry,
      status: 'working',
    }))
    reads.count = 0
    const next = withoutHiddenSessions(changed, hidden)
    expect(next[150]).toBe(shown[150])
    expect(next[20]).toBe(changed[20])
    expect(next[21]).toBe(library[21])
    expect(reads.count).toBeLessThanOrEqual(2)

    // Undo shows the library itself again.
    expect(withoutHiddenSessions(changed, [])).toBe(changed)
  })

  it('hides exactly the chats waiting for Undo', () => {
    const library = projects(4, 3)
    const hidden = ['thread-1-0', 'thread-3-2', 'thread-1-2', 'thread-1-0', 'gone']
    const shown = withoutHiddenSessions(library, hidden)
    expect(shown.map((project) => project.sessions.map(({ id }) => id))).toEqual(
      library.map((project) =>
        project.sessions.map(({ id }) => id).filter((id) => !hidden.includes(id)),
      ),
    )
    expect(shown[0]).toBe(library[0])
    expect(shown[2]).toBe(library[2])
    // The same chats hidden in another order keep the copied project.
    expect(withoutHiddenSessions(library, ['thread-1-2', 'thread-1-0', 'thread-3-2'])[1]).toBe(
      shown[1],
    )
    // Restoring one of a project's hidden chats shows it again.
    expect(
      withoutHiddenSessions(library, ['thread-1-2', 'thread-3-2'])[1]?.sessions.map(({ id }) => id),
    ).toEqual(['thread-1-0', 'thread-1-1'])
    expect(withoutHiddenSessions(library, ['gone'])).toBe(library)
  })

  it('finds a chat in the list without the hidden chats without reading every chat again', () => {
    const { library, reads } = countedLibrary(300, 100)
    findSession(library, 'thread-0-0')
    const shown = withoutHiddenSessions(library, ['thread-150-7', 'thread-150-2'])
    reads.count = 0

    // The Inbox looks up the selected chat in the list it shows.
    expect(findSession(shown, 'thread-150-50')?.session).toBe(library[150]!.sessions[50])
    expect(findSession(shown, 'thread-299-99')?.session).toBe(library[299]!.sessions[99])
    expect(findSession(shown, 'thread-150-7')).toBeUndefined()
    // A handful of id checks, not a new index of all 30,000 chats.
    expect(reads.count).toBeLessThanOrEqual(6)
  })

  it('answers every lookup as an index built from the shown list would', () => {
    /** A fresh array of the same projects has no index and builds one from scratch. */
    function expectSameAnswers(shown: Project[], ids: readonly string[]) {
      const rebuilt = [...shown]
      for (const id of ids) {
        const found = findSession(shown, id)
        const expected = findSession(rebuilt, id)
        expect(found?.project).toBe(expected?.project)
        expect(found?.session).toBe(expected?.session)
      }
    }

    const library = projects(5, 8)
    const ids = [...library.flatMap((project) => project.sessions.map(({ id }) => id)), 'gone']
    findSession(library, 'thread-0-0')
    const steps: (readonly string[])[] = [
      // Several chats of one project: first, adjacent, last.
      ['thread-2-0', 'thread-2-3', 'thread-2-4', 'thread-2-7'],
      // Several projects, given out of order.
      ['thread-4-5', 'thread-1-1', 'thread-2-6', 'thread-1-6', 'thread-0-0', 'gone'],
      // Undo of some of them, then of all.
      ['thread-4-5', 'thread-1-6'],
      [],
    ]
    for (const hidden of steps) expectSameAnswers(withoutHiddenSessions(library, hidden), ids)

    // A library whose own index is a chain of reorders and removals, then a
    // status change: the hidden chats' shifts are added to that chain.
    let changed = promoteSession(library, 'thread-1-5')
    changed = removeSession(changed, 'thread-3-2')
    changed = updateSession(changed, 'thread-1-3', (entry) => ({ ...entry, unread: true }))
    findSession(changed, 'thread-0-0')
    for (const hidden of [
      ['thread-1-5', 'thread-1-0', 'thread-3-3', 'thread-3-7'],
      ['thread-1-0', 'thread-3-7'],
      [],
    ]) {
      expectSameAnswers(withoutHiddenSessions(changed, hidden), ids)
    }
  })
})

describe('chats the user just stopped', () => {
  function running(): Project[] {
    const current = projects(3, 2)
    return updateSessions(
      current,
      new Map<string, Session['status']>([
        ['thread-0-1', 'working'],
        ['thread-1-0', 'starting'],
        ['thread-2-0', 'approval'],
      ]),
      (entry, status) => ({ ...entry, status, statusSince: 5 }),
    )
  }

  it('shows a working or starting chat as idle since its Stop', () => {
    const current = running()
    const shown = withStoppingSessions(
      current,
      new Map([
        ['thread-0-1', 40],
        ['thread-1-0', 50],
      ]),
    )

    expect(findSession(shown, 'thread-0-1')?.session).toMatchObject({
      status: 'idle',
      statusSince: 40,
    })
    expect(findSession(shown, 'thread-1-0')?.session).toMatchObject({
      status: 'idle',
      statusSince: 50,
    })
    // The chat list behind the sidebar keeps what the server said.
    expect(findSession(current, 'thread-0-1')?.session.status).toBe('working')
    expect(shown[2]).toBe(current[2])
    expect(shown[0]?.sessions[0]).toBe(current[0]?.sessions[0])
  })

  it('leaves a chat that waits on the user or has ended as it is', () => {
    const current = running()
    expect(
      withStoppingSessions(
        current,
        new Map([
          ['thread-2-0', 40],
          ['thread-2-1', 40],
          ['gone', 40],
        ]),
      ),
    ).toBe(current)
    expect(withStoppingSessions(current, new Map())).toBe(current)
  })
})

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
  it('retains the API connection identity and reconciles source changes', () => {
    const snapshot = serverProjects(1, 2)
    snapshot[0]!.sessions[0] = {
      ...snapshot[0]!.sessions[0]!,
      provider: 'api',
      connectionId: 'first-api',
    }
    snapshot[0]!.sessions[1] = {
      ...snapshot[0]!.sessions[1]!,
      provider: 'api',
      connectionId: 'second-api',
    }
    const current = reconcileProjectList([], snapshot, [], {}, 100)
    expect(current[0]!.sessions.map(({ connectionId }) => connectionId)).toEqual([
      'first-api',
      'second-api',
    ])
    expect(reconcileProjectList(current, snapshot, [], {}, 200)).toBe(current)
    const changed = [
      {
        ...snapshot[0]!,
        sessions: [
          { ...snapshot[0]!.sessions[0]!, connectionId: 'third-api' },
          snapshot[0]!.sessions[1]!,
        ],
      },
    ]
    const next = reconcileProjectList(current, changed, [], {}, 300)
    expect(next[0]!.sessions[0]!.connectionId).toBe('third-api')
    expect(next[0]!.sessions[1]).toBe(current[0]!.sessions[1])
  })

  it('keeps the mark of a folder made for a chat without a project', () => {
    const [plain, folder] = serverProjects(2, 1)
    const snapshot = [plain!, { ...folder!, chat: true }]
    const current = reconcileProjectList([], snapshot, [], {}, 100)

    expect(current.map(({ chat }) => chat)).toEqual([undefined, true])
    expect(reconcileProjectList(current, snapshot, [], {}, 200)).toBe(current)
    const unmarked = reconcileProjectList(current, [plain!, folder!], [], {}, 300)
    expect(unmarked[1]!.chat).toBeUndefined()
    expect(unmarked[0]).toBe(current[0])
  })

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

  it('keeps a chat that is still starting until the server can list it', () => {
    const snapshot = serverProjects(2, 2)
    const listed = reconcileProjectList([], snapshot, [], {}, 100)
    const starting: Session = { ...session('pending:new-chat'), status: 'starting' }
    const current = listed.map((project, index) =>
      index === 1 ? { ...project, sessions: [starting, ...project.sessions] } : project,
    )

    const next = reconcileProjectList(current, snapshot, [], {}, 200)

    expect(next[0]).toBe(current[0])
    expect(next[1]?.sessions.map(({ id }) => id)).toEqual([
      'pending:new-chat',
      'thread-1-0',
      'thread-1-1',
    ])
    expect(findSession(next, 'pending:new-chat')?.session).toBe(starting)
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

describe('a chat that moved to another provider', () => {
  it('takes the new provider, agent and account, and drops what belonged to the old one', () => {
    const before: Session = { ...session('chat'), accountId: 'work', connectionId: 'nan-1' }
    expect(sessionOnProvider(before, { provider: 'acp', agent: 'gemini' })).toEqual({
      ...session('chat'),
      provider: 'acp',
      agent: 'gemini',
    })
    const same = session('chat')
    expect(sessionOnProvider(same, { provider: 'codex' })).toBe(same)
  })
})
