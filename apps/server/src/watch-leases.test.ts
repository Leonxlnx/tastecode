import { describe, expect, it, vi } from 'vitest'
import { WatchLeases } from './watch-leases.js'

describe('provider watch leases', () => {
  it('expires abandoned settings reads and extends only the visible project', () => {
    vi.useFakeTimers()
    try {
      const watches = new WatchLeases(60_000)
      watches.add('closed view')
      watches.add('visible view')
      vi.advanceTimersByTime(30_000)
      watches.add('visible view')
      vi.advanceTimersByTime(30_001)
      expect([...watches]).toEqual(['visible view'])
      expect(watches.size).toBe(1)
      vi.advanceTimersByTime(30_000)
      expect(watches.size).toBe(0)
      expect(watches.nextExpiry).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
