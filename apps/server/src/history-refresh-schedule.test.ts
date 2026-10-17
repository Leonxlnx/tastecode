import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HISTORY_REFRESH_MAX_MS,
  HISTORY_REFRESH_MIN_MS,
  HistoryRefreshSchedule,
} from './history-refresh-schedule.js'

describe('provider-history refresh schedule', () => {
  let changes: boolean[]
  let refresh: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  let schedule: HistoryRefreshSchedule

  beforeEach(() => {
    vi.useFakeTimers()
    changes = []
    refresh = vi.fn(async () => changes.shift() ?? false)
    schedule = new HistoryRefreshSchedule(refresh)
  })

  afterEach(() => {
    schedule.stop()
    vi.useRealTimers()
  })

  /** Advance by `ms` and report how many refreshes ran in that time. */
  async function runsIn(ms: number): Promise<number> {
    const before = refresh.mock.calls.length
    await vi.advanceTimersByTimeAsync(ms)
    return refresh.mock.calls.length - before
  }

  it('slows from 15 s to 2 min while nothing changes', async () => {
    schedule.start()
    const waits: number[] = []
    for (let index = 0; index < 6; index += 1) {
      waits.push(schedule.delay)
      expect(await runsIn(schedule.delay - 1)).toBe(0)
      expect(await runsIn(1)).toBe(1)
    }
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000])
    expect(schedule.delay).toBe(HISTORY_REFRESH_MAX_MS)
  })

  it('keeps the fast cadence after a refresh that found a change', async () => {
    schedule.start()
    await runsIn(HISTORY_REFRESH_MIN_MS)
    expect(schedule.delay).toBe(30_000)
    changes.push(true)
    await runsIn(30_000)
    expect(schedule.delay).toBe(HISTORY_REFRESH_MIN_MS)
    expect(await runsIn(HISTORY_REFRESH_MIN_MS)).toBe(1)
  })

  it('comes back to 15 s when a client becomes active', async () => {
    schedule.start()
    for (let index = 0; index < 4; index += 1) await runsIn(schedule.delay)
    expect(schedule.delay).toBe(HISTORY_REFRESH_MAX_MS)
    await runsIn(10_000)

    schedule.activity()
    expect(await runsIn(HISTORY_REFRESH_MIN_MS - 1)).toBe(0)
    expect(await runsIn(1)).toBe(1)
    // Activity does not postpone a refresh that is already due sooner.
    await runsIn(20_000)
    schedule.activity()
    expect(await runsIn(10_000)).toBe(1)
  })

  it('treats activity during a refresh as a reason to stay fast', async () => {
    let finish!: (changed: boolean) => void
    refresh.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)))
    schedule.start()
    await runsIn(HISTORY_REFRESH_MIN_MS)
    schedule.activity()
    finish(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(schedule.delay).toBe(HISTORY_REFRESH_MIN_MS)
  })

  it('counts a failed refresh as no change and keeps going', async () => {
    refresh.mockRejectedValueOnce(new Error('locked'))
    schedule.start()
    expect(await runsIn(HISTORY_REFRESH_MIN_MS)).toBe(1)
    expect(await runsIn(30_000)).toBe(1)
  })

  it('runs nothing after stop, even when a client asks', async () => {
    schedule.start()
    schedule.stop()
    schedule.activity()
    expect(await runsIn(HISTORY_REFRESH_MAX_MS * 2)).toBe(0)
  })
})
