// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDeferredArchiveQueue } from './useDeferredArchiveQueue.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function renderQueue(delayMs = 10_000) {
  let queue!: ReturnType<typeof useDeferredArchiveQueue>
  function Harness() {
    queue = useDeferredArchiveQueue(delayMs)
    return null
  }
  const view = render(<Harness />)
  return {
    get queue() {
      return queue
    },
    view,
  }
}

it('commits every pending archive after the undo window', async () => {
  vi.useFakeTimers()
  const harness = renderQueue()
  const first = vi.fn(async () => undefined)
  const second = vi.fn(async () => undefined)
  act(() => {
    harness.queue.queue('a', first)
    harness.queue.queue('b', second)
  })
  expect(harness.queue.pendingIds).toEqual(['a', 'b'])
  expect(harness.queue.hiddenIds).toEqual(['a', 'b'])
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
  expect(harness.queue.hiddenIds).toEqual([])
})

it('undoes pending work and returns the last chat', () => {
  const harness = renderQueue()
  const commit = vi.fn(async () => undefined)
  act(() => {
    harness.queue.queue('a', commit)
    harness.queue.queue('b', commit)
  })
  let restored: string | undefined
  act(() => {
    restored = harness.queue.undo()
  })
  expect(restored).toBe('b')
  expect(harness.queue.hiddenIds).toEqual([])
  expect(commit).not.toHaveBeenCalled()
})

it.each(['pagehide', 'unmount'] as const)('flushes pending work on %s', async (event) => {
  const harness = renderQueue()
  const commit = vi.fn(async () => undefined)
  act(() => harness.queue.queue('a', commit))
  if (event === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  else harness.view.unmount()
  await act(async () => Promise.resolve())
  expect(commit).toHaveBeenCalledOnce()
})

it('removes failed work without blocking the next archive', async () => {
  vi.useFakeTimers()
  const harness = renderQueue(100)
  const failed = vi.fn(async () => {
    throw new Error('failed')
  })
  const next = vi.fn(async () => undefined)
  act(() => {
    harness.queue.queue('a', failed)
    harness.queue.queue('b', next)
  })
  await act(async () => vi.advanceTimersByTimeAsync(100))
  expect(failed).toHaveBeenCalledOnce()
  expect(next).toHaveBeenCalledOnce()
  expect(harness.queue.hiddenIds).toEqual([])
})
