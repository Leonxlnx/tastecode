import type { ProviderId, ResultOf } from '@harness/contracts'
import type { Transport } from '../transport.js'

/**
 * What the composer's `/`, `$` and `@` menus list, kept per connection,
 * provider, project and (for commands) chat. A menu shows the last answer at
 * once and asks again behind it, so reopening a menu, another chat of the same
 * project or a second composer never starts empty. Requests for the same list
 * share one answer instead of sending another.
 */
export type InventorySource = 'skills' | 'mcp' | 'commands'
export type InventoryAnswers = {
  skills: ResultOf<'skills.list'>
  mcp: ResultOf<'mcp.list'>
  commands: ResultOf<'commands.list'>
}
export type InventoryPlace = {
  provider: ProviderId
  projectPath: string
  /** Only commands differ per chat: its own session may know more of them. */
  threadId?: string | undefined
}

type Entry = {
  value?: unknown
  pending?: Promise<unknown> | undefined
}

/** Enough for every place someone switches between in a session. */
const MAX_ENTRIES = 96
const caches = new WeakMap<Transport, Map<string, Entry>>()

function cache(transport: Transport): Map<string, Entry> {
  let entries = caches.get(transport)
  if (!entries) {
    entries = new Map()
    caches.set(transport, entries)
  }
  return entries
}

function key(source: InventorySource, place: InventoryPlace): string {
  const thread = source === 'commands' ? (place.threadId ?? '') : ''
  return `${source}\u0000${place.provider}\u0000${place.projectPath}\u0000${thread}`
}

/** The last answer for this place, however old. */
export function cachedInventory<S extends InventorySource>(
  transport: Transport,
  source: S,
  place: InventoryPlace,
): InventoryAnswers[S] | undefined {
  return cache(transport).get(key(source, place))?.value as InventoryAnswers[S] | undefined
}

/**
 * Asks the server, or joins the request already on its way. A failure keeps
 * the last answer, so a menu still shows it.
 */
export function loadInventory<S extends InventorySource>(
  transport: Transport,
  source: S,
  place: InventoryPlace,
): Promise<InventoryAnswers[S]> {
  const entries = cache(transport)
  const id = key(source, place)
  const existing = entries.get(id)
  if (existing?.pending) return existing.pending as Promise<InventoryAnswers[S]>
  const entry: Entry = existing ?? {}
  const pending = Promise.resolve()
    .then(() => request(transport, source, place))
    .then(
      (value) => {
        if (entry.pending === pending) {
          entry.value = value
          entry.pending = undefined
        }
        return value
      },
      (error: unknown) => {
        if (entry.pending === pending) entry.pending = undefined
        throw error
      },
    )
  entry.pending = pending
  // Map order is the eviction order: the most recently used goes last.
  entries.delete(id)
  entries.set(id, entry)
  for (const old of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break
    entries.delete(old)
  }
  return pending as Promise<InventoryAnswers[S]>
}

/**
 * A change push or a reconnect: the answers stay to show until the next one,
 * but an answer on its way may predate the change, so the next request does
 * not join it.
 */
export function inventoryChanged(
  transport: Transport,
  sources: readonly InventorySource[],
  place?: Pick<InventoryPlace, 'provider' | 'projectPath'>,
): void {
  const prefix = place ? `\u0000${place.provider}\u0000${place.projectPath}\u0000` : undefined
  for (const [id, entry] of cache(transport)) {
    const source = id.slice(0, id.indexOf('\u0000')) as InventorySource
    if (!sources.includes(source)) continue
    if (prefix && !id.slice(source.length).startsWith(prefix)) continue
    entry.pending = undefined
  }
}

function request<S extends InventorySource>(
  transport: Transport,
  source: S,
  place: InventoryPlace,
): Promise<InventoryAnswers[S]> {
  const params = { provider: place.provider, projectPath: place.projectPath }
  if (source === 'skills')
    return transport.request('skills.list', params) as Promise<InventoryAnswers[S]>
  if (source === 'mcp') return transport.request('mcp.list', params) as Promise<InventoryAnswers[S]>
  return transport
    .request('commands.list', {
      ...params,
      ...(place.threadId ? { threadId: place.threadId } : {}),
    })
    .catch((error: unknown) => {
      // A server from before provider commands has none to offer.
      if (isUnknownMethod(error)) return { commands: [], loading: false }
      throw error
    }) as Promise<InventoryAnswers[S]>
}

function isUnknownMethod(error: unknown): boolean {
  return error instanceof Error && /^unknown method\b/i.test(error.message)
}
