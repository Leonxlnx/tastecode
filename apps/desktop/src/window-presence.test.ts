import { describe, expect, it, vi } from 'vitest'
import { presentMainWindow, restoreMainWindowPresence } from './window-presence.js'

function presenceDoubles() {
  return {
    application: { setActivationPolicy: vi.fn() },
    window: {
      setFocusable: vi.fn(),
      setHiddenInMissionControl: vi.fn(),
      setMovable: vi.fn(),
      setSkipTaskbar: vi.fn(),
    },
  }
}

function presentationDoubles(minimized = false) {
  const { application, window } = presenceDoubles()
  return {
    application: { ...application, focus: vi.fn() },
    window: {
      ...window,
      focus: vi.fn(),
      isMinimized: vi.fn(() => minimized),
      restore: vi.fn(),
      show: vi.fn(),
    },
  }
}

describe('restoreMainWindowPresence', () => {
  it('restores a regular, switchable, movable macOS app window', () => {
    const { application, window } = presenceDoubles()

    restoreMainWindowPresence('darwin', application, window)

    expect(application.setActivationPolicy).toHaveBeenCalledWith('regular')
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(false)
    expect(window.setHiddenInMissionControl).toHaveBeenCalledWith(false)
    expect(window.setFocusable).toHaveBeenCalledWith(true)
    expect(window.setMovable).toHaveBeenCalledWith(true)
  })

  it('restores taskbar presence on Windows without calling macOS-only APIs', () => {
    const { application, window } = presenceDoubles()

    restoreMainWindowPresence('win32', application, window)

    expect(application.setActivationPolicy).not.toHaveBeenCalled()
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(false)
    expect(window.setHiddenInMissionControl).not.toHaveBeenCalled()
    expect(window.setFocusable).toHaveBeenCalledWith(true)
    expect(window.setMovable).toHaveBeenCalledWith(true)
  })

  it('avoids unsupported taskbar APIs on Linux while restoring interaction', () => {
    const { application, window } = presenceDoubles()

    restoreMainWindowPresence('linux', application, window)

    expect(application.setActivationPolicy).not.toHaveBeenCalled()
    expect(window.setSkipTaskbar).not.toHaveBeenCalled()
    expect(window.setHiddenInMissionControl).not.toHaveBeenCalled()
    expect(window.setFocusable).toHaveBeenCalledWith(true)
    expect(window.setMovable).toHaveBeenCalledWith(true)
  })
})

describe('presentMainWindow', () => {
  it('shows a Linux window before requesting application and window focus', () => {
    const { application, window } = presentationDoubles(true)

    presentMainWindow('linux', application, window)

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(application.focus).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.show.mock.invocationCallOrder[0]).toBeLessThan(
      application.focus.mock.invocationCallOrder[0],
    )
    expect(application.focus.mock.invocationCallOrder[0]).toBeLessThan(
      window.focus.mock.invocationCallOrder[0],
    )
  })
})
