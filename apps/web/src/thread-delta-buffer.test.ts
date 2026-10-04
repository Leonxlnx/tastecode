import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import {
  appendBackgroundThreadDelta,
  appendThreadDelta,
  BACKGROUND_DELTA_EVENT_LIMIT,
  BACKGROUND_DELTA_TEXT_LIMIT,
  drainPendingThreadDeltas,
  shouldDrainBackgroundDeltas,
  shouldRetainThreadTranscript,
  type PendingThreadDeltaBatch,
} from './thread-delta-buffer.js'
import { emptyThread, threadItemAt, type ItemDeltaEvent, type ThreadState } from './thread-store.js'

const liveItem: Item = {
  id: 'answer',
  turnId: 'turn',
  type: 'message',
  role: 'assistant',
  status: 'started',
  text: '',
  createdAt: 0,
}

function delta(textDelta = 'x'): ItemDeltaEvent {
  return { type: 'item.delta', turnId: 'turn', itemId: liveItem.id, textDelta }
}

function liveState(): ThreadState {
  return {
    ...emptyThread,
    items: [liveItem],
    running: true,
    activeTurn: { id: liveItem.turnId, startedAt: 0 },
  }
}

describe('thread delta buffer', () => {
  it('appends in place and retains the latest durable sequence', () => {
    const first = appendThreadDelta(undefined, delta('ab'), 4)
    const second = appendThreadDelta(first, delta('c'), 7)

    expect(second).toBe(first)
    expect(second.events).toHaveLength(2)
    expect(second.textLength).toBe(3)
    expect(second.sequence).toBe(7)
  })

  it('coalesces adjacent hidden deltas without mutating replay input', () => {
    const original = delta('ab')
    const first = appendBackgroundThreadDelta(undefined, original, 4)
    const second = appendBackgroundThreadDelta(first, delta('c'), 7)

    expect(second).toBe(first)
    expect(second.events).toEqual([delta('abc')])
    expect(second.eventCount).toBe(2)
    expect(second.textLength).toBe(3)
    expect(second.sequence).toBe(7)
    expect(original.textDelta).toBe('ab')
  })

  it('keeps the original event count when a stream moves between hidden and active', () => {
    const first = appendBackgroundThreadDelta(undefined, delta('a'))
    const hidden = appendBackgroundThreadDelta(first, delta('b'))
    const activeEvent = delta('c')
    const active = appendThreadDelta(hidden, activeEvent)
    const hiddenAgain = appendBackgroundThreadDelta(active, delta('d'))

    expect(hiddenAgain.events).toEqual([delta('ab'), delta('cd')])
    expect(hiddenAgain.eventCount).toBe(4)
    expect(hiddenAgain.textLength).toBe(4)
    expect(activeEvent.textDelta).toBe('c')
  })

  it('bounds background buffers by event count or text size', () => {
    const manyEvents: PendingThreadDeltaBatch = {
      events: Array.from({ length: BACKGROUND_DELTA_EVENT_LIMIT }, () => delta()),
      eventCount: BACKGROUND_DELTA_EVENT_LIMIT,
      textLength: BACKGROUND_DELTA_EVENT_LIMIT,
    }
    const largeText: PendingThreadDeltaBatch = {
      events: [delta('x'.repeat(BACKGROUND_DELTA_TEXT_LIMIT))],
      eventCount: 1,
      textLength: BACKGROUND_DELTA_TEXT_LIMIT,
    }

    expect(shouldDrainBackgroundDeltas(manyEvents)).toBe(true)
    expect(shouldDrainBackgroundDeltas(largeText)).toBe(true)
    expect(shouldDrainBackgroundDeltas({ events: [delta()], eventCount: 1, textLength: 1 })).toBe(
      false,
    )
  })

  it('retains the active transcript but elides released background transcript work', () => {
    const partial = new Set(['background', 'active'])

    expect(shouldRetainThreadTranscript('active', 'active', partial)).toBe(true)
    expect(shouldRetainThreadTranscript('background', 'active', partial)).toBe(false)
    expect(shouldRetainThreadTranscript('hot-background', 'active', partial)).toBe(true)
  })

  it('drains one thread without touching other background work', () => {
    const states = new Map<string, ThreadState>([
      ['active', liveState()],
      ['background', liveState()],
    ])
    const pending = new Map<string, PendingThreadDeltaBatch>([
      ['active', appendThreadDelta(undefined, delta('hello'), 8)],
      ['background', appendThreadDelta(undefined, delta('later'), 9)],
    ])
    const sequences = new Map([
      ['active', 3],
      ['background', 3],
    ])

    const next = drainPendingThreadDeltas(states, pending, sequences, 'active')

    expect(threadItemAt(next.items, next.liveItems, 0)?.text).toBe('hello')
    expect(sequences.get('active')).toBe(8)
    expect(pending.has('active')).toBe(false)
    expect(pending.has('background')).toBe(true)
    expect(sequences.get('background')).toBe(3)
  })
})
