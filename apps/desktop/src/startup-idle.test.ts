import { afterEach, describe, expect, it, vi } from 'vitest'
import { StartupIdleGate } from './startup-idle.js'

afterEach(() => vi.useRealTimers())

describe('startup idle memory capture', () => {
  it('waits for both the interactive screen and completed requests', async () => {
    vi.useFakeTimers()
    const capture = vi.fn()
    const gate = new StartupIdleGate(2_000, capture)
    gate.ready()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(capture).not.toHaveBeenCalled()
    gate.setIdle(true)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(capture).toHaveBeenCalledOnce()
    expect(gate.interrupted).toBe(false)
  })

  it('does not start when requests finish before the screen is ready', async () => {
    vi.useFakeTimers()
    const capture = vi.fn()
    const gate = new StartupIdleGate(2_000, capture)
    gate.setIdle(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(capture).not.toHaveBeenCalled()
    gate.ready()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(capture).toHaveBeenCalledOnce()
  })

  it('restarts the quiet delay when a response causes another request', async () => {
    vi.useFakeTimers()
    const capture = vi.fn()
    const gate = new StartupIdleGate(2_000, capture)
    gate.ready()
    gate.setIdle(true)
    await vi.advanceTimersByTimeAsync(1_000)
    gate.setIdle(false)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(capture).not.toHaveBeenCalled()
    gate.setIdle(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(capture).toHaveBeenCalledOnce()
  })

  it('invalidates capture if work resumes, without retrying until a pass', async () => {
    vi.useFakeTimers()
    const capture = vi.fn()
    const gate = new StartupIdleGate(2_000, capture)
    gate.ready()
    gate.setIdle(true)
    await vi.advanceTimersByTimeAsync(2_000)
    gate.setIdle(false)
    gate.setIdle(true)
    gate.ready()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(gate.interrupted).toBe(true)
    expect(capture).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
