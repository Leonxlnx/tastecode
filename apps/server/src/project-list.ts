import type { ResultOf, ThreadInboxStatus } from '@harness/contracts'
import type { StoredProject, StoredSidebarThread } from './store.js'

type ProjectList = ResultOf<'projects.list'>
type ProjectResult = ProjectList['projects'][number]
type SessionResult = ProjectResult['sessions'][number]

export type ProjectListState = {
  isTurnRunning: (threadId: string) => boolean
  inboxStatus: (threadId: string, queued: boolean, unread: boolean) => ThreadInboxStatus
  revision: () => number
  changesSince?: ((revision: number) => readonly string[] | undefined) | undefined
}

type SessionProjection = {
  running: boolean
  status: ThreadInboxStatus
  value: SessionResult
}

type ProjectProjection = {
  source: StoredProject
  sessions: SessionResult[]
  value: ProjectResult
}

type ProjectGroup = {
  previous: ProjectProjection | undefined
  sessions: SessionResult[]
  unchanged: boolean
}

type ThreadProjectionLocation = {
  thread: StoredSidebarThread
  projectPath: string
  projectIndex: number
  sessionIndex: number
}

/** Retains unchanged response objects and projects only status rows named by the change journal. */
export function createProjectListProjector(options: { includeDefaults?: boolean } = {}) {
  const sessionProjections = new WeakMap<StoredSidebarThread, SessionProjection>()
  let previousProjects = new Map<string, ProjectProjection>()
  let previousResult: ProjectList | undefined
  let previousProjectSource: StoredProject[] | undefined
  let previousThreadSource: readonly StoredSidebarThread[] | undefined
  let previousQueueSource: ReadonlySet<string> | undefined
  let previousStatusRevision = -1
  let previousThreadLocations = new Map<string, ThreadProjectionLocation>()

  return (
    projects: StoredProject[],
    threads: readonly StoredSidebarThread[],
    queuedThreadIds: ReadonlySet<string>,
    state: ProjectListState,
  ): ProjectList => {
    const statusRevision = state.revision()
    const sameProjectSources =
      projects === previousProjectSource && threads === previousThreadSource
    const sameSources = sameProjectSources && queuedThreadIds === previousQueueSource
    if (previousResult && sameSources) {
      if (statusRevision === previousStatusRevision) return previousResult

      const changedThreadIds = state.changesSince?.(previousStatusRevision)
      const incrementalLimit = Math.max(32, Math.floor(threads.length / 4))
      if (changedThreadIds !== undefined && changedThreadIds.length <= incrementalLimit) {
        const changedProjects = new Map<
          string,
          { previous: ProjectProjection; sessions: SessionResult[]; projectIndex: number }
        >()

        for (const threadId of changedThreadIds) {
          const location = previousThreadLocations.get(threadId)
          if (!location) continue
          const previousProject = previousProjects.get(location.projectPath)
          if (!previousProject) continue
          const running = state.isTurnRunning(threadId)
          const status = state.inboxStatus(
            threadId,
            queuedThreadIds.has(threadId),
            location.thread.unread,
          )
          const cached = sessionProjections.get(location.thread)
          const session =
            cached?.running === running && cached.status === status
              ? cached.value
              : projectSession(location.thread, running, status, options.includeDefaults === true)
          if (session !== cached?.value) {
            sessionProjections.set(location.thread, { running, status, value: session })
          }

          let projectChange = changedProjects.get(location.projectPath)
          const previousSession =
            projectChange?.sessions[location.sessionIndex] ??
            previousProject.sessions[location.sessionIndex]
          if (session === previousSession) continue
          if (!projectChange) {
            projectChange = {
              previous: previousProject,
              sessions: [...previousProject.sessions],
              projectIndex: location.projectIndex,
            }
            changedProjects.set(location.projectPath, projectChange)
          }
          projectChange.sessions[location.sessionIndex] = session
        }

        if (changedProjects.size > 0) {
          const projected = [...previousResult.projects]
          const nextProjects = new Map(previousProjects)
          for (const [projectPath, change] of changedProjects) {
            const value = { ...change.previous.value, sessions: change.sessions }
            nextProjects.set(projectPath, {
              source: change.previous.source,
              sessions: change.sessions,
              value,
            })
            projected[change.projectIndex] = value
          }
          previousProjects = nextProjects
          previousResult = { projects: projected }
        }
        previousStatusRevision = statusRevision
        return previousResult
      }
    }

    const groups = new Map<string, ProjectGroup>()
    const rebuildThreadLocations = !sameProjectSources
    const projectIndexes = rebuildThreadLocations ? new Map<string, number>() : undefined
    for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
      const project = projects[projectIndex]!
      projectIndexes?.set(project.path, projectIndex)
      groups.set(project.path, {
        previous: previousProjects.get(project.path),
        sessions: [],
        unchanged: true,
      })
    }

    const threadLocations = rebuildThreadLocations
      ? new Map<string, ThreadProjectionLocation>()
      : previousThreadLocations
    for (const thread of threads) {
      const group = groups.get(thread.projectPath)
      if (!group) continue
      const projectIndex = rebuildThreadLocations
        ? projectIndexes?.get(thread.projectPath)
        : previousThreadLocations.get(thread.id)?.projectIndex
      if (projectIndex === undefined) continue
      const sessionIndex = group.sessions.length
      const running = state.isTurnRunning(thread.id)
      const status = state.inboxStatus(thread.id, queuedThreadIds.has(thread.id), thread.unread)
      const cached = sessionProjections.get(thread)
      const session =
        cached?.running === running && cached.status === status
          ? cached.value
          : projectSession(thread, running, status, options.includeDefaults === true)
      if (session !== cached?.value) {
        sessionProjections.set(thread, { running, status, value: session })
      }
      if (group.previous?.sessions[group.sessions.length] !== session) group.unchanged = false
      group.sessions.push(session)
      if (rebuildThreadLocations) {
        threadLocations.set(thread.id, {
          thread,
          projectPath: thread.projectPath,
          projectIndex,
          sessionIndex,
        })
      }
    }

    const nextProjects = new Map<string, ProjectProjection>()
    const projected: ProjectResult[] = []
    let unchanged = previousResult?.projects.length === projects.length
    for (let index = 0; index < projects.length; index += 1) {
      const project = projects[index]!
      const group = groups.get(project.path)!
      const previous = group.previous
      const sessions =
        group.unchanged && previous?.sessions.length === group.sessions.length
          ? previous.sessions
          : group.sessions
      const value =
        previous?.source === project && previous.sessions === sessions
          ? previous.value
          : { ...project, sessions }
      const projection = { source: project, sessions, value }
      nextProjects.set(project.path, projection)
      projected.push(value)
      unchanged &&= previousResult?.projects[index] === value
    }

    previousProjects = nextProjects
    previousProjectSource = projects
    previousThreadSource = threads
    previousQueueSource = queuedThreadIds
    previousStatusRevision = statusRevision
    previousThreadLocations = threadLocations
    if (unchanged && previousResult) return previousResult
    previousResult = { projects: projected }
    return previousResult
  }
}

function projectSession(
  thread: StoredSidebarThread,
  running: boolean,
  status: ThreadInboxStatus,
  includeDefaults: boolean,
): SessionResult {
  const session: SessionResult = {
    id: thread.id,
    title: thread.title,
    provider: thread.provider,
    ...(thread.agent === undefined ? {} : { agent: thread.agent }),
    createdAt: thread.createdAt,
    running,
  }
  if (includeDefaults || thread.pinned) session.pinned = thread.pinned
  if (includeDefaults || status !== 'idle') session.status = status
  if (includeDefaults || thread.unread) session.unread = thread.unread
  if (
    includeDefaults ||
    thread.lifecycle.state !== 'active' ||
    thread.lifecycle.keepActive ||
    thread.lifecycle.wokeAt !== undefined
  ) {
    session.lifecycle = thread.lifecycle
  }
  if (thread.worktreeBranch !== undefined) session.worktreeBranch = thread.worktreeBranch
  if (thread.closedAt !== undefined) session.closedAt = thread.closedAt
  return session
}
