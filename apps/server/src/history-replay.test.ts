import { describe, expect, it } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { emptyThread, reduceEventLog, threadItems } from '../../web/src/thread-store.js'
import { compactHistoryReplay } from './history-replay.js'

const item = (id: string, text: string, status: Item['status'] = 'started'): Item => ({
  id,
  turnId: 'turn-1',
  type: 'message',
  role: 'assistant',
  status,
  text,
  createdAt: 1,
})

function entries(events: DomainEvent[]): Array<{ seq: number; event: DomainEvent }> {
  return events.map((event, index) => ({ seq: index + 1, event }))
}

describe('history replay compaction', () => {
  it('replays the same thread without superseded deltas, diffs, plans, or usage', () => {
    const history = entries([
      {
        type: 'turn.started',
        turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 1 },
      },
      { type: 'item.started', item: item('reply', '') },
      { type: 'item.delta', turnId: 'turn-1', itemId: 'reply', textDelta: 'Hello ' },
      { type: 'item.delta', turnId: 'turn-1', itemId: 'reply', textDelta: 'world' },
      { type: 'diff.updated', diff: 'old diff' },
      { type: 'diff.updated', diff: 'final diff' },
      { type: 'plan.updated', steps: [{ step: 'Old', status: 'pending' }] },
      { type: 'plan.updated', steps: [{ step: 'Final', status: 'completed' }] },
      {
        type: 'usage.updated',
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
          totalTokens: 2,
        },
      },
      {
        type: 'usage.updated',
        usage: {
          inputTokens: 2,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 4,
        },
      },
      { type: 'item.completed', item: item('reply', '', 'completed') },
      { type: 'item.delta', turnId: 'turn-1', itemId: 'reply', textDelta: ' ignored' },
      { type: 'item.started', item: item('reply', 'revived') },
      { type: 'turn.completed', turnId: 'turn-1', status: 'completed', completedAt: 2 },
    ])

    const compacted = compactHistoryReplay(history)
    const original = reduceEventLog(emptyThread, history)
    const replayed = reduceEventLog(emptyThread, compacted)

    expect(replayed).toEqual(original)
    expect(threadItems(replayed)[0]?.text).toBe('Hello world')
    expect(compacted.map(({ event }) => event.type)).toEqual([
      'turn.started',
      'item.completed',
      'diff.updated',
      'plan.updated',
      'usage.updated',
      'turn.completed',
    ])
  })

  it('leaves delta-first recovery sequences exact', () => {
    const tail = entries([
      { type: 'item.delta', turnId: 'turn-1', itemId: 'late', textDelta: 'first' },
      { type: 'item.delta', turnId: 'turn-1', itemId: 'late', textDelta: ' second' },
    ])

    expect(compactHistoryReplay(tail)).toEqual(tail)
  })

  it('shrinks a realistic streamed replay by more than ninety percent', () => {
    const history = entries([
      {
        type: 'turn.started',
        turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 1 },
      },
      { type: 'item.started', item: item('reply', '') },
      ...Array.from({ length: 1_000 }, (): DomainEvent => ({
        type: 'item.delta',
        turnId: 'turn-1',
        itemId: 'reply',
        textDelta: 'x',
      })),
      ...Array.from({ length: 100 }, (_, index): DomainEvent => ({
        type: 'diff.updated',
        diff: `diff ${index} ${'x'.repeat(1_000)}`,
      })),
      { type: 'item.completed', item: item('reply', 'x'.repeat(1_000), 'completed') },
      { type: 'turn.completed', turnId: 'turn-1', status: 'completed' },
    ])

    expect(JSON.stringify(compactHistoryReplay(history)).length).toBeLessThan(
      JSON.stringify(history).length / 10,
    )
  })
})
