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
 * The classic rail: pinned chats in their own section, then pinned projects
 * ahead of the rest, each project with working and unread chats lifted above
 * its other chats.
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
    pinnedSessions: prioritizeSessions(pinned, ({ session }) => session),
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
  const { pinned, active } = chatList(projects, readStoredChatOrder(), '')
  return [...pinned, ...active].map(({ session }) => session)
}

/** A chat in the flat list, with the project it belongs to. */
export type ChatEntry = { projectPath: string; session: Session }
export type ChatList = {
  /** Every project, pinned ones first, in the user's order: the filter's choices. */
  projects: Project[]
  pinned: ChatEntry[]
  active: ChatEntry[]
  /** Archived and snoozed chats, the most recently put away first. */
  archived: ChatEntry[]
}

export const CHAT_ORDER_KEY = 'harness.sidebar.chatOrder'
const CHAT_ORDER_SCOPE = '*'

let cachedChatOrderRaw: string | null | undefined
let cachedChatOrder: string[] = []

/** The flat list's saved order, parsed once per stored value. Never throws. */
export function readStoredChatOrder(): readonly string[] {
  let raw: string | null = null
  try {
    raw = globalThis.localStorage?.getItem(CHAT_ORDER_KEY) ?? null
  } catch {
    raw = null
  }
  if (raw === cachedChatOrderRaw) return cachedChatOrder
  cachedChatOrderRaw = raw
  try {
    const value: unknown = JSON.parse(raw ?? '[]')
    cachedChatOrder = isStringArray(value) ? value : []
  } catch {
    cachedChatOrder = []
  }
  return cachedChatOrder
}

export function writeStoredChatOrder(order: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(CHAT_ORDER_KEY, JSON.stringify(order))
  } catch {
    // A blocked store only loses the order after a reload; the list still works.
  }
}

/**
 * The flat sidebar: pinned chats, then every other active chat newest first by
 * creation, then archived ones. A status change, a new message or a read never
 * moves a chat; only a new chat (on top), a pin, a drag or archiving does.
 * `scope` keeps one project's chats in the active and archived lists; pinned
 * chats stay visible whatever the filter says.
 */
export function chatList(
  projects: Project[],
  savedOrder: readonly string[],
  scope: string,
): ChatList {
  const pinnedProjects: Project[] = []
  const otherProjects: Project[] = []
  const pinned: ChatEntry[] = []
  const active: ChatEntry[] = []
  const archived: ChatEntry[] = []
  for (const project of projects) {
    ;(project.pinned ? pinnedProjects : otherProjects).push(project)
    const inScope = scope === '' || project.path === scope
    for (const session of project.sessions) {
      const entry = { projectPath: project.path, session }
      if (session.pinned) pinned.push(entry)
      else if (!inScope) continue
      else if (session.lifecycle.state === 'active') active.push(entry)
      else archived.push(entry)
    }
  }
  const newestFirst = (a: ChatEntry, b: ChatEntry) => b.session.createdAt - a.session.createdAt
  pinned.sort(newestFirst)
  active.sort(newestFirst)
  archived.sort((a, b) => putAwayAt(b.session) - putAwayAt(a.session))
  const order = savedOrder.length > 0 ? { [CHAT_ORDER_SCOPE]: [...savedOrder] } : {}
  const byId = (entries: ChatEntry[]) =>
    applySessionOrder(
      CHAT_ORDER_SCOPE,
      entries.map((entry) => ({ id: entry.session.id, createdAt: entry.session.createdAt, entry })),
      order,
    ).map(({ entry }) => entry)
  return {
    projects: [...pinnedProjects, ...otherProjects],
    pinned: byId(pinned),
    active: byId(active),
    archived,
  }
}

function putAwayAt(session: Session): number {
  const lifecycle = session.lifecycle
  if (lifecycle.state === 'settled') return lifecycle.settledAt
  if (lifecycle.state === 'snoozed') return lifecycle.snoozedAt
  return session.createdAt
}

/**
 * The saved flat order after a drop: the dragged chat lands exactly before or
 * after the chat it was dropped on, and every other chat keeps its place.
 */
export function moveChat(
  shownIds: readonly string[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): string[] {
  if (sourceId === targetId || !shownIds.includes(sourceId)) return [...shownIds]
  const rest = shownIds.filter((id) => id !== sourceId)
  const target = rest.indexOf(targetId)
  if (target < 0) return [...shownIds]
  const index = target + (position === 'after' ? 1 : 0)
  return [...rest.slice(0, index), sourceId, ...rest.slice(index)]
}

/**
 * The saved order after a chat is dropped in the rail. The rail lifts working
 * and unread chats and moves pinned ones to their own section, so the drop is
 * resolved against what it shows: the chat lands exactly where it was dropped
 * among chats of its own rank, and otherwise as close to the drop target as
 * that allows. Every other chat keeps its saved place, so a chat that was only
 * lifted returns to it once it is read or done.
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
  const shown = prioritizeSessions(
    saved.filter((session) => !session.pinned),
    (session) => session,
  )
  const targetIndex = shown.findIndex((session) => session.id === targetId)
  if (targetIndex < 0) return sessions

  const dropIndex = targetIndex + (position === 'after' ? 1 : 0)
  const rank = railRank(source)
  const above = shown.findLast((session, index) => index < dropIndex && railRank(session) === rank)
  const below = shown.find((session, index) => index >= dropIndex && railRank(session) === rank)
  const target = saved.indexOf(shown[targetIndex]!)
  const index = Math.min(
    Math.max(position === 'after' ? target + 1 : target, above ? saved.indexOf(above) + 1 : 0),
    below ? saved.indexOf(below) : saved.length,
  )
  return [...saved.slice(0, index), source, ...saved.slice(index)]
}

const projectSidebarProjections = new WeakMap<Project, ProjectSidebarProjection>()

function projectSidebarProjection(source: Project): ProjectSidebarProjection {
  const cached = projectSidebarProjections.get(source)
  if (cached) return cached

  const pinnedSessions: PinnedSession[] = []
  const unpinnedSessions: Session[] = []
  for (const session of source.sessions) {
    if (session.pinned) pinnedSessions.push({ projectPath: source.path, session })
    else unpinnedSessions.push(session)
  }
  const sessions = prioritizeSessions(unpinnedSessions, (session) => session)
  const sessionsUnchanged =
    pinnedSessions.length === 0 &&
    sessions.length === source.sessions.length &&
    sessions.every((session, index) => session === source.sessions[index])
  const project = sessionsUnchanged ? source : { ...source, sessions }
  const projection = { project, pinnedSessions }
  projectSidebarProjections.set(source, projection)
  return projection
}

function prioritizeSessions<T>(sessions: T[], getSession: (value: T) => Session): T[] {
  const groups: [T[], T[], T[]] = [[], [], []]
  for (const value of sessions) groups[railRank(getSession(value))].push(value)
  const ordered = [...groups[0], ...groups[1], ...groups[2]]
  return ordered.every((value, index) => value === sessions[index]) ? sessions : ordered
}

/** The rail's grouping: working chats first, then unread ones, then the rest. */
function railRank(session: Session): 0 | 1 | 2 {
  if (isActiveStatus(session.status)) return 0
  return session.unread ? 1 : 2
}

function isActiveStatus(status: Session['status']): boolean {
  return (
    status === 'starting' ||
    status === 'working' ||
    status === 'queued' ||
    status === 'approval' ||
    status === 'input'
  )
}
