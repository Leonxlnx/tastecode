import { describe, expect, it } from 'vitest'
import {
  applyProjectOrder,
  applySessionOrder,
  isArchived,
  moveRailSession,
  needsYouSessions,
  parseStoredProjectOrder,
  parseStoredSessionOrder,
  projectAttention,
  sidebarRail,
  sidebarSessions,
} from './sidebar-order.js'
import type { Project, Session } from './ui/Sidebar.js'

function project(path: string, ids: string[]): Project {
  return {
    path,
    sessions: ids.map((id, index) => ({
      id,
      title: id,
      provider: 'codex',
      createdAt: index,
      status: 'idle',
      lifecycle: { state: 'active', keepActive: false },
      unread: false,
    })),
  }
}

describe('stored sidebar order', () => {
  it('validates a changed value once and reuses the parsed result', () => {
    const raw = JSON.stringify({ '/repo': ['thread-1', 'thread-2'] })
    const first = parseStoredSessionOrder(raw)

    expect(parseStoredSessionOrder(raw)).toBe(first)
    expect(first).toEqual({ '/repo': ['thread-1', 'thread-2'] })
    expect(parseStoredSessionOrder('{broken')).toEqual({})
    expect(parseStoredProjectOrder('["/one","/two"]')).toEqual(['/one', '/two'])
  })

  it('keeps exact ordered arrays and moves unknown entries ahead of saved ones', () => {
    const projects = [project('/one', ['one']), project('/two', ['two'])]
    expect(applyProjectOrder(projects, ['/one', '/two'])).toBe(projects)
    expect(applyProjectOrder(projects, ['/one']).map(({ path }) => path)).toEqual(['/two', '/one'])

    const sessions = projects[0]!.sessions
    expect(applySessionOrder('/one', sessions, { '/one': ['one'] })).toBe(sessions)
    const withNew = [...sessions, project('/new', ['new']).sessions[0]!]
    expect(applySessionOrder('/one', withNew, { '/one': ['one'] }).map(({ id }) => id)).toEqual([
      'new',
      'one',
    ])
  })

  it('slots chats missing from a dragged order in by date', () => {
    const chat = (id: string, createdAt: number) => ({ id, createdAt })
    // Server order is newest first; the user dragged the oldest chat to the top.
    const sessions = [
      chat('import-4', 4),
      chat('saved-3', 3),
      chat('import-2', 2),
      chat('saved-1', 1),
    ]

    expect(
      applySessionOrder('/one', sessions, { '/one': ['saved-1', 'saved-3'] }).map(({ id }) => id),
    ).toEqual(['import-4', 'import-2', 'saved-1', 'saved-3'])
    expect(
      applySessionOrder('/one', sessions, { '/one': ['saved-3', 'saved-1'] }).map(({ id }) => id),
    ).toEqual(['import-4', 'saved-3', 'import-2', 'saved-1'])
    expect(
      applySessionOrder('/one', [chat('new', 5), ...sessions], {
        '/one': ['import-4', 'saved-3', 'import-2', 'saved-1'],
      }).map(({ id }) => id),
    ).toEqual(['new', 'import-4', 'saved-3', 'import-2', 'saved-1'])
  })
})

const chat = (id: string, changes: Partial<Session> = {}): Session => ({
  id,
  title: id,
  provider: 'codex',
  createdAt: 0,
  status: 'idle',
  lifecycle: { state: 'active', keepActive: false },
  unread: false,
  ...changes,
})
const ids = (sessions: Session[]) => sessions.map(({ id }) => id)
const archived = (settledAt: number): Partial<Session> => ({
  lifecycle: { state: 'settled', settledAt, reason: 'manual' },
})
const shown = (sessions: Session[]) =>
  ids(sidebarRail([{ path: '/p', sessions }]).orderedProjects[0]!.sessions)

describe('the rail keeps its order', () => {
  it('does not move a chat when it starts, waits, finishes or is read', () => {
    const saved = [chat('A'), chat('B'), chat('C'), chat('D')]
    expect(shown(saved)).toEqual(['A', 'B', 'C', 'D'])

    for (const changes of [
      { status: 'working' },
      { status: 'queued' },
      { status: 'approval' },
      { status: 'input' },
      { status: 'failed', unread: true },
      { status: 'ready', unread: true },
      { status: 'idle', unread: false },
    ] as const) {
      const next = saved.map((session) =>
        session.id === 'C' ? { ...session, ...changes } : session,
      )
      expect(shown(next)).toEqual(['A', 'B', 'C', 'D'])
    }
  })

  it('keeps an unchanged project projection when nothing in it is pinned or archived', () => {
    const projects = [project('/one', ['one', 'two'])]
    const rail = sidebarRail(projects)
    expect(rail.orderedProjects[0]).toBe(projects[0])
    expect(sidebarRail(projects).orderedProjects[0]).toBe(rail.orderedProjects[0])
  })
  it('moves archived chats out of the tree, newest archived first, and keeps pinned ones pinned', () => {
    const rail = sidebarRail([
      {
        path: '/one',
        sessions: [
          chat('kept'),
          chat('old', archived(10)),
          chat('pin', { pinned: true, ...archived(5) }),
        ],
      },
      { path: '/two', sessions: [chat('newer', archived(20)), chat('two')] },
    ])

    expect(rail.orderedProjects.map((entry) => ids(entry.sessions))).toEqual([['kept'], ['two']])
    expect(
      rail.archivedSessions.map(({ projectPath, session }) => [projectPath, session.id]),
    ).toEqual([
      ['/two', 'newer'],
      ['/one', 'old'],
    ])
    expect(rail.pinnedSessions.map(({ session }) => session.id)).toEqual(['pin'])
    expect(
      sidebarSessions(
        [{ path: '/one', sessions: [chat('a'), chat('b', archived(1))] }],
        'classic',
      ).map(({ id }) => id),
    ).toEqual(['a'])
  })

  it('leaves a chat the server settled on its own in the tree', () => {
    const idle = chat('idle', {
      lifecycle: { state: 'settled', settledAt: 10, reason: 'inactivity' },
    })
    const rail = sidebarRail([{ path: '/one', sessions: [chat('a'), idle, chat('b')] }])

    expect(ids(rail.orderedProjects[0]!.sessions)).toEqual(['a', 'idle', 'b'])
    expect(rail.archivedSessions).toEqual([])
    expect(isArchived(idle)).toBe(false)
    expect(isArchived(chat('archived', archived(10)))).toBe(true)
  })
})

describe('chats that need you', () => {
  it('lists blocked agents first, then unread failures, the longest wait first', () => {
    const projects: Project[] = [
      {
        path: '/one',
        sessions: [
          chat('working', { status: 'working', statusSince: 1 }),
          chat('approval', { status: 'approval', statusSince: 30 }),
          chat('read-failure', { status: 'failed', statusSince: 2 }),
          chat('done', { status: 'ready', unread: true, statusSince: 20 }),
          chat('older-failure', { status: 'failed', unread: true, statusSince: 3 }),
        ],
      },
      {
        path: '/two',
        sessions: [
          chat('question', { status: 'input', statusSince: 10 }),
          chat('failed', { status: 'failed', unread: true, statusSince: 40 }),
          chat('archived', { status: 'failed', unread: true, statusSince: 5, ...archived(6) }),
          chat('idle', { unread: true }),
        ],
      },
    ]

    expect(
      needsYouSessions(projects, undefined).map(({ session, attention }) => [
        session.id,
        attention,
      ]),
    ).toEqual([
      ['question', 'input'],
      ['approval', 'approval'],
      ['older-failure', 'failed'],
      ['failed', 'failed'],
    ])
  })

  it('leaves a finished answer in the tree only, unread or not', () => {
    const projects: Project[] = [
      {
        path: '/one',
        sessions: [
          chat('ready', { status: 'ready', unread: true }),
          chat('idle', { status: 'idle', unread: true }),
        ],
      },
    ]

    expect(needsYouSessions(projects, undefined)).toEqual([])
    expect(projectAttention(projects[0]!)).toBeUndefined()
  })

  it('leaves out the open chat and clears an entry once it is read', () => {
    const failed = chat('failed', { status: 'failed', unread: true })
    const projects: Project[] = [{ path: '/one', sessions: [failed, chat('other')] }]

    expect(needsYouSessions(projects, undefined).map(({ session }) => session.id)).toEqual([
      'failed',
    ])
    expect(needsYouSessions(projects, 'failed')).toEqual([])
    const read: Project[] = [
      { path: '/one', sessions: [{ ...failed, unread: false }, chat('other')] },
    ]
    expect(needsYouSessions(read, undefined)).toEqual([])
  })

  it('counts what needs you inside a project and names the most urgent kind', () => {
    expect(projectAttention(project('/quiet', ['a', 'b']))).toBeUndefined()
    expect(
      projectAttention({
        path: '/busy',
        sessions: [
          chat('done', { status: 'ready', unread: true }),
          chat('failed', { status: 'failed', unread: true }),
        ],
      }),
    ).toEqual({ count: 1, attention: 'failed' })
    expect(
      projectAttention({
        path: '/waiting',
        sessions: [
          chat('failed', { status: 'failed', unread: true }),
          chat('approval', { status: 'approval' }),
        ],
      }),
    ).toEqual({ count: 2, attention: 'approval' })
  })
})

describe('dropping a chat in the rail', () => {
  it('lands exactly where it was dropped, whatever the status of its neighbours', () => {
    const saved = [
      chat('B'),
      chat('W', { status: 'working' }),
      chat('A', { status: 'ready', unread: true }),
    ]

    expect(ids(moveRailSession(saved, 'B', 'A', 'after'))).toEqual(['W', 'A', 'B'])
    expect(ids(moveRailSession(saved, 'A', 'B', 'before'))).toEqual(['A', 'B', 'W'])
    expect(ids(moveRailSession(saved, 'W', 'B', 'before'))).toEqual(['W', 'B', 'A'])
  })

  it('leaves pinned and archived chats in their saved place and ignores drops it cannot place', () => {
    const saved = [
      chat('X'),
      chat('P', { pinned: true }),
      chat('Y'),
      chat('R', archived(1)),
      chat('Z'),
    ]

    expect(ids(moveRailSession(saved, 'Z', 'X', 'before'))).toEqual(['Z', 'X', 'P', 'Y', 'R'])
    expect(moveRailSession(saved, 'Z', 'P', 'before')).toBe(saved)
    expect(moveRailSession(saved, 'Z', 'R', 'before')).toBe(saved)
    expect(moveRailSession(saved, 'missing', 'X', 'before')).toBe(saved)
    expect(moveRailSession(saved, 'X', 'X', 'after')).toBe(saved)
  })
})
