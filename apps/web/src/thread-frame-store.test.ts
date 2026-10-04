import { describe, expect, it, vi } from 'vitest'
import { emptyThread } from './thread-store.js'
import { ThreadFrameStore } from './thread-frame-store.js'

describe('ThreadFrameStore', () => {
  it('notifies subscribers only when the snapshot identity changes', () => {
    const store = new ThreadFrameStore(emptyThread)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    const next = { ...emptyThread, itemVersion: 1 }

    store.publish(emptyThread)
    store.publish(next)
    store.publish(next)

    expect(store.getSnapshot()).toBe(next)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.publish({ ...next, itemVersion: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('routes text-only frames to the changed row without invalidating structure', () => {
    const item = {
      id: 'answer-1',
      turnId: 'turn-1',
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'started' as const,
      text: '',
      createdAt: 1,
    }
    const initial = { ...emptyThread, items: [item], running: true }
    const store = new ThreadFrameStore(initial)
    const fullListener = vi.fn()
    const structureListener = vi.fn()
    const firstRowListener = vi.fn()
    const otherRowListener = vi.fn()
    store.subscribe(fullListener)
    store.subscribeStructure(structureListener)
    store.subscribeItems([0], firstRowListener)
    store.subscribeItems([1], otherRowListener)

    const live = {
      ...initial,
      liveItems: new Map([
        [
          0,
          {
            item: { ...item, text: 'Hello' },
            version: 1,
            textUpdate: { kind: 'append' as const, text: 'Hello' },
          },
        ],
      ]),
      itemVersion: 1,
    }
    store.publish(live)

    expect(store.getSnapshot()).toBe(live)
    expect(store.getStructureSnapshot()).toBe(initial)
    expect(fullListener).toHaveBeenCalledTimes(1)
    expect(firstRowListener).toHaveBeenCalledTimes(1)
    expect(otherRowListener).not.toHaveBeenCalled()
    expect(structureListener).not.toHaveBeenCalled()

    const completed = {
      ...live,
      items: [{ ...item, status: 'completed' as const, text: 'Hello' }],
      liveItems: new Map(),
      running: false,
    }
    store.publish(completed)

    expect(store.getStructureSnapshot()).toBe(completed)
    expect(firstRowListener).toHaveBeenCalledTimes(2)
    expect(structureListener).toHaveBeenCalledTimes(1)
  })

  it('routes several changed rows through one contiguous range subscription', () => {
    const items = Array.from({ length: 4 }, (_, index) => ({
      id: `item-${index}`,
      turnId: 'turn-1',
      type: 'tool_call' as const,
      status: 'started' as const,
      text: '',
      createdAt: index,
    }))
    const initial = { ...emptyThread, items, running: true }
    const store = new ThreadFrameStore(initial)
    const rangeListener = vi.fn()
    const outsideListener = vi.fn()
    const unsubscribe = store.subscribeItemRange(0, 2, rangeListener)
    store.subscribeItemRange(3, 3, outsideListener)

    store.publish({
      ...initial,
      liveItems: new Map(
        [0, 2].map((index) => [
          index,
          {
            item: { ...items[index]!, text: 'changed' },
            version: 1,
            textUpdate: { kind: 'append' as const, text: 'changed' },
          },
        ]),
      ),
      itemVersion: 1,
    })

    expect(rangeListener).toHaveBeenCalledTimes(1)
    expect(outsideListener).not.toHaveBeenCalled()
    unsubscribe()
    store.publish(initial)
    expect(rangeListener).toHaveBeenCalledTimes(1)
  })
})
