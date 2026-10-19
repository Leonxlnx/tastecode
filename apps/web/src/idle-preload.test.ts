// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preloadWhenIdle } from './idle-preload.js'

type IdleWindow = {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  cancelIdleCallback?: (handle: number) => void
}

function stubIdle() {
  const callbacks: IdleRequestCallback[] = []
  const request = vi.fn((callback: IdleRequestCallback, _options?: IdleRequestOptions) => {
    callbacks.push(callback)
    return callbacks.length
  })
  const cancel = vi.fn()
  Object.assign(window as IdleWindow, { requestIdleCallback: request, cancelIdleCallback: cancel })
  const runIdle = () => {
    for (const callback of callbacks.splice(0))
      callback({ didTimeout: false, timeRemaining: () => 10 })
  }
  return { request, cancel, runIdle }
}

afterEach(() => {
  delete (window as IdleWindow).requestIdleCallback
  delete (window as IdleWindow).cancelIdleCallback
})

describe('preloadWhenIdle', () => {
  it('waits for an idle moment, with a deadline, before it loads', () => {
    const idle = stubIdle()
    const load = vi.fn(() => Promise.resolve())

    preloadWhenIdle(load)

    expect(load).not.toHaveBeenCalled()
    expect(idle.request).toHaveBeenCalledWith(expect.any(Function), { timeout: 4000 })
    idle.runIdle()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('drops a failed load, which the surface retries when it opens', async () => {
    const idle = stubIdle()
    const load = vi.fn(() => Promise.reject(new Error('chunk missing')))

    preloadWhenIdle(load)
    idle.runIdle()
    // An unhandled rejection would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('cancels a preload that has not started', () => {
    const idle = stubIdle()
    const load = vi.fn(() => Promise.resolve())

    const cancel = preloadWhenIdle(load)
    cancel()

    expect(idle.cancel).toHaveBeenCalledWith(1)
  })

  it('preloads nothing where the DOM has no idle callbacks', () => {
    const load = vi.fn(() => Promise.resolve())

    preloadWhenIdle(load)()

    expect(load).not.toHaveBeenCalled()
  })
})
