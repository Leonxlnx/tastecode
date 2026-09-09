import type { DomainEvent, Item, Usage } from '@harness/contracts'
import { EMPTY_LIVE_ITEMS, type LiveItemUpdate, type ThreadState } from './thread-state.js'

export { emptyThread } from './thread-state.js'
export type { LiveItemUpdate, ThreadState } from './thread-state.js'

/**
 * Folds the domain event stream into what the UI renders.
 *
 * The rule that matters for M1: a completed item is immutable. Only the item
 * currently streaming changes identity, so everything above it can be memoised
 * hard once virtualisation lands.
 */
const itemIndexes = new WeakMap<readonly Item[], Map<string, number>>()
const itemIndexOwners = new WeakMap<Map<string, number>, readonly Item[]>()
const LIVE_ITEM_OVERLAY_MIN_SIZE = 64
const LIVE_ITEM_OVERLAY_MAX_DEPTH = 16
const liveItemTransitions = new WeakMap<
  ReadonlyMap<number, LiveItemUpdate>,
  { previous: ReadonlyMap<number, LiveItemUpdate>; indices: readonly number[] }
>()

export type ItemDeltaEvent = Extract<DomainEvent, { type: 'item.delta' }>

/**
 * Keeps large live-item snapshots immutable without copying every unchanged
 * entry for each rendered provider frame. Iteration is uncommon and
 * materializes the bounded chain once; indexed row reads stay bounded.
 */
class LiveItemOverlay implements ReadonlyMap<number, LiveItemUpdate> {
  readonly size: number
  readonly depth: number

  constructor(
    private readonly previous: ReadonlyMap<number, LiveItemUpdate>,
    private readonly updates: ReadonlyMap<number, LiveItemUpdate>,
  ) {
    let added = 0
    for (const index of updates.keys()) {
      if (!previous.has(index)) added += 1
    }
    this.size = previous.size + added
    this.depth = previous instanceof LiveItemOverlay ? previous.depth + 1 : 1
  }

  get(index: number): LiveItemUpdate | undefined {
    return this.updates.get(index) ?? this.previous.get(index)
  }

  has(index: number): boolean {
    return this.updates.has(index) || this.previous.has(index)
  }

  materialize(): Map<number, LiveItemUpdate> {
    const items = new Map<number, LiveItemUpdate>()
    this.materializeInto(items)
    return items
  }

  private materializeInto(items: Map<number, LiveItemUpdate>): void {
    if (this.previous instanceof LiveItemOverlay) this.previous.materializeInto(items)
    else for (const [index, update] of this.previous) items.set(index, update)
    for (const [index, update] of this.updates) items.set(index, update)
  }

  entries(): MapIterator<[number, LiveItemUpdate]> {
    return this.materialize().entries()
  }

  keys(): MapIterator<number> {
    return this.materialize().keys()
  }

  values(): MapIterator<LiveItemUpdate> {
    return this.materialize().values()
  }

  forEach(
    callback: (
      value: LiveItemUpdate,
      key: number,
      map: ReadonlyMap<number, LiveItemUpdate>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [index, update] of this) callback.call(thisArg, update, index, this)
  }

  [Symbol.iterator](): MapIterator<[number, LiveItemUpdate]> {
    return this.entries()
  }
}

function applyLiveItemUpdates(
  previous: ReadonlyMap<number, LiveItemUpdate>,
  updates: ReadonlyMap<number, LiveItemUpdate>,
): ReadonlyMap<number, LiveItemUpdate> {
  let next: ReadonlyMap<number, LiveItemUpdate>
  if (previous.size === 0) {
    next = updates
  } else if (previous.size < LIVE_ITEM_OVERLAY_MIN_SIZE) {
    const copied = new Map(previous)
    for (const [index, update] of updates) copied.set(index, update)
    next = copied
  } else if (previous instanceof LiveItemOverlay && previous.depth >= LIVE_ITEM_OVERLAY_MAX_DEPTH) {
    const materialized = previous.materialize()
    for (const [index, update] of updates) materialized.set(index, update)
    next = materialized
  } else {
    next = new LiveItemOverlay(previous, updates)
  }
  if (next.size >= LIVE_ITEM_OVERLAY_MIN_SIZE) {
    liveItemTransitions.set(next, { previous, indices: [...updates.keys()] })
  }
  return next
}

/** Exact live rows changed by one sequential reducer transition, when known. */
export function changedLiveItemIndices(
  previous: ReadonlyMap<number, LiveItemUpdate>,
  next: ReadonlyMap<number, LiveItemUpdate>,
): readonly number[] | undefined {
  const transition = liveItemTransitions.get(next)
  return transition?.previous === previous ? transition.indices : undefined
}

export function threadItemAt(
  items: readonly Item[],
  liveItems: ReadonlyMap<number, LiveItemUpdate>,
  index: number,
): Item | undefined {
  return liveItems.get(index)?.item ?? items[index]
}

/** Read one transcript row without scanning the full history. */
export function threadItemById(state: ThreadState, itemId: string): Item | undefined {
  const index = itemIndex(state.items, itemId)
  return index < 0 ? undefined : threadItemAt(state.items, state.liveItems, index)
}

function materializeItems(state: ThreadState): Item[] {
  if (state.liveItems.size === 0) return state.items
  return copyMaterializedItems(state)
}

function copyMaterializedItems(state: ThreadState): Item[] {
  const items = state.items.slice()
  for (const [index, update] of state.liveItems) items[index] = update.item
  retainItemIndex(state.items, items)
  return items
}

function buildItemIndex(items: readonly Item[]): Map<string, number> {
  const index = new Map<string, number>()
  for (let position = 0; position < items.length; position += 1) {
    const id = items[position]?.id
    if (id !== undefined && !index.has(id)) index.set(id, position)
  }
  itemIndexes.set(items, index)
  itemIndexOwners.set(index, items)
  return index
}

function itemIndex(items: readonly Item[], itemId: string): number {
  let index = itemIndexes.get(items)
  if (!index) return buildItemIndex(items).get(itemId) ?? -1
  const position = index.get(itemId)
  if (position === undefined) return -1
  if (items[position]?.id === itemId) return position

  // A stale branch can share an internal index with a newer immutable array.
  // Rebuild that rare branch once instead of returning its sibling's row.
  index = buildItemIndex(items)
  return index.get(itemId) ?? -1
}

/** Release a derived lookup table while its transcript is inactive. */
export function releaseThreadItemIndex(items: readonly Item[]): void {
  itemIndexes.delete(items)
}

function retainItemIndex(source: readonly Item[], target: readonly Item[]): void {
  const index = itemIndexes.get(source)
  if (!index) return
  itemIndexes.set(target, index)
  itemIndexOwners.set(index, target)
}

function recordAppendedItem(items: readonly Item[], item: Item): void {
  let index = itemIndexes.get(items)
  if (!index) return
  if (itemIndexOwners.get(index) !== items) index = buildItemIndex(items)
  if (!index.has(item.id)) index.set(item.id, items.length - 1)
  itemIndexes.set(items, index)
  itemIndexOwners.set(index, items)
}

export function threadItems(state: ThreadState): Item[] {
  return materializeItems(state)
}

function settleLiveItems(state: ThreadState): ThreadState {
  return state.liveItems.size === 0
    ? state
    : { ...state, items: materializeItems(state), liveItems: EMPTY_LIVE_ITEMS }
}

/**
 * Marks a locally-echoed message that the agent has not confirmed yet. The
 * user's own text must appear the instant they hit send — waiting for a round
 * trip feels broken — but it has to be reconciled when the real item arrives.
 */
const OPTIMISTIC_PREFIX = 'local:'
const LEGACY_DESIGN_APPROVAL_WARNING =
  'Heads up: this agent cannot ask for permission mid-run, so Ask-first may block its file writes during the build. Auto or Full approval works better for Design mode.'
let localIdSequence = 0

/**
 * randomUUID is restricted to secure contexts. These ids only identify
 * renderer-local rows, so a timestamp and counter are a safe fallback when a
 * browser deliberately withholds that API.
 */
function localId(prefix = ''): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `${prefix}${uuid ?? `${Date.now().toString(36)}-${localIdSequence++}`}`
}

export function createOptimisticMessageId(): string {
  return localId(OPTIMISTIC_PREFIX)
}

function createThreadErrorItem(message: string): Item {
  return {
    id: localId('error:'),
    turnId: '',
    type: 'error',
    status: 'completed',
    text: message,
    createdAt: Date.now(),
  }
}

function settleThreadError(state: ThreadState, items: Item[]): ThreadState {
  return {
    ...state,
    running: false,
    activeTurn: undefined,
    approvals: [],
    userInputs: [],
    items,
  }
}

export function reduce(state: ThreadState, event: DomainEvent): ThreadState {
  switch (event.type) {
    case 'turn.started': {
      // A new turn gets a fresh plan and diff; the previous ones described work
      // already finished, and leaving them up reads as stale instructions.
      const current = settleLiveItems(state)
      const startedAt = current.turnTiming[event.turn.id]?.startedAt ?? event.turn.createdAt
      return {
        ...current,
        running: true,
        liveStart: current.items.length,
        activeTurn: {
          id: event.turn.id,
          startedAt,
        },
        turnTiming: {
          ...current.turnTiming,
          [event.turn.id]: { ...current.turnTiming[event.turn.id], startedAt },
        },
        plan: [],
        diff: undefined,
        diffTurnId: undefined,
      }
    }

    case 'turn.completed': {
      // Approvals the turn never answered are unanswerable now (the adapters
      // resolve them server-side too; this covers logs written before that
      // fix). userInputs stay: design-briefing questions legitimately outlive
      // their turn and are answered to start the next one.
      const current = settleLiveItems(state)
      const timing = current.turnTiming[event.turnId]
      return {
        ...current,
        running: false,
        liveStart: current.items.length,
        activeTurn: undefined,
        approvals: [],
        turnTiming:
          event.completedAt === undefined
            ? current.turnTiming
            : {
                ...current.turnTiming,
                [event.turnId]: {
                  ...timing,
                  completedAt: timing?.completedAt ?? event.completedAt,
                },
              },
      }
    }

    case 'plan.updated':
      return { ...state, plan: event.steps }

    case 'usage.updated':
      return { ...state, usage: withoutIncompatibleContextWindow(event.usage) }

    case 'diff.updated':
      return { ...state, diff: event.diff, diffTurnId: event.turnId }

    case 'approval.requested':
      // Codex is blocked waiting on this. Queued rather than replacing, since
      // a turn can have more than one outstanding at a time.
      return { ...state, approvals: [...state.approvals, event.request] }

    case 'approval.resolved':
      return { ...state, approvals: state.approvals.filter((a) => a.id !== event.id) }

    case 'user_input.requested':
      return { ...state, userInputs: [...state.userInputs, event.request] }

    case 'user_input.resolved':
      return { ...state, userInputs: state.userInputs.filter((request) => request.id !== event.id) }

    case 'approval.review.started':
    case 'approval.review.completed':
      return { ...state, reviews: { ...state.reviews, [event.review.id]: event.review } }

    case 'item.started': {
      // An early delta or exact optimistic submission may already own this id;
      // fill it in rather than inferring identity from repeated prompt text.
      const existingIndex = itemIndex(state.items, event.item.id)
      const existing = threadItemAt(state.items, state.liveItems, existingIndex)
      if (existingIndex < 0) {
        const items = copyMaterializedItems(state)
        items.push(event.item)
        recordAppendedItem(items, event.item)
        return { ...state, items, liveItems: EMPTY_LIVE_ITEMS }
      }
      if (!existing) return state
      const optimistic = existing.id.startsWith(OPTIMISTIC_PREFIX) && existing.turnId === ''
      // Completion is terminal. A buffered or retried start may arrive after
      // restored history and must never resurrect finished canonical work.
      if (!optimistic && existing.status !== 'started') return settleLiveItems(state)
      const items = copyMaterializedItems(state)
      items[existingIndex] = {
        ...event.item,
        ...(!event.item.text && existing.text ? { text: existing.text } : {}),
      }
      return { ...state, items, liveItems: EMPTY_LIVE_ITEMS }
    }

    case 'item.delta':
      return reduceDeltas(state, [event])

    case 'item.completed': {
      if (event.item.text === LEGACY_DESIGN_APPROVAL_WARNING) return settleLiveItems(state)
      const index = itemIndex(state.items, event.item.id)
      const items = copyMaterializedItems(state)
      if (index === -1) {
        items.push(event.item)
        recordAppendedItem(items, event.item)
        return { ...state, items, liveItems: EMPTY_LIVE_ITEMS }
      }
      // Keep streamed text when the completed payload carries none, so a
      // finished message never blanks out what the user just watched arrive.
      const streamed = threadItemAt(state.items, state.liveItems, index)?.text
      items[index] = {
        ...event.item,
        ...(!event.item.text ? { text: streamed } : {}),
      }
      return { ...state, items, liveItems: EMPTY_LIVE_ITEMS }
    }

    case 'thread.error': {
      const items = copyMaterializedItems(state)
      const error = createThreadErrorItem(event.message)
      items.push(error)
      recordAppendedItem(items, error)
      return settleThreadError({ ...state, liveItems: EMPTY_LIVE_ITEMS }, items)
    }

    default:
      return state
  }
}

function withoutIncompatibleContextWindow(usage: Usage): Usage {
  const hasAccountingBreakdown =
    usage.inputTokens !== 0 ||
    usage.cachedInputTokens !== 0 ||
    usage.outputTokens !== 0 ||
    usage.reasoningTokens !== 0
  if (usage.contextWindow === undefined) return usage
  const impossibleOccupancy = usage.totalTokens > usage.contextWindow
  if (!impossibleOccupancy && (usage.cumulative !== true || !hasAccountingBreakdown)) return usage

  // Cumulative category totals measure accounting, not current context.
  // Older Codex events did not carry the cumulative marker, but an amount
  // larger than the model window is still unambiguously accounting data.
  const { contextWindow: _contextWindow, ...accounting } = usage
  return accounting
}

/**
 * Applies one rendered frame of text deltas with one item-array copy and one
 * item replacement per target. The single-event reducer stays authoritative;
 * this is its equivalent fast path for live frames and persisted replay, where
 * providers commonly emit many tiny chunks between structural events.
 */
export function reduceDeltas(state: ThreadState, deltas: ItemDeltaEvent[]): ThreadState {
  if (deltas.length === 0) return state

  const first = deltas[0]!
  let singleItemText = first.textDelta
  let singleItem = true
  for (let index = 1; index < deltas.length; index += 1) {
    const event = deltas[index]!
    if (event.itemId !== first.itemId || event.turnId !== first.turnId) {
      singleItem = false
      break
    }
    singleItemText += event.textDelta
  }
  if (singleItem) {
    return reduceSingleItemDeltas(state, first.itemId, first.turnId, singleItemText)
  }

  const chunksByItem = new Map<string, { chunks: string[]; itemId: string; turnId: string }>()
  for (const event of deltas) {
    const key = JSON.stringify([event.itemId, event.turnId])
    const entry = chunksByItem.get(key)
    if (entry) entry.chunks.push(event.textDelta)
    else {
      chunksByItem.set(key, {
        chunks: [event.textDelta],
        itemId: event.itemId,
        turnId: event.turnId,
      })
    }
  }

  let items = state.items
  let liveItems: ReadonlyMap<number, LiveItemUpdate> = state.liveItems
  let liveItemUpdates: Map<number, LiveItemUpdate> | undefined
  let writableItems = false
  let liveStart = state.liveStart
  let changed = false
  for (const { chunks, itemId, turnId } of chunksByItem.values()) {
    const index = liveItemIndex(items, liveItems, liveStart, itemId)
    const textDelta = chunks.length === 1 ? chunks[0]! : chunks.join('')
    if (index < 0) {
      if (state.activeTurn && turnId !== state.activeTurn.id) continue
      if (liveItemUpdates) {
        liveItems = applyLiveItemUpdates(liveItems, liveItemUpdates)
        liveItemUpdates = undefined
      }
      if (liveItems.size > 0) {
        if (!writableItems) {
          const materialized = items.slice()
          retainItemIndex(items, materialized)
          items = materialized
          writableItems = true
        }
        for (const [liveIndex, update] of liveItems) items[liveIndex] = update.item
        liveItems = EMPTY_LIVE_ITEMS
      }
      if (!state.running) liveStart = items.length
      if (!writableItems) {
        const copied = items.slice()
        retainItemIndex(items, copied)
        items = copied
        writableItems = true
      }
      const item: Item = {
        id: itemId,
        turnId: state.activeTurn?.id ?? '',
        type: 'message',
        status: 'started',
        role: 'assistant',
        text: textDelta,
        createdAt: Date.now(),
      }
      items.push(item)
      recordAppendedItem(items, item)
      changed = true
      continue
    }

    const existing = liveItemUpdates?.get(index)?.item ?? threadItemAt(items, liveItems, index)
    if (existing?.status === 'started') {
      liveItemUpdates ??= new Map()
      liveItemUpdates.set(index, {
        item: { ...existing, text: (existing.text ?? '') + textDelta },
        version: state.itemVersion + 1,
        textUpdate: { kind: 'append', text: textDelta },
      })
      changed = true
    }
  }

  if (liveItemUpdates) liveItems = applyLiveItemUpdates(liveItems, liveItemUpdates)

  return changed
    ? {
        ...state,
        items,
        liveItems,
        liveStart,
        itemVersion: state.itemVersion + 1,
      }
    : state
}

function reduceSingleItemDeltas(
  state: ThreadState,
  itemId: string,
  turnId: string,
  textDelta: string,
): ThreadState {
  const index = liveItemIndex(state.items, state.liveItems, state.liveStart, itemId)

  if (index < 0) {
    if (state.activeTurn && turnId !== state.activeTurn.id) return state
    const items = copyMaterializedItems(state)
    const liveStart = state.running ? state.liveStart : items.length
    const item: Item = {
      id: itemId,
      turnId: state.activeTurn?.id ?? '',
      type: 'message',
      status: 'started',
      role: 'assistant',
      text: textDelta,
      createdAt: Date.now(),
    }
    items.push(item)
    recordAppendedItem(items, item)
    return {
      ...state,
      items,
      liveItems: EMPTY_LIVE_ITEMS,
      liveStart,
      itemVersion: state.itemVersion + 1,
    }
  }

  const existing = threadItemAt(state.items, state.liveItems, index)
  if (existing?.status !== 'started') return state
  const update = {
    item: { ...existing, text: (existing.text ?? '') + textDelta },
    version: state.itemVersion + 1,
    textUpdate: { kind: 'append' as const, text: textDelta },
  }
  let liveItems: ReadonlyMap<number, LiveItemUpdate>
  if (state.liveItems.size < LIVE_ITEM_OVERLAY_MIN_SIZE) {
    const copied = new Map(state.liveItems)
    copied.set(index, update)
    liveItems = copied
  } else {
    liveItems = applyLiveItemUpdates(state.liveItems, new Map([[index, update]]))
  }
  return { ...state, liveItems, itemVersion: state.itemVersion + 1 }
}

function liveItemIndex(
  items: readonly Item[],
  liveItems: ReadonlyMap<number, LiveItemUpdate>,
  liveStart: number,
  itemId: string,
): number {
  const last = items.length - 1
  if (last >= liveStart && threadItemAt(items, liveItems, last)?.id === itemId) return last

  const cachedIndex = itemIndexes.get(items)?.get(itemId)
  if (
    cachedIndex !== undefined &&
    cachedIndex >= liveStart &&
    threadItemAt(items, liveItems, cachedIndex)?.id === itemId
  ) {
    return cachedIndex
  }
  for (let candidate = last - 1; candidate >= liveStart; candidate -= 1) {
    if (threadItemAt(items, liveItems, candidate)?.id === itemId) return candidate
  }
  return -1
}

/**
 * Owns the one mutable item array used while rebuilding a persisted log.
 * Nothing can observe this private copy before reduceEventLog returns, so
 * indexing and replacing rows here preserves the public immutable state
 * contract without copying the growing transcript for every stored event.
 */
class ReplayItems {
  readonly items: Item[]
  readonly #indexById = new Map<string, number>()

  constructor(items: readonly Item[]) {
    this.items = [...items]
    for (let index = 0; index < this.items.length; index += 1) {
      const id = this.items[index]?.id
      if (id !== undefined && !this.#indexById.has(id)) this.#indexById.set(id, index)
    }
  }

  append(item: Item): void {
    const itemId = item.id
    if (!this.#indexById.has(itemId)) this.#indexById.set(itemId, this.items.length)
    this.items.push(item)
  }

  start(item: Item): void {
    const itemId = item.id
    const existingIndex = this.#indexById.get(itemId)
    if (existingIndex === undefined) {
      this.append(item)
      return
    }

    const existing = this.items[existingIndex]
    if (!existing) return
    const optimistic = existing.id.startsWith(OPTIMISTIC_PREFIX) && existing.turnId === ''
    if (!optimistic && existing.status !== 'started') return
    this.items[existingIndex] = {
      ...item,
      ...(!item.text && existing.text ? { text: existing.text } : {}),
    }
  }

  complete(item: Item): void {
    const itemId = item.id
    const existingIndex = this.#indexById.get(itemId)
    if (existingIndex === undefined) {
      this.append(item)
      return
    }

    const streamed = this.items[existingIndex]?.text
    this.items[existingIndex] = {
      ...item,
      ...(!item.text ? { text: streamed } : {}),
    }
  }

  retainIndex(): void {
    itemIndexes.set(this.items, this.#indexById)
    itemIndexOwners.set(this.#indexById, this.items)
  }

  appendDelta(
    itemId: string,
    turnId: string,
    textDelta: string,
    activeTurnId: string | undefined,
  ): void {
    const index = this.#indexById.get(itemId)
    if (index === undefined) {
      if (activeTurnId && turnId !== activeTurnId) return
      this.append({
        id: itemId,
        turnId: activeTurnId ?? '',
        type: 'message',
        status: 'started',
        role: 'assistant',
        text: textDelta,
        createdAt: Date.now(),
      })
      return
    }

    const existing = this.items[index]
    if (existing?.status === 'started') {
      this.items[index] = { ...existing, text: (existing.text ?? '') + textDelta }
    }
  }
}

/**
 * Replays persisted events with the same delta batching used by the live
 * renderer. Long histories contain hundreds of adjacent text chunks per item;
 * folding those one at a time copies the growing transcript once per token.
 * Non-delta events flush first, preserving the exact recorded order.
 */
export function reduceEventLog(
  state: ThreadState,
  entries: ReadonlyArray<{ seq?: number | undefined; event: DomainEvent }>,
  afterSeq?: number,
): ThreadState {
  let next = settleLiveItems(state)
  let ownsNext = next !== state
  let deltaItemId: string | undefined
  let deltaTurnId: string | undefined
  let deltaText = ''
  let deltaChunksByItem:
    Map<string, { chunks: string[]; itemId: string; turnId: string }> | undefined
  let replayItems: ReplayItems | undefined
  let replayTurnTiming: Record<string, { startedAt?: number; completedAt?: number }> | undefined

  // Replayed state is private until this function returns. Claim one shallow
  // copy lazily, then update its top-level fields instead of allocating a new
  // ThreadState for every stored lifecycle boundary. Empty and skipped logs
  // still preserve the caller's exact state identity.
  const mutableState = () => {
    if (!ownsNext) {
      next = { ...next }
      ownsNext = true
    }
    return next
  }

  const mutableItems = () => {
    if (!replayItems) {
      replayItems = new ReplayItems(next.items)
      mutableState().items = replayItems.items
    }
    return replayItems
  }

  const flushDeltas = () => {
    if (deltaItemId === undefined && !deltaChunksByItem) return
    const items = mutableItems()
    const activeTurnId = next.activeTurn?.id
    if (deltaItemId !== undefined) {
      items.appendDelta(deltaItemId, deltaTurnId!, deltaText, activeTurnId)
      deltaItemId = undefined
      deltaTurnId = undefined
      deltaText = ''
      return
    }
    for (const { chunks, itemId, turnId } of deltaChunksByItem!.values()) {
      items.appendDelta(
        itemId,
        turnId,
        chunks.length === 1 ? chunks[0]! : chunks.join(''),
        activeTurnId,
      )
    }
    deltaChunksByItem = undefined
  }

  const mutableTurnTiming = () => {
    if (!replayTurnTiming) {
      replayTurnTiming = { ...next.turnTiming }
      mutableState().turnTiming = replayTurnTiming
    }
    return replayTurnTiming
  }

  for (const entry of entries) {
    if (afterSeq !== undefined && entry.seq !== undefined && entry.seq <= afterSeq) continue
    const event = entry.event
    if (event.type === 'item.delta') {
      // The stored wire normally has one contiguous delta run per item. Fold
      // that run while reading it instead of retaining every event and walking
      // the same range again at the next lifecycle boundary. Rare interleaved
      // output switches to grouped chunks so concatenation stays linear.
      if (deltaChunksByItem) {
        const key = JSON.stringify([event.itemId, event.turnId])
        const entry = deltaChunksByItem.get(key)
        if (entry) entry.chunks.push(event.textDelta)
        else {
          deltaChunksByItem.set(key, {
            chunks: [event.textDelta],
            itemId: event.itemId,
            turnId: event.turnId,
          })
        }
      } else if (deltaItemId === undefined) {
        deltaItemId = event.itemId
        deltaTurnId = event.turnId
        deltaText = event.textDelta
      } else if (event.itemId === deltaItemId && event.turnId === deltaTurnId) {
        deltaText += event.textDelta
      } else {
        const firstKey = JSON.stringify([deltaItemId, deltaTurnId])
        const eventKey = JSON.stringify([event.itemId, event.turnId])
        deltaChunksByItem = new Map([
          [firstKey, { chunks: [deltaText], itemId: deltaItemId, turnId: deltaTurnId! }],
          [eventKey, { chunks: [event.textDelta], itemId: event.itemId, turnId: event.turnId }],
        ])
        deltaItemId = undefined
        deltaTurnId = undefined
        deltaText = ''
      }
      continue
    }
    flushDeltas()
    if (event.type === 'item.started') {
      mutableItems().start(event.item)
      continue
    }
    if (event.type === 'item.completed') {
      if (event.item.text === LEGACY_DESIGN_APPROVAL_WARNING) continue
      mutableItems().complete(event.item)
      continue
    }
    if (event.type === 'thread.error') {
      const items = mutableItems()
      items.append(createThreadErrorItem(event.message))
      next = settleThreadError(next, items.items)
      ownsNext = true
      continue
    }
    if (event.type === 'turn.started') {
      const timing = mutableTurnTiming()
      const previous = timing[event.turn.id]
      const startedAt = previous?.startedAt ?? event.turn.createdAt
      timing[event.turn.id] = { ...previous, startedAt }
      const mutable = mutableState()
      mutable.running = true
      mutable.liveStart = mutable.items.length
      mutable.activeTurn = { id: event.turn.id, startedAt }
      mutable.turnTiming = timing
      mutable.plan = []
      mutable.diff = undefined
      mutable.diffTurnId = undefined
      continue
    }
    if (event.type === 'turn.completed') {
      let timing = next.turnTiming
      if (event.completedAt !== undefined) {
        const mutable = mutableTurnTiming()
        const previous = mutable[event.turnId]
        mutable[event.turnId] = {
          ...previous,
          completedAt: previous?.completedAt ?? event.completedAt,
        }
        timing = mutable
      }
      const mutable = mutableState()
      mutable.running = false
      mutable.liveStart = mutable.items.length
      mutable.activeTurn = undefined
      mutable.approvals = []
      mutable.turnTiming = timing
      continue
    }

    const reduced = reduce(next, event)
    if (reduced !== next) ownsNext = true
    next = reduced
  }
  flushDeltas()
  replayItems?.retainIndex()
  return next
}

/**
 * Reads only the active tail during streaming. A forward `some` walk makes
 * every rendered delta pay for the entire transcript before it reaches the
 * current turn, so a long chat gets progressively slower even though only its
 * last few items can affect this indicator.
 */
export function activeTurnIsSearching(
  items: Item[],
  turnId: string | undefined,
  liveItems: ReadonlyMap<number, LiveItemUpdate> = EMPTY_LIVE_ITEMS,
  liveStart = 0,
  activityIndices?: readonly number[],
): boolean {
  if (!turnId) return false

  if (activityIndices) {
    for (const index of activityIndices) {
      const item = threadItemAt(items, liveItems, index)
      if (
        item?.type === 'tool_call' &&
        item.status === 'started' &&
        `${item.text ?? ''} ${item.command ?? ''}`.toLowerCase().includes('search')
      ) {
        return true
      }
    }
    return false
  }

  for (let index = items.length - 1; index >= liveStart; index -= 1) {
    const item = threadItemAt(items, liveItems, index)
    if (!item) continue
    if (item.turnId !== turnId) {
      // A locally echoed steer has no canonical turn id yet and may sit
      // between two live items from the same provider turn.
      if (item.turnId === '') continue
      // The active turn is the transcript tail. If its first canonical item
      // has not arrived yet, the previous turn is already the stopping point.
      break
    }

    if (
      item.type === 'tool_call' &&
      item.status === 'started' &&
      `${item.text ?? ''} ${item.command ?? ''}`.toLowerCase().includes('search')
    ) {
      return true
    }
  }

  return false
}

/**
 * Index the few live activity rows once per structural transcript update.
 * Text deltas keep the item array stable, so per-frame status labels can read
 * this short list instead of walking a tool-heavy turn from its answer tail.
 */
export function activeTurnActivityIndices(
  items: readonly Item[],
  turnId: string | undefined,
  liveStart = 0,
): number[] {
  if (!turnId) return []
  const indices: number[] = []
  for (let index = items.length - 1; index >= liveStart; index -= 1) {
    const item = items[index]
    if (!item) continue
    if (item.turnId !== turnId) {
      if (item.turnId === '') continue
      break
    }
    if (item.status === 'started' && item.type !== 'message' && item.type !== 'error') {
      indices.push(index)
    }
  }
  return indices
}

/** Local echo, so the user's own message appears the instant they hit send. */
export function appendUserMessage(
  state: ThreadState,
  text: string,
  id = createOptimisticMessageId(),
  createdAt = Date.now(),
  attachments: string[] = [],
): ThreadState {
  const item: Item = {
    id,
    turnId: '',
    type: 'message',
    role: 'user',
    status: 'completed',
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt,
  }
  const items = copyMaterializedItems(state)
  items.push(item)
  recordAppendedItem(items, item)
  return {
    ...state,
    items,
    liveItems: EMPTY_LIVE_ITEMS,
  }
}

/** Immediate local turn state while the server resumes or starts the real turn. */
export function beginOptimisticTurn(
  state: ThreadState,
  text: string,
  itemId = createOptimisticMessageId(),
  createdAt = Date.now(),
  attachments: string[] = [],
): ThreadState {
  return {
    ...appendUserMessage(state, text, itemId, createdAt, attachments),
    running: true,
    activeTurn: { id: localId('local-turn:'), startedAt: createdAt },
    plan: [],
    diff: undefined,
  }
}

/** A prompt that the server queued belongs on the shelf, not in the transcript yet. */
export function removeOptimisticMessage(state: ThreadState, itemId: string): ThreadState {
  const index = itemIndex(state.items, itemId)
  if (index < 0 || state.items[index]?.turnId !== '') return settleLiveItems(state)
  const items = copyMaterializedItems(state)
  items.splice(index, 1)
  itemIndexes.delete(items)
  return { ...state, items, liveItems: EMPTY_LIVE_ITEMS }
}
