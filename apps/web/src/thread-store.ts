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

export const emptyThread: ThreadState = {
  items: [],
  running: false,
  activeTurn: undefined,
  turnTiming: {},
  plan: [],
  approvals: [],
  userInputs: [],
  reviews: {},
}

export type ItemDeltaEvent = Extract<DomainEvent, { type: 'item.delta' }>

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

export function reduce(state: ThreadState, event: DomainEvent): ThreadState {
  switch (event.type) {
    case 'turn.started':
      // A new turn gets a fresh plan and diff; the previous ones described work
      // already finished, and leaving them up reads as stale instructions.
      const startedAt = state.turnTiming[event.turn.id]?.startedAt ?? event.turn.createdAt
      return {
        ...state,
        running: true,
        activeTurn: {
          id: event.turn.id,
          startedAt,
        },
        turnTiming: {
          ...state.turnTiming,
          [event.turn.id]: { ...state.turnTiming[event.turn.id], startedAt },
        },
        plan: [],
        diff: undefined,
      }

    case 'turn.completed':
      // Approvals the turn never answered are unanswerable now (the adapters
      // resolve them server-side too; this covers logs written before that
      // fix). userInputs stay: design-briefing questions legitimately outlive
      // their turn and are answered to start the next one.
      const timing = state.turnTiming[event.turnId]
      return {
        ...state,
        running: false,
        activeTurn: undefined,
        approvals: [],
        turnTiming:
          event.completedAt === undefined
            ? state.turnTiming
            : {
                ...state.turnTiming,
                [event.turnId]: {
                  ...timing,
                  completedAt: timing?.completedAt ?? event.completedAt,
                },
              },
      }

    case 'plan.updated':
      return { ...state, plan: event.steps }

    case 'usage.updated':
      return { ...state, usage: event.usage }

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

    case 'item.delta': {
      // Deltas almost always land on the item that is still streaming, which
      // is the last one. Scanning the whole transcript per delta — hundreds a
      // second on a token-granularity provider — is what makes a long session
      // feel worse than a short one.
      const last = state.items.length - 1
      const index =
        state.items[last]?.id === event.itemId
          ? last
          : state.items.findIndex((i) => i.id === event.itemId)
      if (index === -1) {
        // A delta ahead of its item.started (reconnect, replay boundary)
        // must not be dropped — the text would be permanently missing from
        // the message. Hold it in a placeholder the real item fills in.
        return {
          ...state,
          items: [
            ...state.items,
            {
              id: event.itemId,
              turnId: state.activeTurn?.id ?? '',
              type: 'message',
              status: 'started',
              role: 'assistant',
              text: event.textDelta,
              createdAt: Date.now(),
            },
          ],
        }
      }
      const existing = state.items[index]
      if (!existing) return state
      if (existing.status !== 'started') return state
      const items = state.items.slice()
      items[index] = { ...existing, text: (existing.text ?? '') + event.textDelta }
      return { ...state, items }
    }

    case 'item.completed': {
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
      return {
        ...state,
        running: false,
        activeTurn: undefined,
        approvals: [],
        userInputs: [],
        items: [
          ...state.items,
          {
            id: localId('error:'),
            turnId: '',
            type: 'error',
            status: 'completed',
            text: event.message,
            createdAt: Date.now(),
          },
        ],
      }

    default:
      return state
  }
}

/**
 * Applies one rendered frame of text deltas with one item-array copy and one
 * item replacement per target. The single-event reducer stays authoritative;
 * this is its equivalent fast path for live frames and persisted replay, where
 * providers commonly emit many tiny chunks between structural events.
 */
export function reduceDeltas(state: ThreadState, deltas: ItemDeltaEvent[]): ThreadState {
  if (deltas.length === 0) return state

  const chunksByItem = new Map<string, string[]>()
  for (const event of deltas) {
    const chunks = chunksByItem.get(event.itemId)
    if (chunks) chunks.push(event.textDelta)
    else chunksByItem.set(event.itemId, [event.textDelta])
  }

  const items = state.items.slice()
  for (const [itemId, chunks] of chunksByItem) {
    const last = items.length - 1
    const index = items[last]?.id === itemId ? last : items.findIndex((item) => item.id === itemId)
    const textDelta = chunks.length === 1 ? chunks[0]! : chunks.join('')
    if (index < 0) {
      items.push({
        id: itemId,
        turnId: state.activeTurn?.id ?? '',
        type: 'message',
        status: 'started',
        role: 'assistant',
        text: textDelta,
        createdAt: Date.now(),
      })
      continue
    }

    const existing = items[index]
    if (existing?.status === 'started') {
      items[index] = { ...existing, text: (existing.text ?? '') + textDelta }
    }
  }

  return { ...state, items }
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
  let next = state
  let deltas: ItemDeltaEvent[] = []

  const flushDeltas = () => {
    if (deltas.length === 0) return
    next = reduceDeltas(next, deltas)
    deltas = []
  }

  for (const entry of entries) {
    if (afterSeq !== undefined && entry.seq !== undefined && entry.seq <= afterSeq) continue
    if (entry.event.type === 'item.delta') {
      deltas.push(entry.event)
      continue
    }
    flushDeltas()
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
export function activeTurnIsSearching(items: Item[], turnId: string | undefined): boolean {
  if (!turnId) return false

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
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
  const index = state.items.findIndex((item) => item.id === itemId && item.turnId === '')
  if (index < 0) return state
  const items = state.items.slice()
  items.splice(index, 1)
  return { ...state, items }
}
