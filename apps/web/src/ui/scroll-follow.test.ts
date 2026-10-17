import { describe, expect, it } from 'vitest'
import { createFollowGlide, FOLLOW_SMOOTH_MS, smoothDamp } from './scroll-follow.js'

function glideWith(pixelRatio = 1) {
  const frames: FrameRequestCallback[] = []
  const writes: number[] = []
  let now = 0
  const glide = createFollowGlide({
    write: (top) => writes.push(top),
    pixelRatio: () => pixelRatio,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: () => frames.splice(0),
  })
  const frame = (ms = 16) => {
    now += ms
    for (const callback of frames.splice(0)) callback(now)
  }
  const settle = () => {
    for (let count = 0; count < 500 && frames.length > 0; count += 1) frame()
  }
  return { glide, frames, writes, frame, settle }
}

describe('smoothDamp', () => {
  it('approaches the target without ever crossing it, whatever the step', () => {
    for (const dt of [4, 7, 16, 32]) {
      let state = { pos: 0, vel: 0 }
      let previous = 0
      for (let step = 0; step < 400; step += 1) {
        state = smoothDamp(state.pos, 100, state.vel, FOLLOW_SMOOTH_MS, dt)
        expect(state.pos).toBeGreaterThanOrEqual(previous)
        expect(state.pos).toBeLessThanOrEqual(100)
        previous = state.pos
      }
      expect(state.pos).toBeCloseTo(100, 3)
    }
  })

  it('stops at the target instead of carrying its speed past it', () => {
    const state = smoothDamp(99, 100, 2, FOLLOW_SMOOTH_MS, 16)
    expect(state).toEqual({ pos: 100, vel: 0 })
  })
})

describe('createFollowGlide', () => {
  it('leaves rest gently and lands exactly on the target', () => {
    const { glide, writes, settle } = glideWith()
    glide.setTarget(1_020, 1_000)
    settle()

    const steps = writes.map((top, index) => top - (index === 0 ? 1_000 : writes[index - 1]!))
    expect(steps[0]).toBeLessThanOrEqual(1)
    expect(Math.max(...steps)).toBeLessThanOrEqual(3)
    expect(steps.every((step) => step > 0)).toBe(true)
    expect(writes.at(-1)).toBe(1_020)
    expect(glide.running).toBe(false)
  })

  it('writes on the device-pixel grid and skips steps smaller than a device pixel', () => {
    const { glide, writes, settle } = glideWith(1.5)
    glide.setTarget(1_010, 1_000)
    settle()

    for (const top of writes.slice(0, -1))
      expect(Math.abs(top * 1.5 - Math.round(top * 1.5))).toBe(0)
    expect(new Set(writes).size).toBe(writes.length)
  })

  it('keeps its speed when the target moves while under way', () => {
    const { glide, writes, frame, settle } = glideWith()
    glide.setTarget(1_100, 1_000)
    for (let count = 0; count < 6; count += 1) frame()
    const before = writes.at(-1)! - writes.at(-2)!

    glide.setTarget(1_200, 0)
    frame()

    expect(writes.at(-1)! - writes.at(-2)!).toBeGreaterThanOrEqual(before)
    settle()
    expect(writes.at(-1)).toBe(1_200)
  })

  it('continues from where another writer moved the scroll', () => {
    const { glide, writes, frame, settle } = glideWith()
    glide.setTarget(1_100, 1_000)
    frame()
    glide.sync(1_090)
    frame()

    expect(writes.at(-1)).toBeGreaterThan(1_090)
    settle()
    expect(writes.at(-1)).toBe(1_100)
  })

  it('lands in a bounded number of frames when they arrive back to back', () => {
    const { glide, frames, writes, frame } = glideWith()
    glide.setTarget(1_200, 1_000)
    let count = 0
    while (frames.length > 0 && count < 1_000) {
      frame(0.01)
      count += 1
    }

    expect(count).toBeLessThan(60)
    expect(writes.at(-1)).toBe(1_200)
  })

  it('stops on request', () => {
    const { glide, frames, writes, frame } = glideWith()
    glide.setTarget(1_100, 1_000)
    frame()
    const count = writes.length

    glide.stop()
    frame()

    expect(glide.running).toBe(false)
    expect(frames).toHaveLength(0)
    expect(writes).toHaveLength(count)
  })
})
