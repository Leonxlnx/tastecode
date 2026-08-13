// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HAPTICS_KEY,
  LEGACY_HAPTICS_KEY,
  readAppHaptics,
  ResizeHaptics,
  subscribeAppHaptics,
  writeAppHaptics,
} from './haptics.js'

afterEach(() => {
  vi.restoreAllMocks()
  writeAppHaptics(true)
  localStorage.clear()
})

describe('app haptic preference', () => {
  it('defaults on and persists an opt-out', () => {
    expect(readAppHaptics()).toBe(true)

    writeAppHaptics(false)

    expect(localStorage.getItem(HAPTICS_KEY)).toBe('false')
    expect(readAppHaptics()).toBe(false)
  })

  it('honors the original sidebar preference and migrates on the next write', () => {
    localStorage.setItem(LEGACY_HAPTICS_KEY, 'false')

    expect(readAppHaptics()).toBe(false)
    writeAppHaptics(true)

    expect(localStorage.getItem(HAPTICS_KEY)).toBe('true')
    expect(localStorage.getItem(LEGACY_HAPTICS_KEY)).toBeNull()
  })

  it('keeps the session choice when persistent storage is blocked', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })
    const onChange = vi.fn()
    const unsubscribe = subscribeAppHaptics(onChange)

    writeAppHaptics(false)

    expect(readAppHaptics()).toBe(false)
    expect(onChange).toHaveBeenCalledOnce()
    unsubscribe()
  })
})

describe('resize haptic detents', () => {
  const createHaptics = (startValue = 240) =>
    new ResizeHaptics({
      startValue,
      startTime: 0,
      minValue: 240,
      maxValue: 420,
    })

  const sample = (haptics: ResizeHaptics, rawValue: number, time: number, tracking = true) =>
    haptics.sample({
      rawValue,
      value: Math.min(420, Math.max(240, Math.round(rawValue))),
      tracking,
      time,
    })

  it('adapts detent density to drag velocity', () => {
    const slow = createHaptics()
    const slowFeedback = []
    let slowTime = 0
    for (let value = 244; value <= 400; value += 4) {
      slowTime += 20
      if (sample(slow, value, slowTime)) slowFeedback.push(value)
    }

    const fast = createHaptics()
    const fastFeedback = []
    let fastTime = 0
    for (let value = 260; value <= 400; value += 20) {
      fastTime += 10
      if (sample(fast, value, fastTime)) fastFeedback.push(value)
    }

    expect(slowFeedback).toHaveLength(10)
    expect(fastFeedback).toHaveLength(4)
  })

  it('uses hysteresis and quiet zones to prevent chatter around stops', () => {
    const detents = createHaptics(284)
    expect(sample(detents, 289, 20)).toBe('alignment')
    expect(sample(detents, 287, 25)).toBeUndefined()
    expect(sample(detents, 290, 30)).toBeUndefined()
    expect(sample(detents, 296, 50)).toBeUndefined()
    expect(sample(detents, 287, 80)).toBe('alignment')

    const boundary = createHaptics(248)
    expect(sample(boundary, 239, 20)).toBe('alignment')
    expect(sample(boundary, 241, 30)).toBeUndefined()
    expect(sample(boundary, 239, 40)).toBeUndefined()
    expect(sample(boundary, 248, 70)).toBeUndefined()
    expect(sample(boundary, 239, 100)).toBe('alignment')

    const maximum = createHaptics(410)
    expect(sample(maximum, 421, 20)).toBe('alignment')
    expect(sample(maximum, 419, 30)).toBeUndefined()
    expect(sample(maximum, 421, 40)).toBeUndefined()
    expect(sample(maximum, 410, 70)).toBeUndefined()
    expect(sample(maximum, 421, 100)).toBe('alignment')
  })

  it('updates its filter without firing while the surface is clamped or settling', () => {
    const haptics = createHaptics(250)

    expect(sample(haptics, 239, 20)).toBe('alignment')
    expect(sample(haptics, 200, 80, false)).toBeUndefined()
    expect(sample(haptics, 168, 130, false)).toBeUndefined()
    expect(sample(haptics, 145, 280, false)).toBeUndefined()

    const settling = createHaptics(280)
    expect(sample(settling, 304, 20, false)).toBeUndefined()
    expect(sample(settling, 320, 40, false)).toBeUndefined()
    expect(sample(settling, 321, 60)).toBeUndefined()
  })
})
