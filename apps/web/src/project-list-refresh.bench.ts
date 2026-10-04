import { bench, describe } from 'vitest'
import type { ResultOf } from '@harness/contracts'
import { reconcileProjectList } from './project-store.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const snapshot: ResultOf<'projects.list'>['projects'] = Array.from(
  { length: 100 },
  (_, projectIndex) => ({
    path: `/project-${projectIndex}`,
    name: `Project ${projectIndex}`,
    pinned: projectIndex < 3,
    createdAt: projectIndex,
    sessions: Array.from({ length: 100 }, (_, sessionIndex) => ({
      id: `thread-${projectIndex}-${sessionIndex}`,
      title: `Thread ${projectIndex}-${sessionIndex}`,
      provider: 'codex',
      createdAt: sessionIndex,
      running: false,
      pinned: false,
      status: 'idle',
      unread: false,
      lifecycle: { state: 'active', keepActive: false },
    })),
  }),
)
const projectOrder = snapshot.map((project) => project.path)
const sessionOrder = Object.fromEntries(
  snapshot.map((project) => [project.path, project.sessions.map((session) => session.id)]),
)
const current = reconcileProjectList([], snapshot, projectOrder, sessionOrder, 1)

describe('unchanged 10,000-thread response projection', () => {
  bench(
    'orders and reconciles the wire response in one pass',
    () => {
      if (reconcileProjectList(current, snapshot, projectOrder, sessionOrder, 2) !== current) {
        throw new Error('fused refresh changed')
      }
    },
    OPTIONS,
  )
})
