import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { needsCompositorNudge, startVisibilityWatchdog } from './window-visibility-watchdog.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('needsCompositorNudge', () => {
  it('fires only on the visible-but-hidden mismatch', () => {
    const base = {
      destroyed: false,
      visible: true,
      minimized: false,
      focused: true,
      pageVisibility: 'hidden',
    }
    expect(needsCompositorNudge(base)).toBe(true)
    expect(needsCompositorNudge({ ...base, pageVisibility: 'visible' })).toBe(false)
    expect(needsCompositorNudge({ ...base, minimized: true })).toBe(false)
    expect(needsCompositorNudge({ ...base, visible: false })).toBe(false)
    expect(needsCompositorNudge({ ...base, focused: false })).toBe(false)
    expect(needsCompositorNudge({ ...base, destroyed: true })).toBe(false)
  })
})

describe('startVisibilityWatchdog', () => {
  function fakeWindow(pageVisibility: () => string) {
    const readVisibility = vi.fn(pageVisibility)
    return {
      destroyed: false,
      hidden: 0,
      shown: 0,
      readVisibility,
      isDestroyed() {
        return this.destroyed
      },
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
      hide() {
        this.hidden += 1
      },
      show() {
        this.shown += 1
      },
      webContents: {
        mainFrame: {
          get visibilityState() {
            return readVisibility()
          },
        },
        executeJavaScript: vi.fn(),
      },
    }
  }

  it('heals a stuck window and leaves a healthy one alone', async () => {
    let state = 'visible'
    const window = fakeWindow(() => state)
    const logs: string[] = []
    const stop = startVisibilityWatchdog(window, (line) => logs.push(line), 1_000, 'win32')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(window.hidden).toBe(0)

    state = 'hidden'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(window.hidden).toBe(1)
    expect(window.shown).toBe(1)
    expect(logs).toHaveLength(1)

    stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(window.hidden).toBe(1)
  })

  it('uses 240 native frame reads without waking the renderer during a focused hour', async () => {
    const window = fakeWindow(() => 'visible')
    const stop = startVisibilityWatchdog(window, () => {}, 15_000, 'win32')

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000)

    expect(window.readVisibility).toHaveBeenCalledTimes(240)
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled()
    stop()
  })

  it('stays quiet once the window is destroyed', async () => {
    const window = fakeWindow(() => 'hidden')
    window.destroyed = true
    const stop = startVisibilityWatchdog(window, () => {}, 1_000, 'win32')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(window.hidden).toBe(0)
    stop()
  })

  it('reschedules after a frame visibility read fails', async () => {
    let reads = 0
    const window = fakeWindow(() => {
      reads += 1
      if (reads === 1) throw new Error('frame replaced')
      return 'hidden'
    })
    const stop = startVisibilityWatchdog(window, () => {}, 1_000, 'win32')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(window.hidden).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(window.hidden).toBe(1)
    expect(window.readVisibility).toHaveBeenCalledTimes(2)
    stop()
  })

  it('only nudges the focused window when two are watched', async () => {
    const focused = fakeWindow(() => 'hidden')
    const background = fakeWindow(() => 'hidden')
    background.isFocused = () => false
    const stopFocused = startVisibilityWatchdog(focused, () => {}, 1_000, 'win32')
    const stopBackground = startVisibilityWatchdog(background, () => {}, 1_000, 'win32')

    await vi.advanceTimersByTimeAsync(1_000)

    expect(focused.hidden).toBe(1)
    expect(background.hidden).toBe(0)
    expect(background.readVisibility).not.toHaveBeenCalled()
    stopFocused()
    stopBackground()
  })

  it('leaves no watchdog timer while an evented window is in the background', async () => {
    const listeners = new Map<string, Set<() => void>>()
    const window = fakeWindow(() => 'visible')
    let focused = false
    window.isFocused = () => focused
    Object.assign(window, {
      on(event: string, listener: () => void) {
        const group = listeners.get(event) ?? new Set()
        group.add(listener)
        listeners.set(event, group)
      },
      removeListener(event: string, listener: () => void) {
        listeners.get(event)?.delete(listener)
      },
    })
    const stop = startVisibilityWatchdog(window, () => {}, 1_000, 'win32')

    expect(vi.getTimerCount()).toBe(0)
    focused = true
    for (const listener of listeners.get('focus') ?? []) listener()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(window.readVisibility).toHaveBeenCalledOnce()

    focused = false
    for (const listener of listeners.get('blur') ?? []) listener()
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('never wakes the renderer outside Windows', () => {
    const window = fakeWindow(() => 'hidden')
    const stop = startVisibilityWatchdog(window, () => {}, 1_000, 'darwin')

    vi.advanceTimersByTime(10_000)

    expect(window.readVisibility).not.toHaveBeenCalled()
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled()
    stop()
  })
})
