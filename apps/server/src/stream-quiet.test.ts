import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STREAM_QUIET_MAX_WAIT_MS, STREAM_QUIET_MS, StreamQuiet } from './stream-quiet.js'

describe('stream quiet gate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function waiter(quiet: StreamQuiet) {
    const state = { done: false }
    void quiet.whenQuiet().then(() => {
      state.done = true
    })
    return state
  }

  it('lets work start at once while nothing streams', async () => {
    const quiet = new StreamQuiet()
    const waiting = waiter(quiet)
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting.done).toBe(true)
  })

  it('waits for a two second pause after the last delta', async () => {
    const quiet = new StreamQuiet()
    quiet.noteDelta()
    const waiting = waiter(quiet)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(waiting.done).toBe(false)
    // More deltas keep it waiting.
    quiet.noteDelta()
    await vi.advanceTimersByTimeAsync(STREAM_QUIET_MS - 1)
    expect(waiting.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(waiting.done).toBe(true)
  })

  it('never waits longer than the cap, however long the answer streams', async () => {
    const quiet = new StreamQuiet()
    quiet.noteDelta()
    const waiting = waiter(quiet)
    const stream = setInterval(() => quiet.noteDelta(), 20)
    try {
      await vi.advanceTimersByTimeAsync(STREAM_QUIET_MAX_WAIT_MS - 20)
      expect(waiting.done).toBe(false)
      await vi.advanceTimersByTimeAsync(20)
      expect(waiting.done).toBe(true)
    } finally {
      clearInterval(stream)
    }
  })
})
