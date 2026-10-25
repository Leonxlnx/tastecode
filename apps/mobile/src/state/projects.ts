import type { DomainEvent, ResultOf } from '@harness/contracts'
import type { Connection } from '../link/connection'
import { Store } from '../store'

export type Project = ResultOf<'projects.list'>['projects'][number]
export type Session = Project['sessions'][number]

export type ProjectsState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | undefined
  projects: readonly Project[]
  /** When this phone last saw something happen in each chat, for ordering by recency. */
  activity: Readonly<Record<string, number>>
}

/** Events after which the server's status for the chat (working, needs you, ready) changed. */
const STATUS_EVENTS = new Set<DomainEvent['type']>([
  'turn.started',
  'turn.completed',
  'approval.requested',
  'approval.resolved',
  'user_input.requested',
  'user_input.resolved',
  'thread.error',
])

/**
 * Every project and chat on the computer. The server owns the list and its
 * statuses; this re-reads it whenever a push says something changed, which
 * also picks up chats the desktop started.
 */
export class Projects {
  readonly state = new Store<ProjectsState>({
    status: 'idle',
    error: undefined,
    projects: [],
    activity: {},
  })
  #refresh: ReturnType<typeof setTimeout> | undefined
  #reading: Promise<void> | undefined
  #again = false

  constructor(private readonly connection: Connection) {
    connection.onOpen(() => void this.refresh())
    connection.onGap(() => this.refreshSoon())
    connection.on('projects.changed', () => this.refreshSoon())
    connection.on('providerHistory.changed', () => this.refreshSoon())
    connection.on('thread.lifecycle', () => this.refreshSoon())
    connection.on('thread.event', ({ threadId, event }) => {
      this.#touch(threadId)
      if (STATUS_EVENTS.has(event.type)) this.refreshSoon()
    })
  }

  refresh(): Promise<void> {
    if (this.#reading) {
      this.#again = true
      return this.#reading
    }
    this.#reading = this.#read().finally(() => {
      this.#reading = undefined
      if (this.#again) {
        this.#again = false
        void this.refresh()
      }
    })
    return this.#reading
  }

  refreshSoon(delay = 250): void {
    clearTimeout(this.#refresh)
    this.#refresh = setTimeout(() => void this.refresh(), delay)
  }

  async #read(): Promise<void> {
    if (this.state.get().status !== 'ready') {
      this.state.set((current) => ({ ...current, status: 'loading' }))
    }
    try {
      const { projects } = await this.connection.request('projects.list', {})
      this.state.set((current) => ({ ...current, status: 'ready', error: undefined, projects }))
    } catch (error) {
      this.state.set((current) => ({
        ...current,
        status: current.status === 'ready' ? 'ready' : 'error',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  #touch(threadId: string): void {
    const now = Date.now()
    const previous = this.state.get().activity[threadId] ?? 0
    // A streaming reply touches the chat hundreds of times; a few seconds is fine-grained enough.
    if (now - previous < 5_000) return
    this.state.set((current) => ({
      ...current,
      activity: { ...current.activity, [threadId]: now },
    }))
  }

  /** Marks a chat this phone acted on, so it moves to the top at once. */
  touch(threadId: string): void {
    this.state.set((current) => ({
      ...current,
      activity: { ...current.activity, [threadId]: Date.now() },
    }))
  }

  async add(path: string): Promise<Project | undefined> {
    const added = await this.connection.request('projects.add', { path })
    await this.refresh()
    return this.state.get().projects.find((project) => project.path === added.path)
  }

  pinChat(threadId: string, pinned: boolean): Promise<void> {
    return this.#change(threadId, { pinned }, () =>
      this.connection.request('thread.pin', { threadId, pinned }),
    )
  }

  archiveChat(threadId: string): Promise<void> {
    const lifecycle = { state: 'settled', settledAt: Date.now(), reason: 'manual' } as const
    return this.#change(threadId, { lifecycle }, () =>
      this.connection.request('thread.settle', { threadId }),
    )
  }

  restoreChat(threadId: string): Promise<void> {
    const lifecycle = { state: 'active', keepActive: false } as const
    return this.#change(threadId, { lifecycle }, () =>
      this.connection.request('thread.unsettle', { threadId }),
    )
  }

  renameChat(threadId: string, title: string): Promise<void> {
    return this.#change(threadId, { title }, () =>
      this.connection.request('thread.rename', { threadId, title }),
    )
  }

  /**
   * Shows a change to one chat at once, then asks the computer for it. The
   * read after it brings back the computer's version, which also undoes the
   * change when the request failed.
   */
  async #change(threadId: string, patch: Partial<Session>, request: () => Promise<unknown>) {
    this.state.set((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.sessions.some((session) => session.id === threadId)
          ? {
              ...project,
              sessions: project.sessions.map((session) =>
                session.id === threadId ? { ...session, ...patch } : session,
              ),
            }
          : project,
      ),
    }))
    try {
      await request()
    } finally {
      await this.refresh()
    }
  }
}

export function findSession(
  projects: readonly Project[],
  threadId: string,
): { project: Project; session: Session } | undefined {
  for (const project of projects) {
    const session = project.sessions.find((candidate) => candidate.id === threadId)
    if (session) return { project, session }
  }
  return undefined
}

export function lastActivity(session: Session, activity: Readonly<Record<string, number>>): number {
  return Math.max(
    activity[session.id] ?? 0,
    session.lastActiveAt ?? 0,
    session.lifecycle?.state === 'active' && session.lifecycle.wokeAt
      ? session.lifecycle.wokeAt
      : 0,
    session.createdAt,
  )
}

export function isArchived(session: Session): boolean {
  return session.lifecycle?.state === 'settled'
}

export function needsYou(session: Session): boolean {
  return session.status === 'approval' || session.status === 'input'
}

export function isWorking(session: Session): boolean {
  return session.running || session.status === 'working' || session.status === 'starting'
}
