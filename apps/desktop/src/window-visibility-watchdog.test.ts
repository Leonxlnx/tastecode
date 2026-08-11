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
  function fakeWindow(pageVisibility: () => string | Promise<string>) {
    return {
      destroyed: false,
      hidden: 0,
      shown: 0,
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
        executeJavaScript: async () => pageVisibility(),
      },
    }
  }

  it('heals a stuck window and leaves a healthy one alone', async () => {
    let state = 'visible'
    const window = fakeWindow(() => state)
    const logs: string[] = []
    const stop = startVisibilityWatchdog(window, (line) => logs.push(line), 1_000)

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

  it('stays quiet once the window is destroyed', async () => {
    const window = fakeWindow(() => 'hidden')
    window.destroyed = true
    const stop = startVisibilityWatchdog(window, () => {}, 1_000)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(window.hidden).toBe(0)
    stop()
  })

  it('does not finish an in-flight check after it is stopped', async () => {
    let finishCheck!: (visibility: string) => void
    const visibility = new Promise<string>((resolve) => {
      finishCheck = resolve
    })
    const window = fakeWindow(() => visibility)
    const isVisible = vi.spyOn(window, 'isVisible')
    const stop = startVisibilityWatchdog(window, () => {}, 1_000)

    vi.advanceTimersByTime(1_000)
    stop()
    finishCheck('hidden')
    await vi.runAllTimersAsync()

    expect(isVisible).not.toHaveBeenCalled()
    expect(window.hidden).toBe(0)
  })

  it('only nudges the focused window when two are watched', async () => {
    const focused = fakeWindow(() => 'hidden')
    const background = fakeWindow(() => 'hidden')
    background.isFocused = () => false
    const stopFocused = startVisibilityWatchdog(focused, () => {}, 1_000)
    const stopBackground = startVisibilityWatchdog(background, () => {}, 1_000)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(focused.hidden).toBe(1)
    expect(background.hidden).toBe(0)
    stopFocused()
    stopBackground()
  })
})
