import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { needsCompositorNudge, startVisibilityWatchdog } from './window-visibility-watchdog.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('needsCompositorNudge', () => {
  it('fires only on the visible-but-hidden mismatch', () => {
    const base = { destroyed: false, visible: true, minimized: false, pageVisibility: 'hidden' }
    expect(needsCompositorNudge(base)).toBe(true)
    expect(needsCompositorNudge({ ...base, pageVisibility: 'visible' })).toBe(false)
    expect(needsCompositorNudge({ ...base, minimized: true })).toBe(false)
    expect(needsCompositorNudge({ ...base, visible: false })).toBe(false)
    expect(needsCompositorNudge({ ...base, destroyed: true })).toBe(false)
  })
})

describe('startVisibilityWatchdog', () => {
  function fakeWindow(pageVisibility: () => string) {
    return {
      destroyed: false,
      hidden: 0,
      shown: 0,
      isDestroyed() {
        return this.destroyed
      },
      isVisible: () => true,
      isMinimized: () => false,
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
})
