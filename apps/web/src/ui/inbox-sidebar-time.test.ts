import { describe, expect, it } from 'vitest'
import {
  elapsedTime,
  localDateTimeValue,
  parseCustomSnooze,
  relativeTime,
  snoozePresets,
  wakeCountdown,
} from './inbox-sidebar-time.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('thread sidebar time labels', () => {
  it('uses compact labels for elapsed, past, and remaining time', () => {
    expect(elapsedTime(0, 42_000)).toBe('42s')
    expect(elapsedTime(0, 5 * MINUTE)).toBe('5m')
    expect(elapsedTime(0, HOUR + 3 * MINUTE)).toBe('1h 3m')

    expect(relativeTime(0, 20_000)).toBe('now')
    expect(relativeTime(0, 6 * HOUR)).toBe('6h')
    expect(relativeTime(0, 3 * DAY)).toBe('3d')

    // A countdown rounds up, so a hidden thread never reads "0m".
    expect(wakeCountdown(10_000, 0)).toBe('1m')
    expect(wakeCountdown(3 * HOUR - MINUTE, 0)).toBe('3h')
    expect(wakeCountdown(2 * DAY, 0)).toBe('2d')
    expect(wakeCountdown(0, 10)).toBe('now')
  })

  it('offers this evening only while it is more than an hour away', () => {
    const noonFriday = new Date(2026, 7, 21, 12).getTime()
    expect(snoozePresets(noonFriday).map((preset) => preset.id)).toEqual([
      'hour',
      'three-hours',
      'evening',
      'tomorrow',
      'next-week',
    ])

    const lateFriday = new Date(2026, 7, 21, 17, 30).getTime()
    expect(snoozePresets(lateFriday).some((preset) => preset.id === 'evening')).toBe(false)

    // Sunday: tomorrow and next week are the same Monday morning, listed once.
    const sunday = new Date(2026, 7, 23, 12).getTime()
    const presets = snoozePresets(sunday)
    expect(presets.some((preset) => preset.id === 'next-week')).toBe(false)
    expect(new Date(presets.at(-1)!.at).getDay()).toBe(1)
  })

  it('accepts only future local times for a custom snooze', () => {
    const now = new Date(2026, 7, 21, 12).getTime()
    const tomorrow = now + DAY
    expect(parseCustomSnooze(localDateTimeValue(tomorrow), now)).toBe(tomorrow)
    expect(parseCustomSnooze(localDateTimeValue(now - HOUR), now)).toBeUndefined()
    expect(parseCustomSnooze('2026-02-30T09:00', now)).toBeUndefined()
    expect(parseCustomSnooze('tomorrow', now)).toBeUndefined()
  })
})
