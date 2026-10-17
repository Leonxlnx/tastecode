import { describe, expect, it } from 'vitest'
import { activeTurnAnchor, isAtBottom, modeForNewTurn, turnRoom } from './scroll-mode.js'

describe('scroll mode', () => {
  it('treats a small gap from the bottom as being at the bottom', () => {
    // Streaming resizes the last row constantly; an exact comparison would
    // flip out of follow mode on its own.
    expect(isAtBottom({ scrollTop: 940, scrollHeight: 1000, clientHeight: 40 })).toBe(true)
    expect(isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 40 })).toBe(false)
  })

  it('follows a new turn only when the user was already following', () => {
    expect(modeForNewTurn(true)).toBe('follow-end')
    // Someone reading older output must not be yanked to a new turn.
    expect(modeForNewTurn(false)).toBe('free')
  })

  it('keeps one anchor through confirmation and advances for a queued turn', () => {
    const optimistic = [{ id: 'submission-1', turnId: '', type: 'message', role: 'user' }]
    expect(activeTurnAnchor(optimistic, 'local-turn:1')).toEqual({
      id: 'submission-1',
      index: 0,
    })

    const confirmed = [
      { id: 'submission-1', turnId: 'turn-1', type: 'message', role: 'user' },
      { id: 'answer-1', turnId: 'turn-1', type: 'message', role: 'assistant' },
    ]
    expect(activeTurnAnchor(confirmed, 'turn-1')).toEqual({ id: 'submission-1', index: 0 })

    const dequeued = [
      ...confirmed,
      { id: 'submission-2', turnId: 'turn-2', type: 'message', role: 'user' },
    ]
    expect(activeTurnAnchor(dequeued, 'turn-2')).toEqual({ id: 'submission-2', index: 2 })
  })

  it('does not move a turn anchor when a steer appends another user message', () => {
    const steered = [
      { id: 'submission-1', turnId: 'turn-1', type: 'message', role: 'user' },
      { id: 'answer-1', turnId: 'turn-1', type: 'message', role: 'assistant' },
      { id: 'steer-1', turnId: 'turn-1', type: 'message', role: 'user' },
    ]

    expect(activeTurnAnchor(steered, 'turn-1')).toEqual({ id: 'submission-1', index: 0 })
  })

  it('reads only the active tail of a long thread', () => {
    let reads = 0
    const items = new Proxy(
      [
        ...Array.from({ length: 10_000 }, (_, index) => ({
          id: `history-${index}`,
          turnId: `turn-${index}`,
          type: 'message',
          role: 'assistant',
        })),
        { id: 'active', turnId: 'active-turn', type: 'message', role: 'user' },
      ],
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1
          return Reflect.get(target, property, receiver)
        },
      },
    )

    expect(activeTurnAnchor(items, 'active-turn', 10_000)).toEqual({
      id: 'active',
      index: 10_000,
    })
    expect(reads).toBeLessThanOrEqual(3)
  })

  it('holds the end at a pinned prompt until the answer fills the screen', () => {
    // A 500px chat in an 800px viewport, the new prompt 392px down.
    expect(turnRoom(-300, 392)).toEqual({ end: 392, room: 692 })
    // The answer grew by 200px: the room gives way, the end stays.
    expect(turnRoom(-100, 392)).toEqual({ end: 392, room: 492 })
    // Past the pin the content's own end leads and no room is left.
    expect(turnRoom(420, 392)).toEqual({ end: 420, room: 0 })
  })

  it('adds no room without a pin, or for a pin the content already reaches', () => {
    expect(turnRoom(-300, undefined)).toEqual({ end: 0, room: 0 })
    expect(turnRoom(1_000, undefined)).toEqual({ end: 1_000, room: 0 })
    // A first turn's prompt sits at the top already.
    expect(turnRoom(-300, 0)).toEqual({ end: 0, room: 0 })
  })
})
