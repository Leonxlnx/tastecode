// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compactRelativeTime, readSessionClock, subscribeSessionClock } from './session-clock.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('compactRelativeTime', () => {
  const now = Date.UTC(2026, 9, 12, 12)
  const ago = (ms: number) => compactRelativeTime(now - ms, now)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  it('stays short enough to sit beside a chat title', () => {
    expect(ago(0)).toBe('now')
    expect(ago(59_999)).toBe('now')
    expect(ago(minute)).toBe('1m')
    expect(ago(59 * minute)).toBe('59m')
    expect(ago(hour)).toBe('1h')
    expect(ago(23 * hour)).toBe('23h')
    expect(ago(day)).toBe('1d')
    expect(ago(6 * day)).toBe('6d')
    expect(ago(7 * day)).toBe('1w')
    expect(ago(29 * day)).toBe('4w')
    expect(ago(30 * day)).toBe('1mo')
    expect(ago(364 * day)).toBe('12mo')
    expect(ago(365 * day)).toBe('1y')
  })

  it('reads a timestamp from the future as now', () => {
    expect(compactRelativeTime(now + hour, now)).toBe('now')
  })
})

describe('session clock', () => {
  it('runs one interval only while a row listens', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 12, 12) })
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = subscribeSessionClock(first)
    const stopSecond = subscribeSessionClock(second)
    expect(vi.getTimerCount()).toBe(1)

    const before = readSessionClock()
    vi.advanceTimersByTime(30_000)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(readSessionClock()).toBe(before + 30_000)

    stopFirst()
    expect(vi.getTimerCount()).toBe(1)
    stopSecond()
    expect(vi.getTimerCount()).toBe(0)
  })
})
