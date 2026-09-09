import type { DomainEvent } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecordedDeltaBuffer } from './recorded-delta-buffer.js'

type ItemDeltaEvent = Extract<DomainEvent, { type: 'item.delta' }>

const delta = (textDelta: string, itemId = 'item-1', turnId = 'turn-1'): ItemDeltaEvent => ({
  type: 'item.delta',
  turnId,
  itemId,
  textDelta,
})

afterEach(() => vi.useRealTimers())

describe('RecordedDeltaBuffer', () => {
  it('flushes one exact delta after the short interactive delay', async () => {
    vi.useFakeTimers()
    const committed: Array<{ threadId: string; event: ItemDeltaEvent }> = []
    const buffer = new RecordedDeltaBuffer(
      (threadId, event) => committed.push({ threadId, event }),
      { delayMs: 4 },
    )

    buffer.push('thread-1', delta('Hello '))
    buffer.push('thread-1', delta('world'))

    await vi.advanceTimersByTimeAsync(3)
    expect(committed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(committed).toEqual([{ threadId: 'thread-1', event: delta('Hello world') }])
  })

  it('preserves item order and flushes at both safety bounds', () => {
    const committed: ItemDeltaEvent[] = []
    const buffer = new RecordedDeltaBuffer((_threadId, event) => committed.push(event), {
      delayMs: 60_000,
      maximumTextLength: 4,
      maximumEventCount: 3,
    })

    buffer.push('thread-1', delta('a'))
    buffer.push('thread-1', delta('b', 'item-2'))
    buffer.push('thread-1', delta('12', 'item-2'))
    buffer.push('thread-1', delta('3', 'item-2'))
    buffer.push('thread-1', delta('x', 'item-3'))
    buffer.push('thread-1', delta('y', 'item-3'))
    buffer.push('thread-1', delta('z', 'item-3'))

    expect(committed).toEqual([delta('a'), delta('b123', 'item-2'), delta('xyz', 'item-3')])
    buffer.discardAll()
  })

  it('flushes at the text bound before the event-count bound', () => {
    const committed: ItemDeltaEvent[] = []
    const buffer = new RecordedDeltaBuffer((_threadId, event) => committed.push(event), {
      delayMs: 60_000,
      maximumTextLength: 4,
      maximumEventCount: 100,
    })

    buffer.push('thread-1', delta('12'))
    buffer.push('thread-1', delta('34'))

    expect(committed).toEqual([delta('1234')])
    buffer.discardAll()
  })

  it('flushes or discards each thread independently', () => {
    const committed: Array<{ threadId: string; text: string }> = []
    const buffer = new RecordedDeltaBuffer(
      (threadId, event) => committed.push({ threadId, text: event.textDelta }),
      { delayMs: 60_000 },
    )

    buffer.push('thread-1', delta('kept'))
    buffer.push('thread-2', delta('discarded'))
    buffer.discard('thread-2')
    buffer.flushAll()

    expect(committed).toEqual([{ threadId: 'thread-1', text: 'kept' }])
  })

  it('shares one timer across many streaming threads', async () => {
    vi.useFakeTimers()
    const committed: string[] = []
    const buffer = new RecordedDeltaBuffer((threadId) => committed.push(threadId), { delayMs: 4 })

    for (let index = 0; index < 1_000; index += 1) {
      buffer.push(`thread-${index}`, delta('x'))
    }

    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(4)
    expect(committed).toHaveLength(1_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets a later thread join the current short batch window', async () => {
    vi.useFakeTimers()
    const committed: string[] = []
    const buffer = new RecordedDeltaBuffer((threadId) => committed.push(threadId), { delayMs: 4 })

    buffer.push('thread-1', delta('one'))
    await vi.advanceTimersByTimeAsync(3)
    buffer.push('thread-2', delta('two'))
    await vi.advanceTimersByTimeAsync(1)

    expect(committed).toEqual(['thread-1', 'thread-2'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('commits one whole many-thread window as one ordered batch', async () => {
    vi.useFakeTimers()
    const individual = vi.fn()
    const batches: Array<Array<{ threadId: string; text: string }>> = []
    const buffer = new RecordedDeltaBuffer(individual, {
      delayMs: 4,
      commitBatch: (records) =>
        batches.push(records.map(({ threadId, event }) => ({ threadId, text: event.textDelta }))),
    })

    buffer.push('thread-1', delta('one'))
    buffer.push('thread-2', delta('two'))
    await vi.advanceTimersByTimeAsync(4)

    expect(individual).not.toHaveBeenCalled()
    expect(batches).toEqual([
      [
        { threadId: 'thread-1', text: 'one' },
        { threadId: 'thread-2', text: 'two' },
      ],
    ])
  })

  it('commits a one-thread window without constructing a batch', async () => {
    vi.useFakeTimers()
    const individual = vi.fn()
    const batch = vi.fn()
    const buffer = new RecordedDeltaBuffer(individual, { delayMs: 4, commitBatch: batch })

    buffer.push('thread-1', delta('one'))
    await vi.advanceTimersByTimeAsync(4)

    expect(individual).toHaveBeenCalledWith('thread-1', delta('one'))
    expect(batch).not.toHaveBeenCalled()
  })
})
