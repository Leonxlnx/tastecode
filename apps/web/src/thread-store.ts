import type {
  ApprovalRequest,
  ApprovalReview,
  DomainEvent,
  Item,
  PlanStep,
  Usage,
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
  /** The agent's plan for the current turn. Replaced wholesale when it changes. */
  plan: PlanStep[]
  usage?: Usage
  /** Everything the current turn changed, as one unified diff. */
  diff?: string | undefined
  /** Permission requests still waiting on an answer. */
  approvals: ApprovalRequest[]
  /** Automatic approval reviews, upserted by their stable provider id. */
  reviews: Record<string, ApprovalReview>
}

export const emptyThread: ThreadState = {
  items: [],
  running: false,
  activeTurn: undefined,
  plan: [],
  approvals: [],
  reviews: {},
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

export function reduce(state: ThreadState, event: DomainEvent): ThreadState {
  switch (event.type) {
    case 'turn.started':
      // A new turn gets a fresh plan and diff; the previous ones described work
      // already finished, and leaving them up reads as stale instructions.
      return {
        ...state,
        running: true,
        activeTurn: { id: event.turn.id, startedAt: event.turn.createdAt },
        plan: [],
        diff: undefined,
      }

    case 'turn.completed':
      return { ...state, running: false, activeTurn: undefined }

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

    case 'approval.review.started':
    case 'approval.review.completed':
      return { ...state, reviews: { ...state.reviews, [event.review.id]: event.review } }

    case 'item.started': {
      // The agent echoes the user's message back as a canonical item. Drop our
      // optimistic copy when it arrives, so the message does not appear twice.
      const items =
        event.item.role === 'user'
          ? state.items.filter((i) => !i.id.startsWith(OPTIMISTIC_PREFIX))
          : state.items
      return { ...state, items: [...items, event.item] }
    }

    case 'item.delta': {
      const index = state.items.findIndex((i) => i.id === event.itemId)
      if (index === -1) return state
      const existing = state.items[index]
      if (!existing) return state
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

/** Local echo, so the user's own message appears the instant they hit send. */
export function appendUserMessage(state: ThreadState, text: string): ThreadState {
  return {
    ...state,
    items: [
      ...state.items,
      {
        id: localId(OPTIMISTIC_PREFIX),
        turnId: '',
        type: 'message',
        role: 'user',
        status: 'completed',
        text,
        createdAt: Date.now(),
      },
    ],
  }
}

/** A prompt that the server queued belongs on the shelf, not in the transcript yet. */
export function removeQueuedOptimisticMessage(state: ThreadState, text: string): ThreadState {
  let index = -1
  for (let itemIndex = state.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = state.items[itemIndex]
    if (item?.id.startsWith(OPTIMISTIC_PREFIX) && item.role === 'user' && item.text === text) {
      index = itemIndex
      break
    }
  }
  if (index < 0) return state
  return { ...state, items: state.items.filter((_, itemIndex) => itemIndex !== index) }
}
