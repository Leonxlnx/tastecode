export type WorkspaceActivitySession = {
  id: string
  running: boolean
  status?: string | undefined
}

export type WorkspaceProjectActivity = {
  running: boolean
  queued: boolean
  unknown: boolean
  needsResync: boolean
}

export type WorkspaceSessionLocation<TSession> = {
  path: string
  session: TSession
}

const QUEUE_INDEX_MIN_CHECKS = 16
const QUEUE_INDEX_MIN_COMPARISONS = 512

/**
 * Build a queue id index only after repeated linear scans become more expensive.
 * Normal queues stay allocation-free.
 */
export function indexQueueItemIdsForChecks(
  items: readonly { id: string }[],
  expectedChecks: number,
): ReadonlySet<string> | undefined {
  if (
    expectedChecks < QUEUE_INDEX_MIN_CHECKS ||
    items.length * expectedChecks < QUEUE_INDEX_MIN_COMPARISONS
  )
    return undefined
  return new Set(items.map((item) => item.id))
}

/** A Map keyed by row id with a second index for rows owned by one thread. */
export class ThreadOwnedMap<TValue extends { threadId: string }> implements Iterable<
  [string, TValue]
> {
  readonly #entries = new Map<string, TValue>()
  readonly #idsByThread = new Map<string, Set<string>>()

  get size(): number {
    return this.#entries.size
  }

  countForThread(threadId: string): number {
    return this.#idsByThread.get(threadId)?.size ?? 0
  }

  get(id: string): TValue | undefined {
    return this.#entries.get(id)
  }

  has(id: string): boolean {
    return this.#entries.has(id)
  }

  set(id: string, value: TValue): this {
    const previous = this.#entries.get(id)
    if (previous?.threadId !== value.threadId) {
      if (previous) this.#removeOwner(previous.threadId, id)
      let ids = this.#idsByThread.get(value.threadId)
      if (!ids) {
        ids = new Set()
        this.#idsByThread.set(value.threadId, ids)
      }
      ids.add(id)
    }
    this.#entries.set(id, value)
    return this
  }

  delete(id: string): boolean {
    const value = this.#entries.get(id)
    if (!value) return false
    this.#entries.delete(id)
    this.#removeOwner(value.threadId, id)
    return true
  }

  values(): MapIterator<TValue> {
    return this.#entries.values()
  }

  [Symbol.iterator](): MapIterator<[string, TValue]> {
    return this.#entries.entries()
  }

  *entriesForThread(threadId: string): IterableIterator<[string, TValue]> {
    for (const id of this.#idsByThread.get(threadId) ?? []) {
      const value = this.#entries.get(id)
      if (value) yield [id, value]
    }
  }

  #removeOwner(threadId: string, id: string): void {
    const ids = this.#idsByThread.get(threadId)
    if (!ids) return
    ids.delete(id)
    if (ids.size === 0) this.#idsByThread.delete(threadId)
  }
}

/** Index one fresh project snapshot for all reconnect lookups. */
export function indexWorkspaceSessions<TSession extends { id: string }>(
  projects: readonly { path: string; sessions: readonly TSession[] }[],
): Map<string, WorkspaceSessionLocation<TSession>> {
  const sessions = new Map<string, WorkspaceSessionLocation<TSession>>()
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!sessions.has(session.id)) sessions.set(session.id, { path: project.path, session })
    }
  }
  return sessions
}

export function hasWorkspaceStartForPath(
  starts: Iterable<{ path: string }>,
  path: string | undefined,
): boolean {
  if (path === undefined) return false
  for (const start of starts) if (start.path === path) return true
  return false
}

/** Classify every source of project work in one pass over its sessions. */
export function workspaceProjectActivity(
  sessions: readonly WorkspaceActivitySession[],
  queueStates: ReadonlyMap<string, { items: readonly unknown[] }>,
  unknownQueues: ReadonlySet<string>,
  queueActions: Iterable<{ threadId: string; pending: number }>,
): WorkspaceProjectActivity {
  let running = false
  let queued = false
  let unknown = false

  for (const session of sessions) {
    running ||= session.running
    queued ||= session.status === 'queued' || (queueStates.get(session.id)?.items.length ?? 0) > 0
    unknown ||= unknownQueues.has(session.id)
  }

  let needsResync = unknown
  let sessionIds: Set<string> | undefined
  for (const action of queueActions) {
    if (!sessionIds) {
      sessionIds = new Set()
      for (const session of sessions) sessionIds.add(session.id)
    }
    if (!sessionIds.has(action.threadId)) continue
    queued = true
    needsResync ||= action.pending === 0
  }

  return { running, queued, unknown, needsResync }
}
