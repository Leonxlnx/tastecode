import { describe, expect, it } from 'vitest'
import { createProjectChoiceProjector } from './project-choices.js'

describe('project choice projection', () => {
  it('retains choices across chat-only project changes', () => {
    const project = createProjectChoiceProjector()
    const first = project([{ path: '/alpha', name: 'Alpha' }, { path: '/beta' }])
    const changedProjects = [
      { path: '/alpha', name: 'Alpha', sessions: [{ id: 'changed' }] },
      { path: '/beta', sessions: [] },
    ]
    const second = project(changedProjects)

    expect(second).toBe(first)
    expect(second).toEqual([{ path: '/alpha', name: 'Alpha' }, { path: '/beta' }])
  })

  it('reprojects folder additions, renames, and reorders', () => {
    const project = createProjectChoiceProjector()
    const first = project([
      { path: '/alpha', name: 'Alpha' },
      { path: '/beta', name: 'Beta' },
    ])
    const renamed = project([
      { path: '/alpha', name: 'Renamed' },
      { path: '/beta', name: 'Beta' },
    ])
    const reordered = project([
      { path: '/beta', name: 'Beta' },
      { path: '/alpha', name: 'Renamed' },
      { path: '/gamma' },
    ])

    expect(renamed).not.toBe(first)
    expect(reordered).not.toBe(renamed)
    expect(reordered.map(({ path }) => path)).toEqual(['/beta', '/alpha', '/gamma'])
  })
})
