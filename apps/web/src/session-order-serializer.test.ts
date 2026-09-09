import { describe, expect, it } from 'vitest'
import {
  createSessionOrderSerializer,
  type SessionOrderProject,
} from './session-order-serializer.js'

const projects: SessionOrderProject[] = [
  { path: '/alpha', sessions: [{ id: 'a-1' }, { id: 'a-2' }] },
  { path: '/beta', sessions: [{ id: 'b-1' }] },
]

describe('session order serializer', () => {
  it('skips status-only structural copies', () => {
    const serialize = createSessionOrderSerializer()
    expect(serialize(projects)).toBe(JSON.stringify({ '/alpha': ['a-1', 'a-2'], '/beta': ['b-1'] }))

    const statusUpdate = [
      { ...projects[0]!, sessions: projects[0]!.sessions.map((session) => ({ ...session })) },
      projects[1]!,
    ]
    expect(serialize(statusUpdate)).toBeUndefined()
  })

  it('serializes additions, reorders, and removals', () => {
    const serialize = createSessionOrderSerializer()
    serialize(projects)

    const reordered = [
      { ...projects[0]!, sessions: [projects[0]!.sessions[1]!, projects[0]!.sessions[0]!] },
      projects[1]!,
    ]
    expect(serialize(reordered)).toBe(
      JSON.stringify({ '/alpha': ['a-2', 'a-1'], '/beta': ['b-1'] }),
    )

    expect(serialize([reordered[0]!])).toBe(JSON.stringify({ '/alpha': ['a-2', 'a-1'] }))
  })
})
