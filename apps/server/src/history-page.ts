import { createHash } from 'node:crypto'
import type { DomainEvent } from '@harness/contracts'

type HistoryEntry = { seq: number; event: DomainEvent }

/** Newest whole turns sent when a client asks for a page without a size. */
export const DEFAULT_HISTORY_PAGE_TURNS = 10

export type HistoryPageCursor = { seq: number; turnHash: string }

export type HistoryPage = {
  events: HistoryEntry[]
  page: { olderCursor: string | null; snapshotSeq: number }
  reset?: true
}

/** A cursor this server never issued for the requested thread. */
export class InvalidHistoryCursorError extends Error {
  constructor() {
    super('invalid history cursor')
  }
}

type Block = { start: number; turns: number; firstTurn: string | undefined }

/**
 * Cursors name the turn that starts the oldest loaded block, hashed so a long
 * provider id cannot exceed the protocol's cursor length. The snapshot seq
 * lets a later read notice a rewrite that happened after the cursor was issued.
 */
export function encodeHistoryCursor(threadId: string, cursor: HistoryPageCursor): string {
  const value = { v: 1, t: shortHash(threadId), s: cursor.seq, k: cursor.turnHash }
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function decodeHistoryCursor(threadId: string, value: string): HistoryPageCursor {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidHistoryCursorError()
  }
  if (typeof decoded !== 'object' || decoded === null) throw new InvalidHistoryCursorError()
  const cursor = decoded as Record<string, unknown>
  if (
    cursor['v'] !== 1 ||
    cursor['t'] !== shortHash(threadId) ||
    typeof cursor['s'] !== 'number' ||
    !Number.isSafeInteger(cursor['s']) ||
    cursor['s'] < 0 ||
    typeof cursor['k'] !== 'string' ||
    cursor['k'].length === 0
  ) {
    throw new InvalidHistoryCursorError()
  }
  return { seq: cursor['s'], turnHash: cursor['k'] }
}

/**
 * Cut one bounded page from a compact replay. Pages hold whole blocks: a block
 * ends only where every turn inside it has emitted its last event, so a user
 * prompt recorded before its provider's turn start, a late tool completion or
 * an interleaved provider turn never lands on the other side of a cursor.
 * The newest page also carries the thread-level state that older blocks still
 * own: the latest usage and requests nobody has answered yet.
 */
export function readHistoryPage(
  threadId: string,
  entries: readonly HistoryEntry[],
  request: {
    before?: HistoryPageCursor | undefined
    turnLimit?: number | undefined
    isStale?: ((cursor: HistoryPageCursor, snapshotSeq: number) => boolean) | undefined
  },
): HistoryPage {
  const snapshotSeq = entries.at(-1)?.seq ?? 0
  const turnLimit = Math.max(1, request.turnLimit ?? DEFAULT_HISTORY_PAGE_TURNS)
  const blocks = historyBlocks(entries)
  let end = blocks.length
  if (request.before) {
    const cursor = request.before
    const found =
      request.isStale?.(cursor, snapshotSeq) === true
        ? -1
        : blocks.findIndex(
            (block) =>
              block.firstTurn !== undefined && shortHash(block.firstTurn) === cursor.turnHash,
          )
    if (found < 0) return { ...readHistoryPage(threadId, entries, { turnLimit }), reset: true }
    end = found
  }

  const cursor = (first: number) => {
    const turn = first > 0 ? blocks[first]?.firstTurn : undefined
    return turn === undefined
      ? null
      : encodeHistoryCursor(threadId, { seq: snapshotSeq, turnHash: shortHash(turn) })
  }
  if (end === 0) return { events: [], page: { olderCursor: null, snapshotSeq } }

  let first = end
  let turns = 0
  do {
    first -= 1
    turns += blocks[first]!.turns
  } while (first > 0 && turns < turnLimit)
  const start = blocks[first]!.start
  const stop = end < blocks.length ? blocks[end]!.start : entries.length
  const page = entries.slice(start, stop)
  const events = request.before ? page : [...carriedState(entries, start), ...page]
  return { events, page: { olderCursor: cursor(first), snapshotSeq } }
}

function historyBlocks(entries: readonly HistoryEntry[]): Block[] {
  const lastIndex = new Map<string, number>()
  for (let index = 0; index < entries.length; index += 1) {
    const turn = turnKey(entries[index]!.event)
    if (turn !== undefined) lastIndex.set(turn, index)
  }

  const blocks: Block[] = []
  const seen = new Set<string>()
  let block: Block = { start: 0, turns: 0, firstTurn: undefined }
  let reach = -1
  for (let index = 0; index < entries.length; index += 1) {
    const turn = turnKey(entries[index]!.event)
    if (turn === undefined) continue
    // Every turn in the current block has finished: this turn starts the next.
    if (block.turns > 0 && index > reach) {
      blocks.push(block)
      block = { start: index, turns: 0, firstTurn: undefined }
    }
    if (!seen.has(turn)) {
      seen.add(turn)
      block.turns += 1
      block.firstTurn ??= turn
    }
    reach = Math.max(reach, lastIndex.get(turn)!)
  }
  if (entries.length > 0) blocks.push(block)
  return blocks
}

function turnKey(event: DomainEvent): string | undefined {
  switch (event.type) {
    case 'turn.started':
      return event.turn.id || undefined
    case 'item.started':
    case 'item.completed':
      return event.item.turnId || undefined
    case 'item.delta':
    case 'turn.completed':
    case 'plan.updated':
    case 'diff.updated':
      return event.turnId || undefined
    case 'user_input.requested':
      return event.request.turnId
    case 'approval.review.started':
    case 'approval.review.completed':
      return event.review.turnId || undefined
    default:
      return undefined
  }
}

/** Replays the renderer's thread-level rules for the rows before a page. */
function carriedState(entries: readonly HistoryEntry[], end: number): HistoryEntry[] {
  let usage: number | undefined
  const approvals = new Map<string, number>()
  const userInputs = new Map<string, number>()
  for (let index = 0; index < end; index += 1) {
    const event = entries[index]!.event
    if (event.type === 'usage.updated') usage = index
    else if (event.type === 'approval.requested') approvals.set(event.request.id, index)
    else if (event.type === 'approval.resolved') approvals.delete(event.id)
    else if (event.type === 'turn.completed') approvals.clear()
    else if (event.type === 'user_input.requested') userInputs.set(event.request.id, index)
    else if (event.type === 'user_input.resolved') userInputs.delete(event.id)
    else if (event.type === 'thread.error') {
      // A failed thread can no longer answer anything it was asked.
      approvals.clear()
      userInputs.clear()
    }
  }
  const carried = [...approvals.values(), ...userInputs.values()]
  if (usage !== undefined) carried.push(usage)
  return carried.sort((left, right) => left - right).map((index) => entries[index]!)
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 16)
}
