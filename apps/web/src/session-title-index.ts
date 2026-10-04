import type { ProviderId } from '@harness/contracts'

export type SessionSearchProject = {
  path: string
  name?: string | undefined
  sessions: Array<{
    id: string
    title: string
    provider: ProviderId
    agent?: string | undefined
    createdAt: number
  }>
}

export type SessionTitleIndexEntry = {
  projectPath: string
  projectName: string
  threadId: string
  threadTitle: string
  normalizedTitle: string
  provider: ProviderId
  agent?: string | undefined
  createdAt: number
}

export function createSessionTitleIndex(
  projects: readonly SessionSearchProject[],
): SessionTitleIndexEntry[] {
  const entries: SessionTitleIndexEntry[] = []
  for (const project of projects) {
    const projectName = project.name ?? basename(project.path)
    for (const session of project.sessions) {
      entries.push({
        projectPath: project.path,
        projectName,
        threadId: session.id,
        threadTitle: session.title,
        normalizedTitle: normalizeSearchText(session.title),
        provider: session.provider,
        ...(session.agent ? { agent: session.agent } : {}),
        createdAt: session.createdAt,
      })
    }
  }
  return entries
}

/**
 * Retains the title index when immutable project updates only change live
 * status fields. Search stays open while chats work, so rebuilding and
 * normalizing every title for those pushes is unnecessary.
 */
export function createSessionTitleIndexer(): (
  projects: readonly SessionSearchProject[],
) => SessionTitleIndexEntry[] {
  let previousProjects: readonly SessionSearchProject[] | undefined
  let previousEntries: SessionTitleIndexEntry[] | undefined

  const rebuild = (projects: readonly SessionSearchProject[]) => {
    previousProjects = projects
    previousEntries = createSessionTitleIndex(projects)
    return previousEntries
  }

  return (projects) => {
    if (!previousProjects || !previousEntries || projects.length !== previousProjects.length) {
      return rebuild(projects)
    }
    if (projects === previousProjects) return previousEntries

    let entries = previousEntries
    let copied = false
    let entryIndex = 0
    for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
      const project = projects[projectIndex]!
      const previousProject = previousProjects[projectIndex]!
      if (
        project.path !== previousProject.path ||
        project.name !== previousProject.name ||
        project.sessions.length !== previousProject.sessions.length
      ) {
        return rebuild(projects)
      }
      if (project !== previousProject) {
        const projectName = project.name ?? basename(project.path)
        for (let sessionIndex = 0; sessionIndex < project.sessions.length; sessionIndex += 1) {
          const session = project.sessions[sessionIndex]!
          const previousSession = previousProject.sessions[sessionIndex]!
          if (session === previousSession) continue
          if (session.id !== previousSession.id) return rebuild(projects)
          if (
            session.title === previousSession.title &&
            session.provider === previousSession.provider &&
            session.agent === previousSession.agent &&
            session.createdAt === previousSession.createdAt
          ) {
            continue
          }
          if (!copied) {
            entries = [...entries]
            copied = true
          }
          entries[entryIndex + sessionIndex] = {
            projectPath: project.path,
            projectName,
            threadId: session.id,
            threadTitle: session.title,
            normalizedTitle: normalizeSearchText(session.title),
            provider: session.provider,
            ...(session.agent ? { agent: session.agent } : {}),
            createdAt: session.createdAt,
          }
        }
      }
      entryIndex += project.sessions.length
    }

    previousProjects = projects
    previousEntries = entries
    return entries
  }
}

export function searchSessionTitles(
  entries: readonly SessionTitleIndexEntry[],
  terms: readonly string[],
  options: {
    projectPath?: string | undefined
    provider?: ProviderId | undefined
    limit?: number | undefined
  } = {},
): SessionTitleIndexEntry[] {
  if (terms.length === 0) return []
  const normalizedQuery = terms.join(' ')
  const limit = options.limit ?? 6
  if (limit <= 0) return []
  const ranked: Array<{ entry: SessionTitleIndexEntry; rank: number }> = []

  for (const entry of entries) {
    if (options.projectPath && entry.projectPath !== options.projectPath) continue
    if (options.provider && entry.provider !== options.provider) continue
    if (!terms.every((part) => entry.normalizedTitle.includes(part))) continue

    const rank =
      entry.normalizedTitle === normalizedQuery
        ? 0
        : entry.normalizedTitle.startsWith(normalizedQuery)
          ? 1
          : 2
    let insertion = 0
    while (insertion < ranked.length) {
      const existing = ranked[insertion]!
      if (
        rank < existing.rank ||
        (rank === existing.rank && entry.createdAt > existing.entry.createdAt)
      ) {
        break
      }
      insertion += 1
    }
    if (insertion >= limit) continue
    ranked.splice(insertion, 0, { entry, rank })
    if (ranked.length > limit) ranked.pop()
  }

  return ranked.map(({ entry }) => entry)
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
