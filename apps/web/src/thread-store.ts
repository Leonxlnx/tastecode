import type { DomainEvent, Item, PlanStep, Usage } from '@harness/contracts'

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
  /** The agent's plan for the current turn. Replaced wholesale when it changes. */
  plan: PlanStep[]
  usage?: Usage
  /** Everything the current turn changed, as one unified diff. */
  diff?: string | undefined
}

export const emptyThread: ThreadState = { items: [], running: false, plan: [] }

/**
 * Marks a locally-echoed message that the agent has not confirmed yet. The
 * user's own text must appear the instant they hit send — waiting for a round
 * trip feels broken — but it has to be reconciled when the real item arrives.
 */
const OPTIMISTIC_PREFIX = 'local:'

export function reduce(state: ThreadState, event: DomainEvent): ThreadState {
  switch (event.type) {
    case 'turn.started':
      // A new turn gets a fresh plan and diff; the previous ones described work
      // already finished, and leaving them up reads as stale instructions.
      return { ...state, running: true, plan: [], diff: undefined }

    case 'turn.completed':
      return { ...state, running: false }

    case 'plan.updated':
      return { ...state, plan: event.steps }

    case 'usage.updated':
      return { ...state, usage: event.usage }

    case 'diff.updated':
      return { ...state, diff: event.diff }

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
        items: [
          ...state.items,
          {
            id: crypto.randomUUID(),
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
        id: `${OPTIMISTIC_PREFIX}${crypto.randomUUID()}`,
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
