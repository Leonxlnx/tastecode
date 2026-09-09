import type { ResultOf } from '@harness/contracts'
import { applyProjectOrder, applySessionOrder, type SessionOrder } from './sidebar-order.js'
import type { Project } from './ui/Sidebar.js'

type Session = Project['sessions'][number]
type Lifecycle = Session['lifecycle']
type ServerProject = ResultOf<'projects.list'>['projects'][number]
type ServerSession = ServerProject['sessions'][number]
type SessionLocation = { projectIndex: number; sessionIndex: number }
type ProjectSessionChanges = { source: Project[]; locations: SessionLocation[] }
type SessionIndexMutation =
  | {
      kind: 'promote'
      threadId: string
      projectIndex: number
      sessionIndex: number
    }
  | {
      kind: 'remove'
      threadId: string
      projectIndex: number
      sessionIndex: number
    }
type SessionIndexOverlay = {
  source: Project[]
  mutations: SessionIndexMutation[]
}

const sessionIndexes = new WeakMap<Project[], Map<string, SessionLocation>>()
const sessionIndexOverlays = new WeakMap<Project[], SessionIndexOverlay>()
const sessionChanges = new WeakMap<Project[], ProjectSessionChanges>()
const MAX_RETAINED_SESSION_CHANGES = 32
// A reorder becomes one small arithmetic transform instead of thousands of
// copied map entries. Materialize after a bounded chain so every lookup stays
// constant-space and has a strict upper limit.
const MAX_SESSION_INDEX_OVERLAY_MUTATIONS = 64

function locationsFor(projects: Project[]): Map<string, SessionLocation> {
  const cached = sessionIndexes.get(projects)
  if (cached) return cached

  const locations = new Map<string, SessionLocation>()
  for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
    const sessions = projects[projectIndex]!.sessions
    for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
      const id = sessions[sessionIndex]!.id
      if (!locations.has(id)) locations.set(id, { projectIndex, sessionIndex })
    }
  }
  sessionIndexes.set(projects, locations)
  return locations
}

function locationFor(projects: Project[], threadId: string): SessionLocation | undefined {
  let locations = sessionIndexes.get(projects)
  const overlay = locations ? undefined : sessionIndexOverlays.get(projects)
  if (overlay) {
    const inherited = locationFor(overlay.source, threadId)
    if (!inherited) return undefined
    const transformed = transformSessionLocation(inherited, threadId, overlay.mutations)
    if (!transformed) return undefined
    if (projects[transformed.projectIndex]?.sessions[transformed.sessionIndex]?.id === threadId) {
      return transformed
    }
    // An in-place mutation invalidated the immutable overlay. Rebuild below.
    sessionIndexOverlays.delete(projects)
  }

  locations ??= locationsFor(projects)
  const cached = locations.get(threadId)
  if (!cached) return undefined
  if (projects[cached.projectIndex]?.sessions[cached.sessionIndex]?.id === threadId) {
    return cached
  }

  // A caller that mutates an array in place breaks the immutable fast path.
  // Rebuild once and stay correct instead of returning the wrong chat.
  sessionIndexes.delete(projects)
  locations = locationsFor(projects)
  return locations.get(threadId)
}

/** Apply move-to-front and deletion shifts without rebuilding the full index. */
function transformSessionLocation(
  source: SessionLocation,
  threadId: string,
  mutations: readonly SessionIndexMutation[],
): SessionLocation | undefined {
  let sessionIndex = source.sessionIndex
  for (const mutation of mutations) {
    if (mutation.projectIndex !== source.projectIndex) continue
    if (mutation.kind === 'promote') {
      if (mutation.threadId === threadId) sessionIndex = 0
      else if (sessionIndex < mutation.sessionIndex) sessionIndex += 1
      continue
    }
    if (mutation.threadId === threadId) return undefined
    if (sessionIndex > mutation.sessionIndex) sessionIndex -= 1
  }
  return { projectIndex: source.projectIndex, sessionIndex }
}

function inheritSessionIndex(source: Project[], target: Project[]): void {
  const locations = sessionIndexes.get(source)
  if (locations) {
    sessionIndexes.set(target, locations)
    return
  }
  const overlay = sessionIndexOverlays.get(source)
  if (overlay) sessionIndexOverlays.set(target, overlay)
}

/** Flatten immutable reorder history, then periodically reset it to one exact map. */
function appendSessionIndexMutation(
  source: Project[],
  target: Project[],
  mutation: SessionIndexMutation,
): void {
  const inherited = sessionIndexOverlays.get(source)
  if (
    inherited &&
    !sessionIndexes.has(source) &&
    inherited.mutations.length >= MAX_SESSION_INDEX_OVERLAY_MUTATIONS
  ) {
    locationsFor(target)
    return
  }
  if (!inherited || sessionIndexes.has(source)) {
    sessionIndexOverlays.set(target, { source, mutations: [mutation] })
    return
  }
  sessionIndexOverlays.set(target, {
    source: inherited.source,
    mutations: [...inherited.mutations, mutation],
  })
}

/** Returns and releases precise immutable update locations for one render transition. */
export function takeProjectSessionChanges(
  source: Project[],
  target: Project[],
): readonly SessionLocation[] | undefined {
  const changes = sessionChanges.get(target)
  sessionChanges.delete(target)
  return changes?.source === source ? changes.locations : undefined
}

function recordSessionChange(
  source: Project[],
  target: Project[],
  location: SessionLocation,
): void {
  recordSessionChanges(source, target, [location])
}

function recordSessionChanges(
  source: Project[],
  target: Project[],
  changedLocations: readonly SessionLocation[],
): void {
  const inherited = sessionChanges.get(source)
  const root = inherited?.source ?? source
  const locations = inherited ? [...inherited.locations] : []
  for (const location of changedLocations) {
    const existing = locations.findIndex(
      (candidate) =>
        candidate.projectIndex === location.projectIndex &&
        candidate.sessionIndex === location.sessionIndex,
    )
    if (existing < 0) {
      // Exact hints are deliberately capped. Stop as soon as this transition
      // cannot be retained instead of doing a quadratic duplicate scan across
      // a large status or lifecycle burst that will be rebuilt once anyway.
      if (locations.length >= MAX_RETAINED_SESSION_CHANGES) return
      locations.push(location)
    } else locations[existing] = location
  }
  sessionChanges.set(target, { source: root, locations })
}

export function findSession(projects: Project[], threadId: string | undefined) {
  if (!threadId) return undefined
  const location = locationFor(projects, threadId)
  if (!location) return undefined
  const project = projects[location.projectIndex]
  const session = project?.sessions[location.sessionIndex]
  return project && session ? { project, session } : undefined
}

/**
 * Update one chat while retaining every unrelated project and session.
 *
 * Status pushes are common when several chats work at once. Copying every
 * project and every session for one changed row made that cost grow with the
 * complete sidebar. The search is still linear, but allocation is limited to
 * the two arrays and one project that actually changed.
 */
export function updateSession(
  projects: Project[],
  threadId: string,
  update: (session: Session) => Session,
): Project[] {
  const location = locationFor(projects, threadId)
  if (!location) return projects
  const project = projects[location.projectIndex]!
  const current = project.sessions[location.sessionIndex]!
  const updated = update(current)
  if (updated === current) return projects

  const sessions = [...project.sessions]
  sessions[location.sessionIndex] = updated
  const next = [...projects]
  next[location.projectIndex] = { ...project, sessions }
  if (updated.id === current.id) {
    inheritSessionIndex(projects, next)
    recordSessionChange(projects, next, location)
  }
  return next
}

/** Update a known set of chats without scanning every sidebar row. */
export function updateSessions<Value>(
  projects: Project[],
  updates: ReadonlyMap<string, Value>,
  update: (session: Session, value: Value) => Session,
): Project[] {
  let next: Project[] | undefined
  const copiedSessions = new Map<number, Session[]>()
  const changedLocations: SessionLocation[] = []
  let idsStable = true

  for (const [threadId, value] of updates) {
    const location = locationFor(projects, threadId)
    if (!location) continue
    const project = projects[location.projectIndex]!
    let sessions = copiedSessions.get(location.projectIndex)
    const current = sessions?.[location.sessionIndex] ?? project.sessions[location.sessionIndex]!
    const updated = update(current, value)
    if (updated === current) continue

    next ??= [...projects]
    if (!sessions) {
      sessions = [...project.sessions]
      copiedSessions.set(location.projectIndex, sessions)
      next[location.projectIndex] = { ...project, sessions }
    }
    sessions[location.sessionIndex] = updated
    changedLocations.push(location)
    if (updated.id !== current.id) idsStable = false
  }

  if (!next) return projects
  if (idsStable) {
    inheritSessionIndex(projects, next)
    recordSessionChanges(projects, next, changedLocations)
  }
  return next
}

export function promoteSession(projects: Project[], threadId: string): Project[] {
  const location = locationFor(projects, threadId)
  if (!location || location.sessionIndex === 0) return projects
  const project = projects[location.projectIndex]!
  const sessions = [...project.sessions]
  const [session] = sessions.splice(location.sessionIndex, 1)
  if (!session) return projects
  sessions.unshift(session)
  const next = [...projects]
  next[location.projectIndex] = { ...project, sessions }
  appendSessionIndexMutation(projects, next, {
    kind: 'promote',
    threadId,
    projectIndex: location.projectIndex,
    sessionIndex: location.sessionIndex,
  })
  return next
}

export function removeSession(projects: Project[], threadId: string): Project[] {
  const location = locationFor(projects, threadId)
  if (!location) return projects
  const project = projects[location.projectIndex]!
  const sessions = [...project.sessions]
  sessions.splice(location.sessionIndex, 1)
  const next = [...projects]
  next[location.projectIndex] = { ...project, sessions }
  appendSessionIndexMutation(projects, next, {
    kind: 'remove',
    threadId,
    projectIndex: location.projectIndex,
    sessionIndex: location.sessionIndex,
  })
  return next
}

/** Convert, order, and reconcile the server snapshot in one pass without a temporary UI tree. */
export function reconcileProjectList(
  current: Project[],
  snapshot: ServerProject[],
  projectOrder: readonly string[],
  sessionOrder: SessionOrder,
  now = Date.now(),
): Project[] {
  const orderedProjects = applyProjectOrder(snapshot, projectOrder)
  let currentByPath: Map<string, Project> | undefined
  let treeChanged = current.length !== orderedProjects.length
  let exactSessionChanges = current.length === orderedProjects.length
  const changedLocations: SessionLocation[] = []
  const projects: Project[] = []

  for (let projectIndex = 0; projectIndex < orderedProjects.length; projectIndex += 1) {
    const project = orderedProjects[projectIndex]!
    let previous = current[projectIndex]
    if (previous?.path !== project.path) {
      exactSessionChanges = false
      currentByPath ??= new Map(current.map((entry) => [entry.path, entry]))
      previous = currentByPath.get(project.path)
    }
    if (!previous) {
      treeChanged = true
      projects.push(materializeProject(project, sessionOrder, now))
      continue
    }

    const orderedSessions = applySessionOrder(project.path, project.sessions, sessionOrder)
    if (
      previous.name !== project.name ||
      previous.pinned !== project.pinned ||
      previous.sessions.length !== orderedSessions.length
    ) {
      exactSessionChanges = false
    }

    let currentById: Map<string, Session> | undefined
    let sessionsChanged = previous.sessions.length !== orderedSessions.length
    const sessions: Session[] = []
    for (let sessionIndex = 0; sessionIndex < orderedSessions.length; sessionIndex += 1) {
      const session = orderedSessions[sessionIndex]!
      let prior = previous.sessions[sessionIndex]
      if (prior?.id !== session.id) {
        exactSessionChanges = false
        currentById ??= new Map(previous.sessions.map((entry) => [entry.id, entry]))
        prior = currentById.get(session.id)
      }
      const next = reconcileServerSession(prior, session, now)
      sessions.push(next)
      if (next !== previous.sessions[sessionIndex]) {
        sessionsChanged = true
        if (exactSessionChanges) {
          if (changedLocations.length < MAX_RETAINED_SESSION_CHANGES) {
            changedLocations.push({ projectIndex, sessionIndex })
          } else {
            exactSessionChanges = false
            changedLocations.length = 0
          }
        }
      }
    }

    const sameProject =
      previous.name === project.name && previous.pinned === project.pinned && !sessionsChanged
    const next = sameProject
      ? previous
      : {
          path: project.path,
          name: project.name,
          pinned: project.pinned,
          sessions: sessionsChanged ? sessions : previous.sessions,
        }
    projects.push(next)
    if (next !== current[projectIndex]) treeChanged = true
  }

  if (!treeChanged) return current
  if (
    exactSessionChanges &&
    changedLocations.length > 0 &&
    changedLocations.length <= MAX_RETAINED_SESSION_CHANGES
  ) {
    inheritSessionIndex(current, projects)
    recordSessionChanges(current, projects, changedLocations)
  }
  return projects
}

function materializeProject(
  project: ServerProject,
  sessionOrder: SessionOrder,
  now: number,
): Project {
  return {
    path: project.path,
    name: project.name,
    pinned: project.pinned,
    sessions: applySessionOrder(project.path, project.sessions, sessionOrder).map((session) =>
      reconcileServerSession(undefined, session, now),
    ),
  }
}

function reconcileServerSession(
  current: Session | undefined,
  snapshot: ServerSession,
  now: number,
): Session {
  const status = snapshot.status ?? (snapshot.running ? 'working' : 'idle')
  const statusSince =
    current?.status === status ? current.statusSince : snapshot.running ? now : snapshot.createdAt
  const lifecycle = snapshot.lifecycle ?? DEFAULT_ACTIVE_LIFECYCLE
  const sameLifecycle = current ? lifecycleEqual(current.lifecycle, lifecycle) : false
  const agent = snapshot.agent || undefined
  const pinned = snapshot.pinned ?? false
  const unread = snapshot.unread ?? false
  const worktreeBranch = snapshot.worktreeBranch || undefined
  if (
    current?.title === snapshot.title &&
    current.provider === snapshot.provider &&
    current.agent === agent &&
    current.createdAt === snapshot.createdAt &&
    current.status === status &&
    current.statusSince === statusSince &&
    sameLifecycle &&
    current.unread === unread &&
    current.pinned === pinned &&
    current.worktreeBranch === worktreeBranch
  ) {
    return current
  }
  return {
    id: snapshot.id,
    title: snapshot.title,
    provider: snapshot.provider,
    ...(agent ? { agent } : {}),
    createdAt: snapshot.createdAt,
    statusSince,
    status,
    lifecycle: sameLifecycle && current ? current.lifecycle : lifecycle,
    unread,
    pinned,
    ...(worktreeBranch ? { worktreeBranch } : {}),
  }
}

const DEFAULT_ACTIVE_LIFECYCLE: Lifecycle = Object.freeze({ state: 'active', keepActive: false })

function lifecycleEqual(current: Lifecycle, snapshot: Lifecycle): boolean {
  if (current.state !== snapshot.state) return false
  if (current.state === 'active' && snapshot.state === 'active') {
    return current.keepActive === snapshot.keepActive && current.wokeAt === snapshot.wokeAt
  }
  if (current.state === 'settled' && snapshot.state === 'settled') {
    return current.settledAt === snapshot.settledAt && current.reason === snapshot.reason
  }
  if (current.state === 'snoozed' && snapshot.state === 'snoozed') {
    return current.snoozedAt === snapshot.snoozedAt && current.wakeAt === snapshot.wakeAt
  }
  return false
}

export function markSessionRead(session: Session): Session {
  const status = session.status === 'ready' ? 'idle' : session.status
  const lifecycle =
    session.lifecycle.state === 'active' && session.lifecycle.wokeAt !== undefined
      ? { state: 'active' as const, keepActive: session.lifecycle.keepActive }
      : session.lifecycle

  if (!session.unread && status === session.status && lifecycle === session.lifecycle) {
    return session
  }

  return { ...session, unread: false, status, lifecycle }
}
