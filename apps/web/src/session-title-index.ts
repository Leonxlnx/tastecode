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

export type SessionTitleSearchOptions = {
  projectPath?: string | undefined
  provider?: ProviderId | undefined
  limit?: number | undefined
}

export function searchSessionTitles(
  entries: readonly SessionTitleIndexEntry[],
  terms: readonly string[],
  options: SessionTitleSearchOptions = {},
): SessionTitleIndexEntry[] {
  return rankSessionTitles(entries, terms, options)
}

/**
 * Searches like `searchSessionTitles`, but scans only the previous query's
 * matches when the new query cannot match anything else: same index, same
 * project and provider filters, and every previous term is contained in a
 * new term (typing one more character, adding a word). A title that contains
 * every new term then contains every previous term, so the previous matches,
 * kept in index order, hold every new match in index order. Entries that do
 * not match are skipped without touching the ranking, so the result, its
 * order and the limit are the same as a scan of the whole index. The full
 * match list is kept, not the limited result. Any other edit scans the index.
 */
export function createSessionTitleSearcher(): typeof searchSessionTitles {
  let previous:
    | {
        entries: readonly SessionTitleIndexEntry[]
        terms: readonly string[]
        projectPath: string | undefined
        provider: ProviderId | undefined
        matches: SessionTitleIndexEntry[]
      }
    | undefined

  return (entries, terms, options = {}) => {
    const projectPath = options.projectPath || undefined
    const provider = options.provider || undefined
    if (terms.length === 0 || (options.limit ?? 6) <= 0) return []
    const narrows =
      previous !== undefined &&
      previous.entries === entries &&
      previous.projectPath === projectPath &&
      previous.provider === provider &&
      previous.terms.every((term) => terms.some((next) => next.includes(term)))
    const matches: SessionTitleIndexEntry[] = []
    const result = rankSessionTitles(narrows ? previous!.matches : entries, terms, options, matches)
    previous = { entries, terms, projectPath, provider, matches }
    return result
  }
}

function rankSessionTitles(
  entries: readonly SessionTitleIndexEntry[],
  terms: readonly string[],
  options: SessionTitleSearchOptions,
  matches?: SessionTitleIndexEntry[],
): SessionTitleIndexEntry[] {
  if (terms.length === 0) return []
  const normalizedQuery = terms.join(' ')
  const limit = options.limit ?? 6
  if (limit <= 0) return []
  // Parallel lists instead of one wrapper object per kept match: when the
  // index runs oldest first, every match briefly enters the top list.
  const ranked: SessionTitleIndexEntry[] = []
  const ranks: number[] = []

  for (const entry of entries) {
    if (options.projectPath && entry.projectPath !== options.projectPath) continue
    if (options.provider && entry.provider !== options.provider) continue
    if (!terms.every((part) => entry.normalizedTitle.includes(part))) continue
    matches?.push(entry)

    const rank =
      entry.normalizedTitle === normalizedQuery
        ? 0
        : entry.normalizedTitle.startsWith(normalizedQuery)
          ? 1
          : 2
    let insertion = 0
    while (insertion < ranked.length) {
      const existingRank = ranks[insertion]!
      if (
        rank < existingRank ||
        (rank === existingRank && entry.createdAt > ranked[insertion]!.createdAt)
      ) {
        break
      }
      insertion += 1
    }
    if (insertion >= limit) continue
    ranked.splice(insertion, 0, entry)
    ranks.splice(insertion, 0, rank)
    if (ranked.length > limit) {
      ranked.pop()
      ranks.pop()
    }
  }

  return ranked
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
