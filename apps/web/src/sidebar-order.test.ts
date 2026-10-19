import { describe, expect, it } from 'vitest'
import {
  applyProjectOrder,
  applySessionOrder,
  chatList,
  moveChat,
  moveRailSession,
  parseStoredProjectOrder,
  parseStoredSessionOrder,
  sidebarRail,
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

describe('dropping a chat in the rail', () => {
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
  const shown = (sessions: Session[]) =>
    ids(sidebarRail([{ path: '/p', sessions }]).orderedProjects[0]!.sessions)
  const read = (sessions: Session[]) => sessions.map((session) => ({ ...session, unread: false }))

  it('lands beside a lifted unread chat where it was dropped', () => {
    const saved = [chat('B'), chat('C'), chat('A', { status: 'ready', unread: true })]
    expect(shown(saved)).toEqual(['A', 'B', 'C'])

    const below = moveRailSession(saved, 'C', 'A', 'after')
    expect(shown(below)).toEqual(['A', 'C', 'B'])
    // The unread chat was only lifted, so reading it returns it to its place.
    expect(shown(read(below))).toEqual(['C', 'B', 'A'])

    const above = moveRailSession(saved, 'B', 'A', 'before')
    expect(shown(above)).toEqual(['A', 'B', 'C'])
    expect(shown(read(above))).toEqual(['B', 'C', 'A'])
  })

  it('keeps a lifted chat dropped among the others there once it settles', () => {
    const working = chat('W', { status: 'working' })
    const saved = [chat('B'), working, chat('C'), chat('D')]
    expect(shown(saved)).toEqual(['W', 'B', 'C', 'D'])

    const moved = moveRailSession(saved, 'W', 'C', 'after')
    expect(shown(moved)).toEqual(['W', 'B', 'C', 'D'])
    expect(shown(moved.map((session) => ({ ...session, status: 'idle' })))).toEqual([
      'B',
      'C',
      'W',
      'D',
    ])
  })

  it('keeps chats of the same rank in the order they were dropped', () => {
    const unread = { status: 'ready', unread: true } as const
    const saved = [chat('B'), chat('S1', unread), chat('C'), chat('S2', unread), chat('D')]
    expect(shown(saved)).toEqual(['S1', 'S2', 'B', 'C', 'D'])

    expect(shown(moveRailSession(saved, 'S2', 'S1', 'before'))).toEqual(['S2', 'S1', 'B', 'C', 'D'])
    expect(shown(moveRailSession(saved, 'D', 'B', 'before'))).toEqual(['S1', 'S2', 'D', 'B', 'C'])
  })

  it('leaves pinned chats in their saved place and ignores drops it cannot place', () => {
    const saved = [chat('X'), chat('P', { pinned: true }), chat('Y'), chat('Z')]

    expect(ids(moveRailSession(saved, 'Z', 'X', 'before'))).toEqual(['Z', 'X', 'P', 'Y'])
    expect(moveRailSession(saved, 'Z', 'P', 'before')).toBe(saved)
    expect(moveRailSession(saved, 'missing', 'X', 'before')).toBe(saved)
    expect(moveRailSession(saved, 'X', 'X', 'after')).toBe(saved)
  })
})

describe('the flat chat list', () => {
  const at = (source: Project, id: string, patch: Partial<Session>): Project => ({
    ...source,
    sessions: source.sessions.map((session) =>
      session.id === id ? { ...session, ...patch } : session,
    ),
  })
  const ids = (entries: { session: Session }[]) => entries.map(({ session }) => session.id)

  it('lists active chats newest first across projects and never re-ranks them by status', () => {
    const web = project('/web', ['w0', 'w1'])
    const api = { ...project('/api', ['a0']), pinned: true }
    const calm = chatList([web, api], [], '')
    expect(ids(calm.active)).toEqual(['w1', 'w0', 'a0'])
    expect(calm.projects.map((entry) => entry.path)).toEqual(['/api', '/web'])

    const busy = chatList([at(web, 'w0', { status: 'working', unread: true }), api], [], '')
    expect(ids(busy.active)).toEqual(['w1', 'w0', 'a0'])
  })

  it('splits pinned and archived chats out and scopes the rest to one project', () => {
    const web = at(at(project('/web', ['w0', 'w1', 'w2']), 'w0', { pinned: true }), 'w1', {
      lifecycle: { state: 'settled', settledAt: 5, reason: 'manual' },
    })
    const api = project('/api', ['a0'])
    const all = chatList([web, api], [], '')
    expect(ids(all.pinned)).toEqual(['w0'])
    expect(ids(all.active)).toEqual(['w2', 'a0'])
    expect(ids(all.archived)).toEqual(['w1'])

    const scoped = chatList([web, api], [], '/api')
    expect(ids(scoped.pinned)).toEqual(['w0'])
    expect(ids(scoped.active)).toEqual(['a0'])
    expect(scoped.archived).toEqual([])
  })

  it('keeps a dragged order and still puts a newer chat on top', () => {
    const web = project('/web', ['w0', 'w1', 'w2'])
    expect(ids(chatList([web], ['w0', 'w2', 'w1'], '').active)).toEqual(['w0', 'w2', 'w1'])
    const newer = {
      ...web,
      sessions: [...web.sessions, { ...web.sessions[0]!, id: 'w3', createdAt: 9 }],
    }
    expect(ids(chatList([newer], ['w0', 'w2', 'w1'], '').active)).toEqual(['w3', 'w0', 'w2', 'w1'])
  })

  it('drops a chat exactly before or after the chat it lands on', () => {
    expect(moveChat(['a', 'b', 'c', 'd'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveChat(['a', 'b', 'c', 'd'], 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c'])
    expect(moveChat(['a', 'b'], 'a', 'a', 'after')).toEqual(['a', 'b'])
    expect(moveChat(['a', 'b'], 'x', 'a', 'after')).toEqual(['a', 'b'])
  })
})
