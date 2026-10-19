import { classifyInboxEntries } from './inbox-order.js'
import type { Project, Session } from './ui/Sidebar.js'

export type SessionOrder = Record<string, string[]>
export type PinnedSession = { projectPath: string; session: Session }
type ProjectSidebarProjection = { project: Project; pinnedSessions: PinnedSession[] }
export type SidebarRail = { orderedProjects: Project[]; pinnedSessions: PinnedSession[] }

let cachedProjectOrderRaw: string | null | undefined
let cachedProjectOrder: string[] = []
let cachedSessionOrderRaw: string | null | undefined
let cachedSessionOrder: SessionOrder = {}

export function parseStoredProjectOrder(raw: string | null): string[] {
  if (raw === cachedProjectOrderRaw) return cachedProjectOrder
  cachedProjectOrderRaw = raw
  try {
    const value: unknown = JSON.parse(raw ?? '[]')
    cachedProjectOrder = isStringArray(value) ? value : []
  } catch {
    cachedProjectOrder = []
  }
  return cachedProjectOrder
}

export function parseStoredSessionOrder(raw: string | null): SessionOrder {
  if (raw === cachedSessionOrderRaw) return cachedSessionOrder
  cachedSessionOrderRaw = raw
  try {
    const value: unknown = JSON.parse(raw ?? '{}')
    cachedSessionOrder = isSessionOrder(value) ? value : {}
  } catch {
    cachedSessionOrder = {}
  }
  return cachedSessionOrder
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isSessionOrder(value: unknown): value is SessionOrder {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isStringArray)
  )
}

export function applyProjectOrder<T extends { path: string }>(
  projects: T[],
  order: readonly string[],
): T[] {
  if (order.length === 0 || sameIds(order, projects, (project) => project.path)) return projects
  const byPath = new Map(projects.map((project) => [project.path, project]))
  const known: T[] = []
  for (const path of order) {
    const project = byPath.get(path)
    if (!project) continue
    known.push(project)
    byPath.delete(path)
  }
  return [...byPath.values(), ...known]
}

/**
 * Chats missing from the saved order arrive newest first from the server. Each
 * goes ahead of the first saved chat it is not older than, so history imported
 * after the order was saved lands by date instead of above every saved chat.
 */
export function applySessionOrder<T extends { id: string; createdAt?: number }>(
  projectPath: string,
  sessions: T[],
  savedOrder: SessionOrder,
): T[] {
  const order = savedOrder[projectPath] ?? []
  if (order.length === 0 || sameIds(order, sessions, (session) => session.id)) return sessions
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const known: T[] = []
  for (const id of order) {
    const session = byId.get(id)
    if (!session) continue
    known.push(session)
    byId.delete(id)
  }
  const unknown = [...byId.values()]
  const result: T[] = []
  let next = 0
  for (const session of known) {
    while (next < unknown.length && !olderThan(unknown[next]!, session))
      result.push(unknown[next++]!)
    result.push(session)
  }
  while (next < unknown.length) result.push(unknown[next++]!)
  return result
}

/** Without both dates a new chat stays ahead of the saved ones. */
function olderThan(session: { createdAt?: number }, saved: { createdAt?: number }): boolean {
  return (
    session.createdAt !== undefined &&
    saved.createdAt !== undefined &&
    session.createdAt < saved.createdAt
  )
}

function sameIds<T>(
  order: readonly string[],
  values: readonly T[],
  id: (value: T) => string,
): boolean {
  if (order.length !== values.length) return false
  for (let index = 0; index < values.length; index += 1) {
    if (order[index] !== id(values[index]!)) return false
  }
  return true
}

/**
 * The rail: pinned chats in their own section, then pinned projects ahead of
 * the rest. Every list keeps its saved order. A chat that starts, waits,
 * finishes or is read stays where it is; only a new chat, a pin, a drag or
 * archiving moves one. A chat the user archived leaves its project's list for
 * the project's folded Archived row; one the server settled for inactivity
 * stays where it is, because nothing the user did moved it.
 */
export function sidebarRail(projects: Project[]): SidebarRail {
  const pinned: PinnedSession[] = []
  const pinnedProjects: Project[] = []
  const unpinnedProjects: Project[] = []
  for (const source of projects) {
    const projection = projectSidebarProjection(source)
    pinned.push(...projection.pinnedSessions)
    if (source.pinned) pinnedProjects.push(projection.project)
    else unpinnedProjects.push(projection.project)
  }
  return {
    orderedProjects: [...pinnedProjects, ...unpinnedProjects],
    pinnedSessions: pinned,
  }
}

/**
 * Every chat in the order the sidebar lists it, from the top. The inbox's
 * project filter and search box are not applied, so every chat is reachable.
 */
export function sidebarSessions(projects: Project[], mode: 'classic' | 'inbox'): Session[] {
  if (mode === 'inbox') {
    return classifyInboxEntries(projects, '', '').ordered.map(({ session }) => session)
  }
  const { orderedProjects, pinnedSessions } = sidebarRail(projects)
  return [
    ...pinnedSessions.map(({ session }) => session),
    ...orderedProjects.flatMap((project) => project.sessions),
  ]
}

/**
 * The saved order after a chat is dropped in the rail: it lands exactly where
 * it was dropped. Pinned chats live in their own section, so a drop on one of
 * them cannot be placed in the project and is ignored.
 */
export function moveRailSession(
  sessions: Session[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): Session[] {
  const source = sessions.find((session) => session.id === sourceId)
  if (!source || sourceId === targetId) return sessions
  const saved = sessions.filter((session) => session !== source)
  const target = saved.findIndex((session) => session.id === targetId)
  if (target < 0 || !inProjectTree(saved[target]!)) return sessions
  const index = target + (position === 'after' ? 1 : 0)
  return [...saved.slice(0, index), source, ...saved.slice(index)]
}

function inProjectTree(session: Session): boolean {
  return !session.pinned && !archivedByUser(session)
}

/** Archived from the sidebar or settled in Inbox: the user put it away. */
export function archivedByUser(session: Session): boolean {
  return session.lifecycle.state === 'settled' && session.lifecycle.reason === 'manual'
}

const projectSidebarProjections = new WeakMap<Project, ProjectSidebarProjection>()

function projectSidebarProjection(source: Project): ProjectSidebarProjection {
  const cached = projectSidebarProjections.get(source)
  if (cached) return cached

  const pinnedSessions: PinnedSession[] = []
  const sessions: Session[] = []
  const archived: Session[] = []
  for (const session of source.sessions) {
    if (session.pinned) pinnedSessions.push({ projectPath: source.path, session })
    else if (archivedByUser(session)) archived.push(session)
    else sessions.push(session)
  }
  const project =
    pinnedSessions.length === 0 && archived.length === 0
      ? source
      : { ...source, sessions, ...(archived.length > 0 ? { archived } : {}) }
  const projection = { project, pinnedSessions }
  projectSidebarProjections.set(source, projection)
  return projection
}
