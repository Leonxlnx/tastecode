import { afterEach, describe, expect, it, vi } from 'vitest'
import { LifecycleScheduler } from './lifecycle-scheduler.js'

afterEach(() => vi.useRealTimers())

describe('LifecycleScheduler', () => {
  it('has no idle timer when no lifecycle deadline exists', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const scheduler = new LifecycleScheduler(refresh, () => undefined)

    scheduler.refreshNow()

    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wakes exactly at the next deadline and reschedules', async () => {
    vi.useFakeTimers({ now: 1_000 })
    let nextAt: number | undefined = 1_500
    const refresh = vi.fn(() => {
      nextAt = undefined
    })
    const scheduler = new LifecycleScheduler(refresh, () => nextAt)

    scheduler.changed()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a due but blocked thread without a tight timer loop', async () => {
    vi.useFakeTimers({ now: 10_000 })
    const refresh = vi.fn()
    const scheduler = new LifecycleScheduler(refresh, () => 9_000)

    scheduler.refreshNow()
    expect(vi.getTimerCount()).toBe(1)
    scheduler.refreshIfDue()
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    scheduler.dispose()
  })

  it('moves an existing timer when persisted state changes', async () => {
    vi.useFakeTimers({ now: 1_000 })
    let nextAt = 10_000
    const refresh = vi.fn(() => {
      nextAt = 20_000
    })
    const scheduler = new LifecycleScheduler(refresh, () => nextAt)

    scheduler.changed()
    nextAt = 2_000
    scheduler.changed()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(refresh).toHaveBeenCalledOnce()
    scheduler.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps an existing earlier timer when a deadline moves later', async () => {
    vi.useFakeTimers({ now: 1_000 })
    let nextAt: number | undefined = 2_000
    const refresh = vi.fn(() => {
      nextAt = undefined
    })
    const scheduler = new LifecycleScheduler(refresh, () => nextAt)

    scheduler.changed()
    nextAt = 3_000
    scheduler.changed()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reread a known schedule for later-only changes', () => {
    vi.useFakeTimers({ now: 1_000 })
    const nextAt = vi.fn(() => 2_000)
    const scheduler = new LifecycleScheduler(() => {}, nextAt)

    scheduler.changed()
    scheduler.changedLater()
    scheduler.changedLater()

    expect(nextAt).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    scheduler.dispose()
  })

  it('keeps a known empty schedule empty after later-only changes', () => {
    vi.useFakeTimers()
    const nextAt = vi.fn(() => undefined)
    const scheduler = new LifecycleScheduler(() => {}, nextAt)

    scheduler.refreshNow()
    scheduler.changedLater()

    expect(nextAt).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('adds a known deadline without rereading persisted deadlines', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const refresh = vi.fn()
    const nextAt = vi.fn(() => undefined)
    const scheduler = new LifecycleScheduler(refresh, nextAt)
    scheduler.refreshNow()

    scheduler.deadlineAdded(2_000)

    expect(nextAt).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(999)
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('keeps an earlier known deadline when a later deadline is added', async () => {
    vi.useFakeTimers({ now: 1_000 })
    let nextAt: number | undefined = 2_000
    const refresh = vi.fn(() => {
      nextAt = undefined
    })
    const readNextAt = vi.fn(() => nextAt)
    const scheduler = new LifecycleScheduler(refresh, readNextAt)
    scheduler.changed()

    scheduler.deadlineAdded(3_000)

    expect(readNextAt).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('moves a later timer when an earlier deadline is added', async () => {
    vi.useFakeTimers({ now: 1_000 })
    let nextAt: number | undefined = 3_000
    const refresh = vi.fn(() => {
      nextAt = undefined
    })
    const readNextAt = vi.fn(() => nextAt)
    const scheduler = new LifecycleScheduler(refresh, readNextAt)
    scheduler.changed()

    scheduler.deadlineAdded(2_000)

    expect(readNextAt).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('falls back to the exact schedule before the first schedule read', () => {
    vi.useFakeTimers({ now: 1_000 })
    const nextAt = vi.fn(() => 2_000)
    const scheduler = new LifecycleScheduler(() => {}, nextAt)

    scheduler.deadlineAdded(3_000)

    expect(nextAt).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    scheduler.dispose()
  })

  it('skips early sidebar refreshes but catches an overdue timer', () => {
    vi.useFakeTimers({ now: 1_000 })
    let nextAt: number | undefined = 2_000
    const refresh = vi.fn(() => {
      nextAt = undefined
    })
    const scheduler = new LifecycleScheduler(refresh, () => nextAt)

    scheduler.changed()
    scheduler.refreshIfDue()
    expect(refresh).not.toHaveBeenCalled()

    vi.setSystemTime(2_000)
    scheduler.refreshIfDue()
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
