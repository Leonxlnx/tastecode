export type SessionOrder = Record<string, string[]>

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

export function applySessionOrder<T extends { id: string }>(
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
  return [...byId.values(), ...known]
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
