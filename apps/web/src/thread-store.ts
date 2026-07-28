import type { DomainEvent, Item } from '@harness/contracts'

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
}

export const emptyThread: ThreadState = { items: [], running: false }

export function reduce(state: ThreadState, event: DomainEvent): ThreadState {
  switch (event.type) {
    case 'turn.started':
      return { ...state, running: true }

    case 'turn.completed':
      return { ...state, running: false }

    case 'item.started':
      return { ...state, items: [...state.items, event.item] }

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
        id: crypto.randomUUID(),
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
