import { describe, expect, it } from 'vitest'
import {
  applyProjectOrder,
  applySessionOrder,
  foldedProjectSessions,
  isArchived,
  liftSession,
  moveRailSession,
  needsYouSessions,
  parseStoredProjectOrder,
  parseStoredSessionOrder,
  projectAttention,
  railSessionOrder,
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
  it('lists done chats first, then the ones that need the user, then working, then read', () => {
    const saved = [
      chat('read-1'),
      chat('working-1', { status: 'working' }),
      chat('done-1', { status: 'ready', unread: true }),
      chat('approval', { status: 'approval' }),
      chat('read-2', { status: 'failed', unread: false }),
      chat('queued', { status: 'queued' }),
      chat('failed', { status: 'failed', unread: true }),
      chat('done-2', { status: 'idle', unread: true }),
      chat('input', { status: 'input' }),
      chat('starting', { status: 'starting', unread: true }),
    ]
    // Each group keeps the saved order.
    expect(shown(saved)).toEqual([
      'done-1',
      'done-2',
      'approval',
      'failed',
      'input',
      'working-1',
      'queued',
      'starting',
      'read-1',
      'read-2',
    ])
  })

  it('keeps the open chat that was done with the done chats until another opens', () => {
    const sessions = [chat('read'), chat('working', { status: 'working' }), chat('opened')]
    const rail = (held?: string) =>
      ids(sidebarRail([{ path: '/p', sessions }], held).orderedProjects[0]!.sessions)
    expect(rail('opened')).toEqual(['opened', 'working', 'read'])
    expect(rail()).toEqual(['working', 'read', 'opened'])
    // Holding only keeps a read chat up; it never takes one out of its group.
    expect(rail('working')).toEqual(['working', 'read', 'opened'])
  })

  it('places a drop in the order the rail shows, leaving pinned and archived slots alone', () => {
    const sessions = [
      chat('read'),
      chat('pinned', { pinned: true }),
      chat('working', { status: 'working' }),
      chat('done', { status: 'ready', unread: true }),
    ]
    expect(ids(railSessionOrder(sessions))).toEqual(['done', 'pinned', 'working', 'read'])
    const grouped = [chat('done', { status: 'ready', unread: true }), chat('read')]
    expect(railSessionOrder(grouped)).toBe(grouped)
  })

  it('keeps the project itself when its chats are already in their groups', () => {
    const projects = [
      {
        path: '/p',
        sessions: [
          chat('done', { status: 'ready', unread: true }),
          chat('working', { status: 'working' }),
          chat('read'),
        ],
      },
    ]
    expect(sidebarRail(projects).orderedProjects[0]).toBe(projects[0])
  })

  it('lifts a finished chat to the top of its own project only', () => {
    const projects = [
      { path: '/one', sessions: [chat('A', { status: 'working' }), chat('B'), chat('C')] },
      { path: '/two', sessions: [chat('D'), chat('E')] },
    ]
    const lifted = liftSession(projects, 'C')
    expect(ids(lifted[0]!.sessions)).toEqual(['C', 'A', 'B'])
    expect(lifted[1]).toBe(projects[1])
    // Already on top, or not listed: nothing changes.
    expect(liftSession(lifted, 'C')).toBe(lifted)
    expect(liftSession(projects, 'gone')).toBe(projects)
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

describe('a folded project', () => {
  const quiet = ['A', 'B', 'C', 'D', 'E'].map((id) => chat(id))
  const folded = (sessions: Session[], activeSessionId?: string) =>
    ids(foldedProjectSessions(sessions, activeSessionId, 5)).join('')

  it('fills its rows with every chat that has news, then the first quiet ones, in order', () => {
    const sessions = [
      ...quiet,
      chat('F'),
      chat('G', { status: 'working' }),
      chat('H', { status: 'ready', unread: true }),
      chat('I'),
    ]

    expect(folded(sessions, 'A')).toBe('ABCGH')
    expect(folded(sessions, 'I')).toBe('ABGHI')
    expect(folded(quiet.slice(0, 3))).toBe('ABC')
  })

  it('lists every running chat even when there are more of them than rows', () => {
    const running = (id: string) => chat(id, { status: 'working' })

    expect(folded([...quiet, running('F')])).toBe('ABCDF')
    expect(folded([chat('Q'), ...['F', 'G', 'H', 'I', 'J', 'K'].map(running), ...quiet])).toBe(
      'FGHIJK',
    )
  })

  it('keeps a chat in sight while it starts, works or needs the user, not once it is quiet', () => {
    for (const changes of [
      { status: 'starting' },
      { status: 'working' },
      { status: 'approval' },
      { status: 'input' },
      { status: 'failed', unread: true },
      { status: 'ready', unread: true },
      { status: 'idle', unread: true },
    ] as const) {
      expect(folded([...quiet, chat('F', changes)])).toBe('ABCDF')
    }
    for (const changes of [
      { status: 'idle' },
      { status: 'ready' },
      { status: 'failed' },
      // A queued prompt with no turn behind it is not running.
      { status: 'queued' },
    ] as const) {
      expect(folded([...quiet, chat('F', changes)])).toBe('ABCDE')
    }
  })
})
