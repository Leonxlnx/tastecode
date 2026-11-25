import type { Project, Session } from './ui/Sidebar.js'

export type ProjectMetadata = Pick<Project, 'path' | 'name'>
export type InboxEntry = { project: ProjectMetadata; session: Session }
export type InboxEntryGroups = {
  active: InboxEntry[]
  snoozed: InboxEntry[]
  settled: InboxEntry[]
  ordered: InboxEntry[]
}

export function projectMetadata(project: ProjectMetadata): ProjectMetadata {
  return { path: project.path, ...(project.name === undefined ? {} : { name: project.name }) }
}

export function newestFirst(a: InboxEntry, b: InboxEntry): number {
  return b.session.createdAt - a.session.createdAt
}

export function wakeAt(session: Session): number {
  return session.lifecycle.state === 'snoozed' ? session.lifecycle.wakeAt : 0
}

export function settledAt(session: Session): number {
  return session.lifecycle.state === 'settled' ? session.lifecycle.settledAt : 0
}

/** One project's matching chats by lifecycle state, in the project's own order. */
export type InboxProjectEntries = {
  active: InboxEntry[]
  snoozed: InboxEntry[]
  settled: InboxEntry[]
}

export function classifyProjectEntries(
  project: Project,
  normalizedQuery: string,
): InboxProjectEntries {
  const active: InboxEntry[] = []
  const snoozed: InboxEntry[] = []
  const settled: InboxEntry[] = []
  for (const session of project.sessions) {
    if (normalizedQuery && !session.title.toLocaleLowerCase().includes(normalizedQuery)) continue
    const entry = { project: projectMetadata(project), session }
    if (session.lifecycle.state === 'active') active.push(entry)
    else if (session.lifecycle.state === 'snoozed') snoozed.push(entry)
    else settled.push(entry)
  }
  return { active, snoozed, settled }
}

/**
 * Groups every chat in scope by lifecycle state and sorts each group.
 * `entriesFor` classifies one project; a caller may return a retained result
 * for a project whose chats did not change. Concatenating the per-project
 * groups in project order gives the same input to the stable sorts as one
 * pass over every chat.
 */
export function classifyInboxEntries(
  projects: Project[],
  scope: string,
  normalizedQuery: string,
  entriesFor: (
    project: Project,
    normalizedQuery: string,
  ) => InboxProjectEntries = classifyProjectEntries,
): InboxEntryGroups {
  const active: InboxEntry[] = []
  const snoozed: InboxEntry[] = []
  const settled: InboxEntry[] = []

  for (const project of projects) {
    if (scope && project.path !== scope) continue
    const entries = entriesFor(project, normalizedQuery)
    for (const entry of entries.active) active.push(entry)
    for (const entry of entries.snoozed) snoozed.push(entry)
    for (const entry of entries.settled) settled.push(entry)
  }

  active.sort(newestFirst)
  snoozed.sort((left, right) => wakeAt(left.session) - wakeAt(right.session))
  settled.sort((left, right) => settledAt(right.session) - settledAt(left.session))
  return { active, snoozed, settled, ordered: [...active, ...snoozed, ...settled] }
}
