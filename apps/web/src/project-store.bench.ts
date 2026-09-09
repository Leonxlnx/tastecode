import { bench, describe } from 'vitest'
import type { Project, Session } from './ui/Sidebar.js'
import {
  findSession,
  promoteSession,
  removeSession,
  updateSession,
  updateSessions,
} from './project-store.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }

function session(id: string): Session {
  return {
    id,
    title: id,
    provider: 'codex',
    createdAt: 0,
    status: 'idle',
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  }
}

const projects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) =>
    session(`thread-${projectIndex}-${sessionIndex}`),
  ),
}))
const target = 'thread-99-99'

function legacyUpdateSession(
  current: Project[],
  threadId: string,
  update: (entry: Session) => Session,
): Project[] {
  return current.map((project) => ({
    ...project,
    sessions: project.sessions.map((entry) => (entry.id === threadId ? update(entry) : entry)),
  }))
}

function legacyFindSession(current: Project[], threadId: string): Session | undefined {
  for (const project of current) {
    const entry = project.sessions.find((session) => session.id === threadId)
    if (entry) return entry
  }
  return undefined
}

function legacyRemoveSession(current: Project[], threadId: string): Project[] {
  return current.map((project) => ({
    ...project,
    sessions: project.sessions.filter((session) => session.id !== threadId),
  }))
}

function legacyPromoteSession(current: Project[], threadId: string): Project[] {
  const next = current.map((project) => {
    const index = project.sessions.findIndex((entry) => entry.id === threadId)
    if (index <= 0) return project
    const sessions = [...project.sessions]
    const [entry] = sessions.splice(index, 1)
    if (entry) sessions.unshift(entry)
    return { ...project, sessions }
  })
  return next
}

type PreviousLocation = { projectIndex: number; sessionIndex: number }
type PreviousOverlay = {
  source: Project[]
  locations: Map<string, PreviousLocation | undefined>
}
const previousPromotionIndexes = new WeakMap<Project[], Map<string, PreviousLocation>>()
const previousPromotionOverlays = new WeakMap<Project[], PreviousOverlay>()
const previousOverflowIndexes = new WeakMap<Project[], Map<string, PreviousLocation>>()
const PREVIOUS_INDEX_OVERLAY_LOCATION_LIMIT = 256

function previousPromotionLocations(projects: Project[]): Map<string, PreviousLocation> {
  const cached = previousPromotionIndexes.get(projects)
  if (cached) return cached
  const locations = new Map<string, PreviousLocation>()
  for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
    const sessions = projects[projectIndex]!.sessions
    for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
      const id = sessions[sessionIndex]!.id
      if (!locations.has(id)) locations.set(id, { projectIndex, sessionIndex })
    }
  }
  previousPromotionIndexes.set(projects, locations)
  return locations
}

function previousPromotionLocation(
  projects: Project[],
  threadId: string,
): PreviousLocation | undefined {
  const cached = previousPromotionIndexes.get(projects)?.get(threadId)
  if (cached) return cached
  const overlay = previousPromotionOverlays.get(projects)
  if (overlay) {
    const inherited = overlay.locations.has(threadId)
      ? overlay.locations.get(threadId)
      : previousPromotionLocation(overlay.source, threadId)
    if (
      inherited &&
      projects[inherited.projectIndex]?.sessions[inherited.sessionIndex]?.id === threadId
    ) {
      return inherited
    }
  }
  return previousPromotionLocations(projects).get(threadId)
}

function previousPromoteSession(projects: Project[], threadId: string): Project[] {
  const location = previousPromotionLocation(projects, threadId)
  if (!location || location.sessionIndex === 0) return projects
  const project = projects[location.projectIndex]!
  const sessions = [...project.sessions]
  const [entry] = sessions.splice(location.sessionIndex, 1)
  if (!entry) return projects
  sessions.unshift(entry)
  const next = [...projects]
  next[location.projectIndex] = { ...project, sessions }
  const changed = new Map<string, PreviousLocation>()
  for (let sessionIndex = 0; sessionIndex <= location.sessionIndex; sessionIndex += 1) {
    changed.set(sessions[sessionIndex]!.id, {
      projectIndex: location.projectIndex,
      sessionIndex,
    })
  }
  const inherited = previousPromotionOverlays.get(projects)
  if (!inherited || previousPromotionIndexes.has(projects)) {
    previousPromotionOverlays.set(next, { source: projects, locations: changed })
  } else {
    const locations = new Map(inherited.locations)
    for (const [id, nextLocation] of changed) locations.set(id, nextLocation)
    previousPromotionOverlays.set(next, { source: inherited.source, locations })
  }
  return next
}

function previousOverflowLocations(projects: Project[]): Map<string, PreviousLocation> {
  const cached = previousOverflowIndexes.get(projects)
  if (cached) return cached
  const locations = new Map<string, PreviousLocation>()
  for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
    const sessions = projects[projectIndex]!.sessions
    for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
      const id = sessions[sessionIndex]!.id
      if (!locations.has(id)) locations.set(id, { projectIndex, sessionIndex })
    }
  }
  previousOverflowIndexes.set(projects, locations)
  return locations
}

function previousOverflowPromoteSession(projects: Project[], threadId: string): Project[] {
  const location = previousOverflowLocations(projects).get(threadId)
  if (!location || location.sessionIndex === 0) return projects
  const project = projects[location.projectIndex]!
  const sessions = [...project.sessions]
  const [entry] = sessions.splice(location.sessionIndex, 1)
  if (!entry) return projects
  sessions.unshift(entry)
  const next = [...projects]
  next[location.projectIndex] = { ...project, sessions }
  if (location.sessionIndex + 1 <= PREVIOUS_INDEX_OVERLAY_LOCATION_LIMIT) {
    throw new Error('promotion no longer exercises the prior overflow fallback')
  }
  previousOverflowLocations(next)
  return next
}

function previousOverflowRemoveSession(projects: Project[], threadId: string): Project[] {
  const location = previousOverflowLocations(projects).get(threadId)
  if (!location) return projects
  const project = projects[location.projectIndex]!
  const sessions = [...project.sessions]
  sessions.splice(location.sessionIndex, 1)
  const next = [...projects]
  next[location.projectIndex] = { ...project, sessions }
  if (sessions.length - location.sessionIndex + 1 <= PREVIOUS_INDEX_OVERLAY_LOCATION_LIMIT) {
    throw new Error('deletion no longer exercises the prior overflow fallback')
  }
  previousOverflowLocations(next)
  return next
}

const update = (entry: Session): Session => ({
  ...entry,
  status: entry.status === 'working' ? 'idle' : 'working',
})

const oneLifecycleUpdate = new Map<string, Session['lifecycle']>([
  [target, { state: 'settled', settledAt: 1, reason: 'manual' }],
])
const lifecycleBurst = new Map<string, Session['lifecycle']>(
  Array.from({ length: 1_000 }, (_, index) => [
    `thread-${Math.floor(index / 100)}-${index % 100}`,
    { state: 'settled' as const, settledAt: 1, reason: 'inactivity' as const },
  ]),
)
const largePromotionProjects: Project[] = [
  {
    path: '/large-project',
    sessions: Array.from({ length: 10_000 }, (_, index) => session(`large-thread-${index}`)),
  },
]
const deepPromotionIds = Array.from({ length: 64 }, (_, offset) => `large-thread-${9_999 - offset}`)
const deepRemovalIds = Array.from({ length: 64 }, (_, offset) => `large-thread-${5_000 + offset}`)
findSession(largePromotionProjects, deepPromotionIds[0])
previousPromotionLocation(largePromotionProjects, deepPromotionIds[0]!)
previousOverflowLocations(largePromotionProjects)
let transformedPromotionProjects = largePromotionProjects
let exactPromotionProjects = largePromotionProjects
for (const threadId of deepPromotionIds) {
  transformedPromotionProjects = promoteSession(transformedPromotionProjects, threadId)
  exactPromotionProjects = legacyPromoteSession(exactPromotionProjects, threadId)
}
const promotionLookupTarget = 'large-thread-5000'
findSession(transformedPromotionProjects, promotionLookupTarget)
findSession(exactPromotionProjects, promotionLookupTarget)

function legacyLifecycleUpdate(
  current: Project[],
  updates: ReadonlyMap<string, Session['lifecycle']>,
): Project[] {
  return current.map((project) => ({
    ...project,
    sessions: project.sessions.map((entry) => {
      const lifecycle = updates.get(entry.id)
      return lifecycle ? { ...entry, lifecycle } : entry
    }),
  }))
}

describe('many-thread sidebar updates', () => {
  bench(
    'legacy full-tree copy for one of 10,000 sessions',
    () => {
      legacyUpdateSession(projects, target, update)
    },
    OPTIONS,
  )

  bench(
    'indexed structural copy for one of 10,000 sessions',
    () => {
      updateSession(projects, target, update)
    },
    OPTIONS,
  )

  bench(
    'scans 10,000 sessions for one lifecycle result',
    () => {
      legacyLifecycleUpdate(projects, oneLifecycleUpdate)
    },
    OPTIONS,
  )

  bench(
    'updates one indexed lifecycle result',
    () => {
      updateSessions(projects, oneLifecycleUpdate, (entry, lifecycle) => ({
        ...entry,
        lifecycle,
      }))
    },
    OPTIONS,
  )
})

describe('many-thread lifecycle push bursts', () => {
  bench(
    'applies 1,000 lifecycle pushes as 1,000 tree updates',
    () => {
      let next = projects
      for (const [threadId, lifecycle] of lifecycleBurst) {
        next = updateSession(next, threadId, (entry) => ({ ...entry, lifecycle }))
      }
      if (findSession(next, 'thread-9-99')?.session.lifecycle.state !== 'settled') {
        throw new Error('missing sequential lifecycle update')
      }
    },
    { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 },
  )

  bench(
    'applies 1,000 lifecycle pushes in one tree update',
    () => {
      const next = updateSessions(projects, lifecycleBurst, (entry, lifecycle) => ({
        ...entry,
        lifecycle,
      }))
      if (findSession(next, 'thread-9-99')?.session.lifecycle.state !== 'settled') {
        throw new Error('missing batched lifecycle update')
      }
    },
    { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 },
  )
})

describe('many-thread sidebar lookups', () => {
  bench(
    'linear lookup for one of 10,000 sessions',
    () => {
      if (!legacyFindSession(projects, target)) throw new Error('missing target')
    },
    OPTIONS,
  )

  bench(
    'indexed lookup for one of 10,000 sessions',
    () => {
      if (!findSession(projects, target)) throw new Error('missing target')
    },
    OPTIONS,
  )

  bench(
    'exact lookup after materialized deep promotions',
    () => {
      if (!findSession(exactPromotionProjects, promotionLookupTarget)) {
        throw new Error('missing exact post-promotion target')
      }
    },
    OPTIONS,
  )

  bench(
    'bounded lookup through 64 promotion transforms',
    () => {
      if (!findSession(transformedPromotionProjects, promotionLookupTarget)) {
        throw new Error('missing transformed post-promotion target')
      }
    },
    OPTIONS,
  )
})

describe('many-thread sidebar deletion', () => {
  bench(
    'filters the full 10,000-session tree',
    () => {
      legacyRemoveSession(projects, target)
    },
    OPTIONS,
  )

  bench(
    'removes the indexed session from its owning project',
    () => {
      removeSession(projects, target)
    },
    OPTIONS,
  )

  bench(
    'uses the prior overflow fallback across 64 middle deletions',
    () => {
      let next = largePromotionProjects
      for (const threadId of deepRemovalIds) next = previousOverflowRemoveSession(next, threadId)
      if (next[0]?.sessions.length !== 10_000 - deepRemovalIds.length) {
        throw new Error('missing materialized deletions')
      }
    },
    OPTIONS,
  )

  bench(
    'transforms indices across 64 middle deletions',
    () => {
      let next = largePromotionProjects
      for (const threadId of deepRemovalIds) next = removeSession(next, threadId)
      if (next[0]?.sessions.length !== 10_000 - deepRemovalIds.length) {
        throw new Error('missing transformed deletions')
      }
    },
    OPTIONS,
  )
})

describe('many-thread sidebar promotion', () => {
  bench(
    'rebuilds the 10,000-session lookup after promotion',
    () => {
      const next = legacyPromoteSession(projects, target)
      if (!findSession(next, target)) throw new Error('missing promoted target')
    },
    OPTIONS,
  )

  bench(
    'transforms changed locations after promotion',
    () => {
      const next = promoteSession(projects, target)
      if (!findSession(next, target)) throw new Error('missing promoted target')
    },
    OPTIONS,
  )

  bench(
    'copies prior overlays across 64 deep promotions',
    () => {
      let next = largePromotionProjects
      for (const threadId of deepPromotionIds) next = previousPromoteSession(next, threadId)
      if (next[0]?.sessions[0]?.id !== deepPromotionIds.at(-1)) {
        throw new Error('missing prior promoted target')
      }
    },
    OPTIONS,
  )

  bench(
    'uses the prior overflow fallback across 64 deep promotions',
    () => {
      let next = largePromotionProjects
      for (const threadId of deepPromotionIds) next = previousOverflowPromoteSession(next, threadId)
      if (next[0]?.sessions[0]?.id !== deepPromotionIds.at(-1)) {
        throw new Error('missing materialized promoted target')
      }
    },
    OPTIONS,
  )

  bench(
    'transforms indices across 64 deep promotions',
    () => {
      let next = largePromotionProjects
      for (const threadId of deepPromotionIds) next = promoteSession(next, threadId)
      if (next[0]?.sessions[0]?.id !== deepPromotionIds.at(-1)) {
        throw new Error('missing transformed promoted target')
      }
    },
    OPTIONS,
  )
})
