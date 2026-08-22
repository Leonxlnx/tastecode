// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { updateSession } from '../project-store.js'
import { createClassicSidebarProjector, type Project, type Session } from './Sidebar.js'

function session(
  id: string,
  status: Session['status'] = 'idle',
  unread = false,
  pinned = false,
): Session {
  return {
    id,
    title: id,
    provider: 'codex',
    createdAt: 1,
    status,
    lifecycle: { state: 'active', keepActive: false },
    unread,
    pinned,
  }
}

function ids(projects: Project[]): string[] {
  return projects[0]?.sessions.map((entry) => entry.id) ?? []
}

describe('classic sidebar projector', () => {
  it('moves one immutable session update without rescanning the project', () => {
    const projector = createClassicSidebarProjector()
    let projects: Project[] = [
      {
        path: '/work',
        sessions: [
          session('a'),
          session('b', 'working'),
          session('c', 'idle', true),
          session('d', 'idle', false, true),
          session('e', 'approval', false, true),
        ],
      },
    ]

    let arranged = projector.project(projects)
    expect(ids(arranged.orderedProjects)).toEqual(['b', 'c', 'a'])
    expect(arranged.pinnedSessions.map(({ session: entry }) => entry.id)).toEqual(['e', 'd'])

    projects = updateSession(projects, 'a', (entry) => ({ ...entry, status: 'working' }))
    arranged = projector.project(projects)
    expect(ids(arranged.orderedProjects)).toEqual(['a', 'b', 'c'])

    projects = updateSession(projects, 'c', (entry) => ({ ...entry, unread: false }))
    arranged = projector.project(projects)
    expect(ids(arranged.orderedProjects)).toEqual(['a', 'b', 'c'])

    projects = updateSession(projects, 'b', (entry) => ({ ...entry, pinned: true }))
    arranged = projector.project(projects)
    expect(ids(arranged.orderedProjects)).toEqual(['a', 'c'])
    expect(arranged.pinnedSessions.map(({ session: entry }) => entry.id)).toEqual(['b', 'e', 'd'])

    const orderedBeforePinnedTitle = arranged.orderedProjects[0]
    projects = updateSession(projects, 'd', (entry) => ({ ...entry, title: 'Renamed' }))
    arranged = projector.project(projects)
    expect(arranged.orderedProjects[0]).toBe(orderedBeforePinnedTitle)
    expect(arranged.pinnedSessions.at(-1)?.session.title).toBe('Renamed')

    projects = updateSession(projects, 'a', (entry) => ({ ...entry, status: 'idle' }))
    arranged = projector.project(projects)
    expect(ids(arranged.orderedProjects)).toEqual(['a', 'c'])
  })

  it('projects only the visible pinned window and keeps an off-page active chat', () => {
    const projector = createClassicSidebarProjector()
    const projects: Project[] = [
      {
        path: '/work',
        sessions: [
          session('active-1', 'working', false, true),
          session('active-2', 'approval', false, true),
          session('unread', 'idle', true, true),
          session('rest-1', 'idle', false, true),
          session('rest-2', 'idle', false, true),
        ],
      },
    ]

    const window = projector.projectWindow(projects, 2, 'rest-2')

    expect(window.pinnedSessionCount).toBe(5)
    expect(window.pinnedSessions.map(({ session: entry }) => entry.id)).toEqual([
      'active-1',
      'active-2',
      'rest-2',
    ])
  })
})
