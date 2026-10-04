// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readTerminalPlacement,
  subscribeTerminalPlacement,
  TERMINAL_PLACEMENT_KEY,
  writeTerminalPlacement,
} from './terminal-placement.js'

afterEach(() => {
  vi.restoreAllMocks()
  writeTerminalPlacement('bottom')
  localStorage.clear()
})

describe('terminal placement preference', () => {
  it('uses the bottom panel when no preference has been saved', () => {
    expect(readTerminalPlacement()).toBe('bottom')
  })

  it('persists the workspace sidebar choice and notifies subscribers', () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeTerminalPlacement(onChange)

    writeTerminalPlacement('workspace')

    expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBe('workspace')
    expect(readTerminalPlacement()).toBe('workspace')
    expect(onChange).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('keeps the session choice when persistent storage rejects the write', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })

    writeTerminalPlacement('workspace')

    expect(readTerminalPlacement()).toBe('workspace')
  })
})
