import { describe, expect, it } from 'vitest'
import {
  applyProjectOrder,
  applySessionOrder,
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

  it('leaves pinned chats in their saved place and ignores drops it cannot place', () => {
    const saved = [chat('X'), chat('P', { pinned: true }), chat('Y'), chat('Z')]

    expect(ids(moveRailSession(saved, 'Z', 'X', 'before'))).toEqual(['Z', 'X', 'P', 'Y'])
    expect(moveRailSession(saved, 'Z', 'P', 'before')).toBe(saved)
    expect(moveRailSession(saved, 'missing', 'X', 'before')).toBe(saved)
    expect(moveRailSession(saved, 'X', 'X', 'after')).toBe(saved)
  })
})
