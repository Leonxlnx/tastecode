import type {
  ApprovalRequest,
  ApprovalReview,
  DomainEvent,
  Item,
  PlanStep,
  Usage,
  UserInputRequest,
} from '@harness/contracts'

/**
 * Folds the domain event stream into what the UI renders.
 *
 * The rule that matters for M1: a completed item is immutable. Only the item
 * currently streaming changes identity, so everything above it can be memoised
 * hard once virtualisation lands.
 */
export type ThreadState = {
  items: Item[]
  liveItems: ReadonlyMap<number, LiveItemUpdate>
  itemVersion: number
  liveStart: number
  running: boolean
  /** The live turn whose elapsed time and activity the UI is presenting. */
  activeTurn: { id: string; startedAt: number } | undefined
  /** Durable server-owned lifecycle boundaries used by live and replayed elapsed labels. */
  turnTiming: Readonly<Record<string, { startedAt?: number; completedAt?: number }>>
  /** The agent's plan for the current turn. Replaced wholesale when it changes. */
  plan: PlanStep[]
  usage?: Usage
  /** Everything the current turn changed, as one unified diff. */
  diff?: string | undefined
  /** Permission requests still waiting on an answer. */
  approvals: ApprovalRequest[]
  /** Structured questions still blocking the current agent turn. */
  userInputs: UserInputRequest[]
  /** Automatic approval reviews, upserted by their stable provider id. */
  reviews: Record<string, ApprovalReview>
}

const EMPTY_LIVE_ITEMS: ReadonlyMap<number, LiveItemUpdate> = new Map()

export const emptyThread: ThreadState = {
  items: [],
  liveItems: EMPTY_LIVE_ITEMS,
  itemVersion: 0,
  liveStart: 0,
  running: false,
  activeTurn: undefined,
  turnTiming: {},
  plan: [],
  approvals: [],
  userInputs: [],
  reviews: {},
}

export type ItemDeltaEvent = Extract<DomainEvent, { type: 'item.delta' }>

export type LiveItemUpdate = {
  item: Item
  version: number
  textUpdate: { kind: 'append'; text: string }
}

export function threadItemAt(
  items: readonly Item[],
  liveItems: ReadonlyMap<number, LiveItemUpdate>,
  index: number,
): Item | undefined {
  return liveItems.get(index)?.item ?? items[index]
}

function materializeItems(state: ThreadState): Item[] {
  if (state.liveItems.size === 0) return state.items
  const items = state.items.slice()
  for (const [index, update] of state.liveItems) items[index] = update.item
  return items
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
let localIdSequence = 0

/**
 * randomUUID is restricted to secure contexts, while the mobile development
 * client is served over plain HTTP on a private Tailscale address. These ids
 * only identify renderer-local rows, so a timestamp and counter are a safe
 * fallback when the browser deliberately withholds that API.
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
      return { ...state, diff: event.diff }

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
      state = settleLiveItems(state)
      // An early delta or exact optimistic submission may already own this id;
      // fill it in rather than inferring identity from repeated prompt text.
      const existingIndex = state.items.findIndex((item) => item.id === event.item.id)
      if (existingIndex < 0) return { ...state, items: [...state.items, event.item] }
      const existing = state.items[existingIndex]
      const optimistic = existing?.id.startsWith(OPTIMISTIC_PREFIX) && existing.turnId === ''
      // Completion is terminal. A buffered or retried start may arrive after
      // restored history and must never resurrect finished canonical work.
      if (!optimistic && existing?.status !== 'started') return state
      const items = state.items.slice()
      items[existingIndex] = {
        ...event.item,
        ...(event.item.text || !existing?.text ? {} : { text: existing.text }),
      }
      return { ...state, items }
    }

    case 'item.delta':
      return reduceDeltas(state, [event])

    case 'item.completed': {
      state = settleLiveItems(state)
      const index = state.items.findIndex((i) => i.id === event.item.id)
      if (index === -1) return { ...state, items: [...state.items, event.item] }
      const items = state.items.slice()
      // Keep streamed text when the completed payload carries none, so a
      // finished message never blanks out what the user just watched arrive.
      const streamed = items[index]?.text
      items[index] = { ...event.item, ...(event.item.text ? {} : { text: streamed }) }
      return { ...state, items }
    }

    case 'thread.error':
      state = settleLiveItems(state)
      return settleThreadError(state, [...state.items, createThreadErrorItem(event.message)])

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

  const chunksByItem = new Map<string, { chunks: string[]; turnId: string }>()
  for (const event of deltas) {
    const entry = chunksByItem.get(event.itemId)
    if (entry) entry.chunks.push(event.textDelta)
    else chunksByItem.set(event.itemId, { chunks: [event.textDelta], turnId: event.turnId })
  }

  let items = state.items
  let liveItems = new Map(state.liveItems)
  let liveStart = state.liveStart
  let changed = false
  for (const [itemId, { chunks, turnId }] of chunksByItem) {
    const last = items.length - 1
    let index = last >= liveStart && threadItemAt(items, liveItems, last)?.id === itemId ? last : -1
    for (let candidate = last - 1; index < 0 && candidate >= liveStart; candidate -= 1) {
      if (threadItemAt(items, liveItems, candidate)?.id === itemId) index = candidate
    }
    const textDelta = chunks.length === 1 ? chunks[0]! : chunks.join('')
    if (index < 0) {
      if (state.activeTurn && turnId !== state.activeTurn.id) continue
      if (liveItems.size > 0) {
        const materialized = items.slice()
        for (const [liveIndex, update] of liveItems) materialized[liveIndex] = update.item
        items = materialized
        liveItems = new Map()
      }
      if (!state.running) liveStart = items.length
      items = [
        ...items,
        {
          id: itemId,
          turnId: state.activeTurn?.id ?? '',
          type: 'message',
          status: 'started',
          role: 'assistant',
          text: textDelta,
          createdAt: Date.now(),
        },
      ]
      changed = true
      continue
    }

    const existing = threadItemAt(items, liveItems, index)
    if (existing?.status === 'started') {
      liveItems.set(index, {
        item: { ...existing, text: (existing.text ?? '') + textDelta },
        version: state.itemVersion + 1,
        textUpdate: { kind: 'append', text: textDelta },
      })
      changed = true
    }
  }

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
    const optimistic = existing?.id.startsWith(OPTIMISTIC_PREFIX) && existing.turnId === ''
    if (!optimistic && existing?.status !== 'started') return
    this.items[existingIndex] = {
      ...item,
      ...(item.text || !existing?.text ? {} : { text: existing.text }),
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
    this.items[existingIndex] = { ...item, ...(item.text ? {} : { text: streamed }) }
  }

  appendDeltas(deltas: ItemDeltaEvent[], activeTurnId: string | undefined): void {
    const chunksByItem = new Map<string, string[]>()
    for (const event of deltas) {
      const chunks = chunksByItem.get(event.itemId)
      if (chunks) chunks.push(event.textDelta)
      else chunksByItem.set(event.itemId, [event.textDelta])
    }

    for (const [itemId, chunks] of chunksByItem) {
      const textDelta = chunks.length === 1 ? chunks[0]! : chunks.join('')
      const index = this.#indexById.get(itemId)
      if (index === undefined) {
        this.append({
          id: itemId,
          turnId: activeTurnId ?? '',
          type: 'message',
          status: 'started',
          role: 'assistant',
          text: textDelta,
          createdAt: Date.now(),
        })
        continue
      }

      const existing = this.items[index]
      if (existing?.status === 'started') {
        this.items[index] = { ...existing, text: (existing.text ?? '') + textDelta }
      }
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
  let deltas: ItemDeltaEvent[] = []
  let replayItems: ReplayItems | undefined

  const mutableItems = () => {
    if (!replayItems) {
      replayItems = new ReplayItems(next.items)
      next = { ...next, items: replayItems.items }
    }
    return replayItems
  }

  const flushDeltas = () => {
    if (deltas.length === 0) return
    mutableItems().appendDeltas(deltas, next.activeTurn?.id)
    deltas = []
  }

  for (const entry of entries) {
    if (afterSeq !== undefined && entry.seq !== undefined && entry.seq <= afterSeq) continue
    if (entry.event.type === 'item.delta') {
      deltas.push(entry.event)
      continue
    }
    flushDeltas()
    if (entry.event.type === 'item.started') {
      mutableItems().start(entry.event.item)
      continue
    }
    if (entry.event.type === 'item.completed') {
      mutableItems().complete(entry.event.item)
      continue
    }
    if (entry.event.type === 'thread.error') {
      const items = mutableItems()
      items.append(createThreadErrorItem(entry.event.message))
      next = settleThreadError(next, items.items)
      continue
    }

    next = reduce(next, entry.event)
  }
  flushDeltas()
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
): boolean {
  if (!turnId) return false

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

/** Local echo, so the user's own message appears the instant they hit send. */
export function appendUserMessage(
  state: ThreadState,
  text: string,
  id = createOptimisticMessageId(),
  createdAt = Date.now(),
): ThreadState {
  state = settleLiveItems(state)
  return {
    ...state,
    items: [
      ...state.items,
      {
        id,
        turnId: '',
        type: 'message',
        role: 'user',
        status: 'completed',
        text,
        createdAt,
      },
    ],
  }
}

/** Immediate local turn state while the server resumes or starts the real turn. */
export function beginOptimisticTurn(
  state: ThreadState,
  text: string,
  itemId = createOptimisticMessageId(),
  createdAt = Date.now(),
): ThreadState {
  return {
    ...appendUserMessage(state, text, itemId, createdAt),
    running: true,
    activeTurn: { id: localId('local-turn:'), startedAt: createdAt },
    plan: [],
    diff: undefined,
  }
}

/** A prompt that the server queued belongs on the shelf, not in the transcript yet. */
export function removeOptimisticMessage(state: ThreadState, itemId: string): ThreadState {
  state = settleLiveItems(state)
  const index = state.items.findIndex((item) => item.id === itemId && item.turnId === '')
  if (index < 0) return state
  const items = state.items.slice()
  items.splice(index, 1)
  return { ...state, items }
}
