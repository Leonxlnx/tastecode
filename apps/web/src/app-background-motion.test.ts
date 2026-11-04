// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addMotionSink,
  EFFECT_SHADERS,
  effectCanvasSize,
  motionSeconds,
  parseCssColor,
  resetEffectMotionForTests,
} from './app-background-motion.js'

let focused = true
let visibility: DocumentVisibilityState = 'visible'
let reduced = false
const mediaListeners = new Set<() => void>()

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  })
  focused = true
  visibility = 'visible'
  reduced = false
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return reduced
    },
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  }))
})

afterEach(() => {
  resetEffectMotionForTests()
  mediaListeners.clear()
  Reflect.deleteProperty(document, 'hasFocus')
  Reflect.deleteProperty(document, 'visibilityState')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function recordingSink() {
  const frames: number[] = []
  return { frames, draw: (seconds: number) => frames.push(seconds) }
}

describe('the effect clock', () => {
  it('draws a new sink at once, then about 30 times a second', () => {
    const sink = recordingSink()
    const remove = addMotionSink(sink)
    expect(sink.frames).toEqual([0])

    vi.advanceTimersByTime(1000)
    // The first frame starts the clock; it then runs as long as the frames do.
    expect(sink.frames.length - 1).toBeGreaterThanOrEqual(27)
    expect(sink.frames.length - 1).toBeLessThanOrEqual(33)
    expect(motionSeconds()).toBeGreaterThan(0.9)
    expect(motionSeconds()).toBeLessThanOrEqual(1)
    expect(sink.frames).toEqual([...sink.frames].sort((a, b) => a - b))

    remove()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops while the window is out of focus and picks up where it stopped', () => {
    const sink = recordingSink()
    addMotionSink(sink)
    vi.advanceTimersByTime(500)
    focused = false
    window.dispatchEvent(new Event('blur'))
    vi.advanceTimersByTime(40)
    const stoppedAt = motionSeconds()
    const drawn = sink.frames.length

    vi.advanceTimersByTime(5000)
    expect(sink.frames).toHaveLength(drawn)
    expect(vi.getTimerCount()).toBe(0)

    focused = true
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(100)
    expect(sink.frames.length).toBeGreaterThan(drawn)
    // Five seconds out of focus did not move the effect.
    expect(motionSeconds() - stoppedAt).toBeLessThan(0.15)
  })

  it('keeps moving while focus is inside a frame on the page', () => {
    const sink = recordingSink()
    addMotionSink(sink)
    vi.advanceTimersByTime(100)
    // A preview iframe took focus: the window blurs, the document still has it.
    window.dispatchEvent(new Event('blur'))
    const drawn = sink.frames.length
    vi.advanceTimersByTime(500)
    expect(sink.frames.length).toBeGreaterThan(drawn + 10)
  })

  it('stops while the window is hidden', () => {
    const sink = recordingSink()
    addMotionSink(sink)
    vi.advanceTimersByTime(200)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    const drawn = sink.frames.length
    vi.advanceTimersByTime(2000)
    expect(sink.frames).toHaveLength(drawn)

    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(200)
    expect(sink.frames.length).toBeGreaterThan(drawn)
  })

  it('stands still with reduced motion, and follows the setting when it changes', () => {
    reduced = true
    const sink = recordingSink()
    addMotionSink(sink)
    vi.advanceTimersByTime(2000)
    expect(sink.frames).toEqual([0])
    expect(vi.getTimerCount()).toBe(0)

    reduced = false
    for (const listener of mediaListeners) listener()
    vi.advanceTimersByTime(200)
    expect(sink.frames.length).toBeGreaterThan(3)

    reduced = true
    for (const listener of mediaListeners) listener()
    const drawn = sink.frames.length
    vi.advanceTimersByTime(1000)
    expect(sink.frames).toHaveLength(drawn)
  })

  it('shares one clock between canvases and stops with the last', () => {
    const window1 = recordingSink()
    const preview = recordingSink()
    const removeWindow = addMotionSink(window1)
    vi.advanceTimersByTime(300)
    const removePreview = addMotionSink(preview)
    // The preview starts where the window's effect already is.
    expect(preview.frames[0]).toBe(motionSeconds())
    vi.advanceTimersByTime(100)
    expect(preview.frames.at(-1)).toBe(window1.frames.at(-1))

    removeWindow()
    vi.advanceTimersByTime(100)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    removePreview()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the effect canvas', () => {
  it('draws Dither one buffer pixel per cell, scaled down with the preview', () => {
    expect(effectCanvasSize('dither', 1200, 1, 1.5)).toEqual({
      width: 600,
      height: 224,
      cssWidth: 1200,
      cssHeight: 448,
      unit: 0.5,
    })
    expect(effectCanvasSize('dither', 1201, 1, 1)).toMatchObject({ width: 601, cssWidth: 1202 })
    // A preview half the window's size: one CSS pixel a cell, half the band.
    expect(effectCanvasSize('dither', 600, 0.5, 2)).toEqual({
      width: 600,
      height: 224,
      cssWidth: 600,
      cssHeight: 224,
      unit: 0.5,
    })
  })

  it('draws Halftone at the screen pixels, up to two per CSS pixel', () => {
    expect(effectCanvasSize('halftone', 1200, 1, 1.5)).toEqual({
      width: 1800,
      height: 672,
      cssWidth: 1200,
      cssHeight: 448,
      unit: 1.5,
    })
    expect(effectCanvasSize('halftone', 1200, 1, 3)).toMatchObject({ width: 2400, unit: 2 })
    expect(effectCanvasSize('halftone', 600, 0.5, 1)).toEqual({
      width: 600,
      height: 224,
      cssWidth: 600,
      cssHeight: 224,
      unit: 0.5,
    })
  })

  it('builds each shader from the still tiles’ own numbers', () => {
    expect(EFFECT_SHADERS.dither).toContain('cell.y / 224.0')
    expect(EFFECT_SHADERS.dither).toContain('0.6 * fade')
    expect(EFFECT_SHADERS.halftone).toContain('centre.y / 448.0')
    expect(EFFECT_SHADERS.halftone).toContain('3.4 * fade')
    for (const source of Object.values(EFFECT_SHADERS)) {
      expect(source).toContain('uniform float u_time;')
      expect(source).toContain('gl_FragColor = vec4(u_color, 1.0) *')
    }
  })

  it('reads the computed text colour', () => {
    expect(parseCssColor('rgb(255, 0, 51)')).toEqual([1, 0, 0.2])
    expect(parseCssColor('rgba(0, 255, 0, 0.5)')).toEqual([0, 1, 0])
    expect(parseCssColor('color(srgb 0.25 0.5 1)')).toEqual([0.25, 0.5, 1])
    expect(parseCssColor('oklch(0.5 0.1 200)')).toBeUndefined()
  })
})
