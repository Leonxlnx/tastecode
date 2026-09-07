import { EventEmitter } from 'node:events'
import type { Rectangle } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseMainWindowState,
  persistMainWindowState,
  restoreMainWindowState,
  type MainWindowState,
} from './window-state.js'

const fallbackSize = { width: 1180, height: 820 }
const minimumSize = { width: 720, height: 520 }
const workArea = { x: 0, y: 25, width: 1440, height: 875 }

class WindowDouble extends EventEmitter {
  bounds: Rectangle = { x: 100, y: 80, width: 1180, height: 820 }

  getNormalBounds(): Rectangle {
    return this.bounds
  }
}

function savedState(overrides: Partial<MainWindowState> = {}): MainWindowState {
  return {
    version: 1,
    bounds: { x: 100, y: 80, width: 1180, height: 820 },
    fullScreen: false,
    maximized: false,
    ...overrides,
  }
}

afterEach(() => vi.useRealTimers())

describe('main window state', () => {
  it('accepts valid saved state and rejects malformed bounds', () => {
    expect(parseMainWindowState(savedState({ fullScreen: true }))).toEqual(
      savedState({ fullScreen: true }),
    )
    expect(parseMainWindowState({ ...savedState(), bounds: { width: 0 } })).toBeUndefined()
  })

  it('restores fullscreen and maximized state with the saved normal bounds', () => {
    const restored = restoreMainWindowState(
      savedState({ fullScreen: true, maximized: true }),
      workArea,
      fallbackSize,
      minimumSize,
    )

    expect(restored).toEqual({
      bounds: { x: 100, y: 80, width: 1180, height: 820 },
      fullScreen: true,
      maximized: true,
    })
  })

  it('fits stale bounds onto the current display', () => {
    const restored = restoreMainWindowState(
      savedState({ bounds: { x: 3000, y: -900, width: 2000, height: 300 } }),
      workArea,
      fallbackSize,
      minimumSize,
    )

    expect(restored.bounds).toEqual({ x: 0, y: 25, width: 1440, height: 520 })
  })

  it('keeps fullscreen when the window closes after resize events', () => {
    vi.useFakeTimers()
    const window = new WindowDouble()
    const save = vi.fn()
    const persistence = persistMainWindowState(
      window,
      restoreMainWindowState(savedState({ fullScreen: true }), workArea, fallbackSize, minimumSize),
      save,
    )

    window.bounds = { x: 80, y: 60, width: 1200, height: 840 }
    window.emit('resize')
    window.emit('close')

    expect(save).toHaveBeenLastCalledWith(
      savedState({
        bounds: { x: 80, y: 60, width: 1200, height: 840 },
        fullScreen: true,
      }),
    )
    persistence.stop()
  })

  it('tracks confirmed fullscreen transitions', () => {
    vi.useFakeTimers()
    const window = new WindowDouble()
    const save = vi.fn()
    const persistence = persistMainWindowState(
      window,
      restoreMainWindowState(savedState(), workArea, fallbackSize, minimumSize),
      save,
    )

    window.emit('enter-full-screen')
    window.emit('close')
    expect(save).toHaveBeenLastCalledWith(savedState({ fullScreen: true }))

    window.emit('leave-full-screen')
    window.emit('close')
    expect(save).toHaveBeenLastCalledWith(savedState({ fullScreen: false }))
    persistence.stop()
  })

  it('freezes fullscreen before macOS quit teardown', () => {
    const window = new WindowDouble()
    const save = vi.fn()
    const persistence = persistMainWindowState(
      window,
      restoreMainWindowState(savedState(), workArea, fallbackSize, minimumSize),
      save,
    )

    window.emit('enter-full-screen')
    persistence.saveAndStop()
    window.emit('leave-full-screen')
    window.emit('close')

    expect(save).toHaveBeenLastCalledWith(savedState({ fullScreen: true }))
  })
})
