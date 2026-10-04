import { describe, expect, it } from 'vitest'
import {
  applyProjectOrder,
  applySessionOrder,
  parseStoredProjectOrder,
  parseStoredSessionOrder,
} from './sidebar-order.js'
import type { Project } from './ui/Sidebar.js'

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
