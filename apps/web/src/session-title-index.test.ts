import { describe, expect, it } from 'vitest'
import {
  createSessionTitleIndex,
  createSessionTitleIndexer,
  searchSessionTitles,
} from './session-title-index.js'

const projects = [
  {
    path: '/alpha',
    sessions: [
      { id: 'contains-old', title: 'Old alpha notes', provider: 'codex' as const, createdAt: 1 },
      { id: 'starts', title: 'Alpha plan', provider: 'grok' as const, createdAt: 2 },
      { id: 'exact', title: 'Alpha', provider: 'codex' as const, createdAt: 3 },
      { id: 'contains-new', title: 'New alpha notes', provider: 'codex' as const, createdAt: 4 },
    ],
  },
  {
    path: 'C:\\beta',
    name: 'Beta project',
    sessions: [{ id: 'beta', title: 'Alpha from beta', provider: 'codex' as const, createdAt: 5 }],
  },
]

describe('session title index', () => {
  it('ranks exact, prefix, and newest contains matches without sorting every hit', () => {
    const index = createSessionTitleIndex(projects)

    expect(searchSessionTitles(index, ['alpha']).map((entry) => entry.threadId)).toEqual([
      'exact',
      'beta',
      'starts',
      'contains-new',
      'contains-old',
    ])
  })

  it('applies project, provider, and result limits', () => {
    const index = createSessionTitleIndex(projects)

    expect(
      searchSessionTitles(index, ['alpha'], {
        projectPath: '/alpha',
        provider: 'codex',
        limit: 2,
      }).map((entry) => entry.threadId),
    ).toEqual(['exact', 'contains-new'])
    expect(index.find((entry) => entry.threadId === 'beta')?.projectName).toBe('Beta project')
  })

  it('retains the index for status-only updates and replaces changed titles', () => {
    const indexTitles = createSessionTitleIndexer()
    const initial = indexTitles(projects)
    const statusUpdated = projects.map((project, projectIndex) =>
      projectIndex === 0
        ? {
            ...project,
            sessions: project.sessions.map((session, sessionIndex) =>
              sessionIndex === 0 ? { ...session, status: 'working' } : session,
            ),
          }
        : project,
    )
    const retained = indexTitles(statusUpdated)
    const renamed = statusUpdated.map((project, projectIndex) =>
      projectIndex === 0
        ? {
            ...project,
            sessions: project.sessions.map((session, sessionIndex) =>
              sessionIndex === 0 ? { ...session, title: 'Renamed chat' } : session,
            ),
          }
        : project,
    )
    const updated = indexTitles(renamed)

    expect(retained).toBe(initial)
    expect(updated).not.toBe(initial)
    expect(updated[1]).toBe(initial[1])
    expect(updated[0]).toMatchObject({
      threadId: 'contains-old',
      threadTitle: 'Renamed chat',
      normalizedTitle: 'renamed chat',
    })
  })
})
