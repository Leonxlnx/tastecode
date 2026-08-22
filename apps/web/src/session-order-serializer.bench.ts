import { bench, describe } from 'vitest'
import {
  createSessionOrderSerializer,
  type SessionOrderProject,
} from './session-order-serializer.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const base: SessionOrderProject[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) => ({
    id: `thread-${projectIndex}-${sessionIndex}`,
  })),
}))
const updated: SessionOrderProject[] = base.map((project, index) =>
  index === 50
    ? { ...project, sessions: project.sessions.map((session) => ({ ...session })) }
    : project,
)
let frame = 0

function legacySerialize(projects: SessionOrderProject[]): string {
  return JSON.stringify(
    Object.fromEntries(
      projects.map((project) => [project.path, project.sessions.map((session) => session.id)]),
    ),
  )
}

const serialize = createSessionOrderSerializer()
serialize(base)

describe('many-thread session order persistence', () => {
  bench(
    'legacy full serialization after a status update',
    () => {
      frame = frame === 0 ? 1 : 0
      legacySerialize(frame === 0 ? base : updated)
    },
    OPTIONS,
  )

  bench(
    'incremental unchanged-order check after a status update',
    () => {
      frame = frame === 0 ? 1 : 0
      serialize(frame === 0 ? base : updated)
    },
    OPTIONS,
  )
})
