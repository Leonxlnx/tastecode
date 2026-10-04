import { bench, describe } from 'vitest'
import { updateSession } from './project-store.js'
import {
  createSessionTitleIndex,
  createSessionTitleIndexer,
  searchSessionTitles,
} from './session-title-index.js'
import type { Project } from './ui/Sidebar.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 3, warmupTime: 0 }
const projects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) => ({
    id: `thread-${projectIndex}-${sessionIndex}`,
    title: `Performance chat ${projectIndex}-${sessionIndex}`,
    provider: 'codex' as const,
    createdAt: projectIndex * 100 + sessionIndex,
    status: 'idle' as const,
    lifecycle: { state: 'active' as const, keepActive: false },
    unread: false,
  })),
}))
const index = createSessionTitleIndex(projects)
const statusUpdatedProjects = updateSession(projects, 'thread-50-50', (session) => ({
  ...session,
  status: 'working',
}))
const indexStatusUpdates = createSessionTitleIndexer()
indexStatusUpdates(projects)
let statusFrame = false

function legacySearch(): string[] {
  const matches: Array<{
    id: string
    title: string
    normalized: string
    createdAt: number
    rank: number
  }> = []
  for (const project of projects) {
    for (const session of project.sessions) {
      const normalized = session.title.normalize('NFKC').toLowerCase()
      if (!normalized.includes('chat')) continue
      matches.push({
        id: session.id,
        title: session.title,
        normalized,
        createdAt: session.createdAt,
        rank: normalized.startsWith('chat') ? 1 : 2,
      })
    }
  }
  return matches
    .sort((left, right) => left.rank - right.rank || right.createdAt - left.createdAt)
    .slice(0, 6)
    .map(({ id }) => id)
}

describe('many-thread local title search', () => {
  bench(
    'normalizes, allocates, and sorts all 10,000 legacy matches',
    () => {
      if (legacySearch().length !== 6) throw new Error('invalid legacy results')
    },
    OPTIONS,
  )

  bench(
    'selects six results from the cached title index',
    () => {
      if (searchSessionTitles(index, ['chat']).length !== 6)
        throw new Error('invalid indexed results')
    },
    OPTIONS,
  )
})

describe('open search during a status update', () => {
  bench(
    'rebuilds all 10,000 indexed titles after one status update',
    () => {
      if (createSessionTitleIndex(statusUpdatedProjects).length !== 10_000) {
        throw new Error('invalid rebuilt title index')
      }
    },
    OPTIONS,
  )

  bench(
    'retains the 10,000-title index across one status update',
    () => {
      statusFrame = !statusFrame
      const entries = indexStatusUpdates(statusFrame ? statusUpdatedProjects : projects)
      if (entries.length !== 10_000) throw new Error('invalid retained title index')
    },
    OPTIONS,
  )
})
