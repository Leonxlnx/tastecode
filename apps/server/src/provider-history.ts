import { createHash } from 'node:crypto'
import path from 'node:path'
import type {
  DomainEvent,
  Item,
  ProviderHistorySession,
  ProviderHistorySource,
  ProviderId,
} from '@harness/contracts'
import { Store } from './store.js'
import { projectHistoryItems } from './side-chat.js'

type Source = { provider: ProviderId; history: ProviderHistorySource }
type Imported = {
  provider: ProviderId
  threadId: string
  session: ProviderHistorySession
  loadedRevision: string | null
}

/** Metadata is refreshed in the background; transcripts are read only when opened. */
export class ProviderHistory {
  #entries = new Map<string, Imported>()
  #byThread = new Map<string, Imported>()
  #refreshing: Promise<void> | undefined
  #reading = new Map<string, Promise<boolean>>()
  #closed = false

  constructor(
    private store: Store,
    private sources: Source[],
    private hooks: {
      isBusy(threadId: string): boolean
      canImport?(): boolean
      changed(threadIds: string[]): void
      log(message: string): void
    },
  ) {
    for (const entry of store.providerHistories()) this.#remember(entry)
  }

  #remember(entry: Imported): void {
    const previous = this.#entries.get(`${entry.provider}:${entry.session.id}`)
    if (previous && previous.threadId !== entry.threadId) this.#byThread.delete(previous.threadId)
    this.#entries.set(`${entry.provider}:${entry.session.id}`, entry)
    this.#byThread.set(entry.threadId, entry)
  }

  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    return (this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined
    }))
  }

  async #refresh(): Promise<void> {
    await Promise.all(
      this.sources.map(async ({ provider, history }) => {
        try {
          const sessions = await history.list()
          if (this.#closed || this.hooks.canImport?.() === false) return
          // Starting a provider and scanning its saved sessions can overlap. Resolve
          // ownership only after the scan, preferring native tasks over imported copies.
          const nativeThreads = new Map(
            this.store.nativeProviderThreads(provider).map((thread) => {
              const id = thread.providerSessionId ?? thread.id
              return [history.resolveSessionId?.(id) ?? id, thread]
            }),
          )
          const changed: string[] = []
          const imported: Imported[] = []
          const repair = new Set<string>()
          this.store.batchLifecycleUpdates(() => {
            for (const session of sessions) {
              if (
                !session.id ||
                !path.isAbsolute(session.workspacePath) ||
                !this.store.project(session.workspacePath) ||
                !Number.isFinite(session.createdAt)
              )
                continue
              const key = `${provider}:${session.id}`
              const previous = this.#entries.get(key)
              const native = nativeThreads.get(session.id)
              const duplicateId = `external:${provider}:${session.id}`
              const duplicate = native && this.store.thread(duplicateId)
              if (
                duplicate &&
                (this.hooks.isBusy(duplicateId) || this.store.queuedTurns(duplicateId).length)
              )
                continue
              const repairing = Boolean(
                duplicate &&
                (!previous ||
                  previous.threadId !== native?.id ||
                  previous.loadedRevision !== session.revision ||
                  this.store.localHistory(duplicateId).length === 0),
              )
              // Retain a tombstone when a user deletes the local copy.
              if (previous && !native && !this.store.thread(previous.threadId)) continue
              if (
                !repairing &&
                (!native || native.id === previous?.threadId) &&
                previous?.session.revision === session.revision &&
                previous.session.title === session.title
              )
                continue
              const existing =
                native ?? (previous ? this.store.thread(previous.threadId) : undefined)
              if (existing?.ephemeral) continue
              const threadId = existing?.id ?? `external:${provider}:${session.id}`
              if (!existing) {
                this.store.addProviderThread(threadId, provider, session)
              } else if (
                previous?.threadId === threadId &&
                existing.title === previous.session.title &&
                session.title
              ) {
                this.store.renameThread(threadId, session.title)
              }
              const entry = {
                provider,
                threadId,
                session,
                loadedRevision:
                  !repairing && previous?.threadId === threadId ? previous.loadedRevision : null,
              }
              this.store.saveProviderHistory(provider, threadId, session)
              imported.push(entry)
              changed.push(threadId)
              if (repairing) repair.add(threadId)
            }
          })
          for (const entry of imported) this.#remember(entry)
          if (changed.length) this.hooks.changed(changed)
          for (const threadId of repair) await this.load(threadId)
        } catch {
          // Never log source content or paths from a malformed provider record.
          this.hooks.log(`${provider} history could not be refreshed; will retry`)
        }
      }),
    )
  }

  async load(threadId: string): Promise<boolean> {
    if (this.#closed || this.hooks.isBusy(threadId)) return false
    const pending = this.#reading.get(threadId)
    if (pending) return pending
    let entry = this.#byThread.get(threadId)
    if (!entry || !this.store.thread(threadId) || entry.loadedRevision === entry.session.revision)
      return false
    const provider = entry.provider
    const source = this.sources.find((source) => source.provider === provider)
    if (!source) return false
    const reading = (async () => {
      let changed = false
      while (entry && entry.loadedRevision !== entry.session.revision) {
        const current = entry
        const events = await source.history.read(current.session)
        if (
          this.#closed ||
          this.hooks.isBusy(threadId) ||
          !this.store.thread(threadId) ||
          !this.#byThread.has(threadId)
        )
          return changed
        const duplicateId = `external:${provider}:${current.session.id}`
        if (
          duplicateId !== threadId &&
          (this.hooks.isBusy(duplicateId) || this.store.queuedTurns(duplicateId).length)
        )
          return changed
        if (events.length === 0) throw new Error('Saved provider chat is unavailable; try again')
        const local = this.store.localHistory(threadId).map(({ event }) => event)
        const entries = importedEvents(events, threadId, local)
        changed =
          this.store.mergeProviderHistory(threadId, current.session.revision, entries) || changed
        current.loadedRevision = current.session.revision
        if (
          duplicateId !== threadId &&
          this.store.thread(duplicateId) &&
          !this.hooks.isBusy(duplicateId) &&
          !this.store.queuedTurns(duplicateId).length
        ) {
          const duplicateLocal = this.store.localHistory(duplicateId).map(({ event }) => event)
          // Only remove a read-only mirror after its real outside turns have been
          // imported successfully. Replies written in the duplicate remain intact.
          if (duplicateLocal.length === 0 && !this.store.thread(duplicateId)?.worktreePath) {
            this.store.deleteThread(duplicateId)
          } else {
            this.store.mergeProviderHistory(
              duplicateId,
              current.session.revision,
              importedEvents(events, duplicateId, [...local, ...duplicateLocal]),
            )
          }
          this.hooks.changed([threadId, duplicateId])
        }
        entry = this.#byThread.get(threadId)
      }
      return changed
    })().finally(() => {
      this.#reading.delete(threadId)
    })
    this.#reading.set(threadId, reading)
    return reading
  }

  async close(): Promise<void> {
    this.#closed = true
    await Promise.allSettled([this.#refreshing, ...this.#reading.values()])
    await Promise.allSettled(this.sources.map(({ history }) => history.dispose?.()))
  }
}

function turnId(event: DomainEvent): string | undefined {
  if (event.type === 'turn.started') return event.turn.id
  if (event.type === 'item.started' || event.type === 'item.completed') return event.item.turnId
  return 'turnId' in event ? event.turnId : undefined
}

export function importedEvents(
  events: DomainEvent[],
  threadId: string,
  local: DomainEvent[],
): Array<{ key: string; event: DomainEvent }> {
  const finalItems = new Map(
    projectHistoryItems(events.map((event, seq) => ({ seq, event }))).map((item) => [
      item.id,
      item,
    ]),
  )
  const seenItems = new Set<string>()
  events = events.flatMap((event): DomainEvent[] => {
    const id =
      event.type === 'item.started' || event.type === 'item.completed'
        ? event.item.id
        : event.type === 'item.delta'
          ? event.itemId
          : undefined
    if (!id) return [event]
    if (seenItems.has(id)) return []
    seenItems.add(id)
    const item = finalItems.get(id)
    return item ? [{ type: 'item.completed', item }] : []
  })
  const localTurns = new Set(
    local.flatMap((event) => (event.type === 'turn.started' ? [event.turn.id] : [])),
  )
  const users = local.flatMap((event) =>
    (event.type === 'item.completed' || event.type === 'item.started') && event.item.role === 'user'
      ? [event.item]
      : [],
  )
  const echoed = new Set<string>()
  for (const event of events) {
    const id = turnId(event)
    if (!id) continue
    if (localTurns.has(id)) echoed.add(id)
  }
  const candidates = events
    .flatMap((event) => {
      if (
        (event.type !== 'item.completed' && event.type !== 'item.started') ||
        event.item.role !== 'user' ||
        echoed.has(event.item.turnId)
      )
        return []
      return users
        .filter((item) => !echoed.has(item.turnId) && sameUserMessage(item, event.item))
        .map((item) => ({
          local: item.turnId,
          native: event.item.turnId,
          distance: Math.abs(item.createdAt - event.item.createdAt),
        }))
    })
    .sort((a, b) => a.distance - b.distance)
  const matched = new Set<string>()
  for (const candidate of candidates) {
    if (matched.has(candidate.local) || echoed.has(candidate.native)) continue
    matched.add(candidate.local)
    echoed.add(candidate.native)
  }
  const result = new Map<string, DomainEvent>()
  const usageCounts = new Map<string, number>()
  let currentTurn = ''
  for (const event of events) {
    const id = turnId(event)
    if (id) currentTurn = id
    if (echoed.has(id ?? currentTurn) && event.type !== 'thread.started') continue
    // Historical permission requests must never become actionable approvals.
    if (
      event.type.startsWith('approval.') ||
      event.type.startsWith('user_input.') ||
      event.type === 'thread.error'
    )
      continue
    let mapped: DomainEvent = event
    if (event.type === 'thread.started')
      mapped = { ...event, thread: { ...event.thread, id: threadId } }
    else if (event.type === 'turn.started')
      mapped = { ...event, turn: { ...event.turn, id: `import:${event.turn.id}`, threadId } }
    else if (event.type === 'item.completed' || event.type === 'item.started')
      mapped = {
        type: 'item.completed',
        item: {
          ...event.item,
          id: `import:${event.item.id}`,
          turnId: `import:${event.item.turnId}`,
        },
      }
    else if (event.type === 'item.delta')
      mapped = { ...event, turnId: `import:${event.turnId}`, itemId: `import:${event.itemId}` }
    else if ('turnId' in event) mapped = { ...event, turnId: `import:${event.turnId}` }
    const key =
      mapped.type === 'usage.updated'
        ? `usage:${currentTurn}:${usageCounts.get(currentTurn) ?? 0}`
        : mapped.type === 'thread.started'
          ? 'thread'
          : mapped.type === 'turn.started'
            ? `start:${mapped.turn.id}`
            : mapped.type === 'item.completed' || mapped.type === 'item.started'
              ? `item:${mapped.item.id}`
              : 'turnId' in mapped
                ? `${mapped.type}:${mapped.turnId}`
                : `${mapped.type}:${createHash('sha256').update(JSON.stringify(mapped)).digest('hex')}`
    result.set(key, mapped)
    if (mapped.type === 'usage.updated')
      usageCounts.set(currentTurn, (usageCounts.get(currentTurn) ?? 0) + 1)
  }
  return [...result].map(([key, event]) => ({ key, event }))
}

function sameUserMessage(left: Item, right: Item): boolean {
  return (
    left.text === right.text &&
    Math.abs(left.createdAt - right.createdAt) < 60_000 &&
    JSON.stringify(left.attachments ?? []) === JSON.stringify(right.attachments ?? [])
  )
}
