import { classifyInboxEntries } from './inbox-order.js'
import type { Project, Session } from './ui/Sidebar.js'

export type SessionOrder = Record<string, string[]>
export type PinnedSession = { projectPath: string; session: Session }
type ProjectSidebarProjection = {
  project: Project
  pinnedSessions: PinnedSession[]
  archivedSessions: PinnedSession[]
}
export type SidebarRail = {
  orderedProjects: Project[]
  pinnedSessions: PinnedSession[]
  /** Chats without a project, by group like a project's, newest first in each. */
  chatSessions: PinnedSession[]
  /** Archived chats of every project, the most recently archived first. */
  archivedSessions: PinnedSession[]
}
/** Why a chat is waiting for the user: a request it cannot pass, or a failure not yet read. */
export type Attention = 'approval' | 'input' | 'failed'
export type NeedsYouEntry = PinnedSession & { attention: Attention }
export type ProjectAttention = { count: number; attention: Attention }

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
 * The rail: pinned chats in their own section, then the chats without a
 * project, then pinned projects ahead of the rest, then archived chats at the
 * end. Every list keeps its saved order,
 * except that a project's chats are listed by group (sessionGroup): what is
 * done first, then what needs the user, what is working, and the rest. A
 * finished turn also lifts its chat to the top of its group (liftSession).
 * `heldSessionId`, the open chat that was done, stays with the done chats
 * until another chat opens, so reading it does not move it from under the user.
 */
export function sidebarRail(projects: Project[], heldSessionId?: string): SidebarRail {
  const pinned: PinnedSession[] = []
  const archived: PinnedSession[] = []
  const chats: PinnedSession[] = []
  const pinnedProjects: Project[] = []
  const unpinnedProjects: Project[] = []
  for (const source of projects) {
    const projection = projectSidebarProjection(source, heldSessionId)
    pinned.push(...projection.pinnedSessions)
    archived.push(...projection.archivedSessions)
    if (source.chat) {
      for (const session of projection.project.sessions) {
        chats.push({ projectPath: source.path, session })
      }
    } else if (source.pinned) pinnedProjects.push(projection.project)
    else unpinnedProjects.push(projection.project)
  }
  return {
    orderedProjects: [...pinnedProjects, ...unpinnedProjects],
    pinnedSessions: pinned,
    chatSessions: groupChats(chats, heldSessionId),
    archivedSessions: archived.sort((a, b) => archivedAt(b.session) - archivedAt(a.session)),
  }
}

function groupChats(chats: PinnedSession[], heldSessionId?: string): PinnedSession[] {
  if (chats.length < 2) return chats
  const newestFirst = [...chats].sort((a, b) => b.session.createdAt - a.session.createdAt)
  const byId = new Map(newestFirst.map((chat) => [chat.session.id, chat]))
  return groupSessions(
    newestFirst.map(({ session }) => session),
    heldSessionId,
  ).map((session) => byId.get(session.id)!)
}

/**
 * Chats the user archived leave the tree. The server also settles chats on its
 * own (Inbox's idle-days rule); this sidebar leaves those where they are. A
 * pinned chat stays pinned, archived or not.
 */
export function isArchived(session: Session): boolean {
  return session.lifecycle.state === 'settled' && session.lifecycle.reason === 'manual'
}

function archivedAt(session: Session): number {
  return session.lifecycle.state === 'settled' ? session.lifecycle.settledAt : 0
}

/**
 * Every chat in the order the sidebar lists it, from the top, without the
 * folded Archived section. The inbox's project filter and search box are not
 * applied, so every chat is reachable.
 */
export function sidebarSessions(
  projects: Project[],
  mode: 'classic' | 'inbox',
  heldSessionId?: string,
): Session[] {
  if (mode === 'inbox') {
    return classifyInboxEntries(projects, '', '').ordered.map(({ session }) => session)
  }
  const { orderedProjects, pinnedSessions, chatSessions } = sidebarRail(projects, heldSessionId)
  return [
    ...pinnedSessions.map(({ session }) => session),
    ...chatSessions.map(({ session }) => session),
    ...orderedProjects.flatMap((project) => project.sessions),
  ]
}

/**
 * A chat whose turn just ended goes to the top of the saved order, so it leads
 * whichever group it lands in: done when unread, read when it was open.
 */
export function liftSession<P extends { sessions: readonly { id: string }[] }>(
  projects: P[],
  sessionId: string,
): P[] {
  for (const [projectIndex, project] of projects.entries()) {
    const index = project.sessions.findIndex((session) => session.id === sessionId)
    if (index < 0) continue
    if (index === 0) return projects
    const sessions = [
      project.sessions[index]!,
      ...project.sessions.slice(0, index),
      ...project.sessions.slice(index + 1),
    ]
    const next = [...projects]
    next[projectIndex] = { ...project, sessions }
    return next
  }
  return projects
}

/**
 * A project's saved order with its tree chats put in the order the rail shows
 * them, each in a slot a tree chat had, so pinned and archived chats keep
 * theirs. A drop is placed in this order, so a chat lands where it was dropped.
 */
export function railSessionOrder(sessions: Session[], heldSessionId?: string): Session[] {
  const slots: number[] = []
  const tree: Session[] = []
  for (const [index, session] of sessions.entries()) {
    if (!inProjectTree(session)) continue
    slots.push(index)
    tree.push(session)
  }
  const grouped = groupSessions(tree, heldSessionId)
  if (grouped === tree) return sessions
  const result = [...sessions]
  for (const [index, slot] of slots.entries()) result[slot] = grouped[index]!
  return result
}

/**
 * The saved order after a chat is dropped in the rail: it lands exactly where
 * it was dropped. Pinned and archived chats live in their own sections, so a
 * drop on one of them cannot be placed in the project and is ignored.
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
  return !session.pinned && !isArchived(session)
}

const projectSidebarProjections = new WeakMap<
  Project,
  { held: string | undefined; projection: ProjectSidebarProjection }
>()

function projectSidebarProjection(
  source: Project,
  heldSessionId?: string,
): ProjectSidebarProjection {
  const held =
    heldSessionId !== undefined && source.sessions.some(({ id }) => id === heldSessionId)
      ? heldSessionId
      : undefined
  const cached = projectSidebarProjections.get(source)
  if (cached && cached.held === held) return cached.projection

  const pinnedSessions: PinnedSession[] = []
  const archivedSessions: PinnedSession[] = []
  const sessions: Session[] = []
  for (const session of source.sessions) {
    if (session.pinned) pinnedSessions.push({ projectPath: source.path, session })
    else if (isArchived(session)) archivedSessions.push({ projectPath: source.path, session })
    else sessions.push(session)
  }
  const grouped = groupSessions(sessions, held)
  const project =
    grouped === source.sessions ||
    (grouped === sessions && sessions.length === source.sessions.length)
      ? source
      : { ...source, sessions: grouped }
  const projection = { project, pinnedSessions, archivedSessions }
  projectSidebarProjections.set(source, { held, projection })
  return projection
}

/** Where a chat is listed in its project, from the top. */
export type SessionGroup = 'done' | 'attention' | 'working' | 'read'

const SESSION_GROUPS: readonly SessionGroup[] = ['done', 'attention', 'working', 'read']

/**
 * A finished turn nobody has read is done; an approval, a question or an
 * unread failure needs the user; a turn running or queued is working; the
 * rest has been read and is idle.
 */
export function sessionGroup(session: Session): SessionGroup {
  if (sessionAttention(session)) return 'attention'
  if (session.status === 'starting' || session.status === 'working' || session.status === 'queued')
    return 'working'
  return session.unread ? 'done' : 'read'
}

function groupRank(session: Session, heldSessionId: string | undefined): number {
  const group = sessionGroup(session)
  return SESSION_GROUPS.indexOf(group === 'read' && session.id === heldSessionId ? 'done' : group)
}

/** The chats by group, each group in the saved order. Already grouped: the same array. */
function groupSessions(sessions: Session[], heldSessionId?: string): Session[] {
  const ranks = sessions.map((session) => groupRank(session, heldSessionId))
  if (ranks.every((rank, index) => index === 0 || ranks[index - 1]! <= rank)) return sessions
  return sessions
    .map((session, index) => ({ session, rank: ranks[index]! }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ session }) => session)
}

/**
 * What a chat is waiting for, if anything. An approval or a question blocks
 * the agent until it is answered. A failed turn waits only until it is read,
 * so opening the chat clears it. A finished answer does not need the user:
 * the tree lists it unread, with a heavier title, among the done chats.
 */
export function sessionAttention(session: Session): Attention | undefined {
  if (session.status === 'approval') return 'approval'
  if (session.status === 'input') return 'input'
  if (session.status === 'failed' && session.unread && !isArchived(session)) return 'failed'
  return undefined
}

/**
 * The chats a project lists while it is folded to `limit` rows. Every chat that
 * is working, needs the user, is unread or is open is listed, past the limit if
 * there are more of them; the rows left over go to the first quiet chats. Each
 * keeps its place in the order, so nothing moves and the fold never hides news.
 */
export function foldedProjectSessions(
  sessions: readonly Session[],
  activeSessionId: string | undefined,
  limit: number,
): Session[] {
  const inSight = (session: Session) => session.id === activeSessionId || hasNews(session)
  let quietRows = limit
  for (const session of sessions) if (inSight(session)) quietRows -= 1
  const listed: Session[] = []
  for (const session of sessions) {
    if (inSight(session)) {
      listed.push(session)
    } else if (quietRows > 0) {
      listed.push(session)
      quietRows -= 1
    }
  }
  return listed
}

/** A queued prompt with no turn behind it is not running, so it does not count. */
function hasNews(session: Session): boolean {
  return (
    session.status === 'starting' ||
    session.status === 'working' ||
    session.unread ||
    sessionAttention(session) !== undefined
  )
}

const projectNeedsYou = new WeakMap<Project, NeedsYouEntry[]>()

function projectEntries(project: Project): NeedsYouEntry[] {
  const cached = projectNeedsYou.get(project)
  if (cached) return cached
  const entries: NeedsYouEntry[] = []
  for (const session of project.sessions) {
    const attention = sessionAttention(session)
    if (attention) entries.push({ projectPath: project.path, session, attention })
  }
  projectNeedsYou.set(project, entries)
  return entries
}

/**
 * The chats waiting for the user. Agents blocked on an approval or a question
 * come first, then failures nobody has read; within each, the longest wait
 * first, so a new arrival joins the end of its group. The open chat is left
 * out: it is already in front of the user, and opening a failure is what
 * reads it.
 */
export function needsYouSessions(
  projects: readonly Project[],
  activeSessionId: string | undefined,
): NeedsYouEntry[] {
  const entries: NeedsYouEntry[] = []
  for (const project of projects) {
    for (const entry of projectEntries(project)) {
      if (entry.session.id !== activeSessionId) entries.push(entry)
    }
  }
  return entries.sort(
    (a, b) =>
      Number(isBlocking(b.attention)) - Number(isBlocking(a.attention)) ||
      waitingSince(a.session) - waitingSince(b.session),
  )
}

function isBlocking(attention: Attention): boolean {
  return attention === 'approval' || attention === 'input'
}

function waitingSince(session: Session): number {
  return session.statusSince ?? session.createdAt
}

const ATTENTION_ORDER: readonly Attention[] = ['approval', 'input', 'failed']

/** How many chats in a project need the user, and the most urgent reason. */
export function projectAttention(project: Project): ProjectAttention | undefined {
  const entries = projectEntries(project)
  if (entries.length === 0) return undefined
  let attention: Attention = 'failed'
  for (const entry of entries) {
    if (ATTENTION_ORDER.indexOf(entry.attention) < ATTENTION_ORDER.indexOf(attention)) {
      attention = entry.attention
    }
  }
  return { count: entries.length, attention }
}
