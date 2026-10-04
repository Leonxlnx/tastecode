import { bench, describe } from 'vitest'
import { z } from 'zod'
import { applySessionOrder, parseStoredSessionOrder, type SessionOrder } from './sidebar-order.js'
import type { Project, Session } from './ui/Sidebar.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const SessionOrderSchema = z.record(z.string(), z.array(z.string()))
const projects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex): Session => ({
    id: `thread-${projectIndex}-${sessionIndex}`,
    title: 'Thread',
    provider: 'codex',
    createdAt: sessionIndex,
    status: 'idle',
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  })),
}))
const order: SessionOrder = Object.fromEntries(
  projects.map((project) => [project.path, project.sessions.map((session) => session.id)]),
)
const raw = JSON.stringify(order)
parseStoredSessionOrder(raw)

function legacyParse(): SessionOrder {
  return SessionOrderSchema.parse(JSON.parse(raw))
}

function legacyApply(project: Project, savedOrder: SessionOrder): Session[] {
  const byId = new Map(project.sessions.map((session) => [session.id, session]))
  const known = (savedOrder[project.path] ?? []).flatMap((id) => {
    const session = byId.get(id)
    if (!session) return []
    byId.delete(id)
    return [session]
  })
  return [...byId.values(), ...known]
}

describe('many-thread saved sidebar order', () => {
  bench(
    'parses and validates the same 10,000-chat JSON again',
    () => {
      legacyParse()
    },
    OPTIONS,
  )
  bench(
    'reuses the validated 10,000-chat order',
    () => {
      parseStoredSessionOrder(raw)
    },
    OPTIONS,
  )

  bench(
    'rebuilds 100 already-ordered session arrays',
    () => {
      for (const project of projects) legacyApply(project, order)
    },
    OPTIONS,
  )
  bench(
    'retains 100 already-ordered session arrays',
    () => {
      for (const project of projects) applySessionOrder(project.path, project.sessions, order)
    },
    OPTIONS,
  )
})
