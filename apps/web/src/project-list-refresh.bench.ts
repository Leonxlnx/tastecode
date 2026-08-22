import { bench, describe } from 'vitest'
import type { ResultOf } from '@harness/contracts'
import { reconcileProjectList, reconcileProjects } from './project-store.js'
import { applyProjectOrder, applySessionOrder, type SessionOrder } from './sidebar-order.js'

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
const sessionOrder: SessionOrder = Object.fromEntries(
  snapshot.map((project) => [project.path, project.sessions.map((session) => session.id)]),
)
const current = reconcileProjectList([], snapshot, projectOrder, sessionOrder, 1)

function legacyRefresh() {
  const next = applyProjectOrder(
    snapshot.map((project) => ({
      path: project.path,
      name: project.name,
      pinned: project.pinned,
      sessions: applySessionOrder(
        project.path,
        project.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          provider: session.provider,
          ...(session.agent ? { agent: session.agent } : {}),
          createdAt: session.createdAt,
          statusSince: session.running ? 2 : session.createdAt,
          status: session.status ?? (session.running ? 'working' : 'idle'),
          lifecycle: session.lifecycle ?? { state: 'active' as const, keepActive: false },
          unread: session.unread ?? false,
          pinned: session.pinned ?? false,
          ...(session.worktreeBranch ? { worktreeBranch: session.worktreeBranch } : {}),
        })),
        sessionOrder,
      ),
    })),
    projectOrder,
  )
  return reconcileProjects(current, next)
}

describe('unchanged 10,000-thread response projection', () => {
  bench(
    'materializes, orders, then reconciles a temporary UI tree',
    () => {
      if (legacyRefresh() !== current) throw new Error('legacy refresh changed')
    },
    OPTIONS,
  )

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
