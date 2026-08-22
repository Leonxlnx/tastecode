import type { ResultOf } from '@harness/contracts'
import { applyProjectOrder, applySessionOrder, type SessionOrder } from './sidebar-order.js'
import type { Project } from './ui/Sidebar.js'

type Session = Project['sessions'][number]
type Lifecycle = Session['lifecycle']
type ServerProject = ResultOf<'projects.list'>['projects'][number]
type ServerSession = ServerProject['sessions'][number]
type SessionLocation = { projectIndex: number; sessionIndex: number }
type ProjectSessionChanges = { source: Project[]; locations: SessionLocation[] }

const sessionIndexes = new WeakMap<Project[], Map<string, SessionLocation>>()
const sessionChanges = new WeakMap<Project[], ProjectSessionChanges>()
const MAX_RETAINED_SESSION_CHANGES = 32

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
  let locations = locationsFor(projects)
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
    if (existing < 0) locations.push(location)
    else locations[existing] = location
  }
  if (locations.length <= MAX_RETAINED_SESSION_CHANGES) {
    sessionChanges.set(target, { source: root, locations })
  }
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
    sessionIndexes.set(next, locationsFor(projects))
    recordSessionChange(projects, next, location)
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
  return next
}

/**
 * Reuse exact project and chat objects from the current tree when a full
 * server snapshot reports the same values. This lets React skip a no-op
 * refresh and keeps the per-project sidebar projections warm.
 */
export function reconcileProjects(current: Project[], snapshot: Project[]): Project[] {
  const currentByPath = new Map(current.map((project) => [project.path, project]))
  let treeChanged = current.length !== snapshot.length
  let exactSessionChanges = current.length === snapshot.length
  const changedLocations: SessionLocation[] = []
  const projects = snapshot.map((project, projectIndex) => {
    const previous = currentByPath.get(project.path)
    if (!previous) {
      treeChanged = true
      exactSessionChanges = false
      return project
    }
    if (
      previous !== current[projectIndex] ||
      previous.name !== project.name ||
      previous.pinned !== project.pinned ||
      previous.sessions.length !== project.sessions.length
    ) {
      exactSessionChanges = false
    }

    let currentById: Map<string, Session> | undefined
    let sessionsChanged = previous.sessions.length !== project.sessions.length
    const sessions = project.sessions.map((session, sessionIndex) => {
      let prior = previous.sessions[sessionIndex]
      if (prior?.id !== session.id) {
        exactSessionChanges = false
        currentById ??= new Map(previous.sessions.map((entry) => [entry.id, entry]))
        prior = currentById.get(session.id)
      }
      if (!prior) {
        sessionsChanged = true
        return session
      }
      const next = reconcileSession(prior, session)
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
      return next
    })
    const sameProject =
      previous.name === project.name && previous.pinned === project.pinned && !sessionsChanged
    const next = sameProject
      ? previous
      : { ...project, sessions: sessionsChanged ? sessions : previous.sessions }
    if (next !== current[projectIndex]) treeChanged = true
    return next
  })

  if (!treeChanged) return current
  if (
    exactSessionChanges &&
    changedLocations.length > 0 &&
    changedLocations.length <= MAX_RETAINED_SESSION_CHANGES
  ) {
    recordSessionChanges(current, projects, changedLocations)
  }
  return projects
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

function reconcileSession(current: Session, snapshot: Session): Session {
  const statusSince =
    current.status === snapshot.status ? current.statusSince : snapshot.statusSince
  const sameLifecycle = lifecycleEqual(current.lifecycle, snapshot.lifecycle)
  if (
    current.title === snapshot.title &&
    current.provider === snapshot.provider &&
    current.agent === snapshot.agent &&
    current.createdAt === snapshot.createdAt &&
    current.status === snapshot.status &&
    current.statusSince === statusSince &&
    sameLifecycle &&
    current.unread === snapshot.unread &&
    current.pinned === snapshot.pinned &&
    current.worktreeBranch === snapshot.worktreeBranch
  ) {
    return current
  }
  const { statusSince: _snapshotStatusSince, ...withoutStatusSince } = snapshot
  return {
    ...withoutStatusSince,
    ...(statusSince === undefined ? {} : { statusSince }),
    lifecycle: sameLifecycle ? current.lifecycle : snapshot.lifecycle,
  }
}

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
