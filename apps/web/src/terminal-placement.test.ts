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
  writeTerminalPlacement('workspace')
  localStorage.clear()
})

describe('terminal placement preference', () => {
  it('uses the right sidebar when no preference has been saved', () => {
    expect(readTerminalPlacement()).toBe('workspace')
  })

  it('persists the bottom panel choice and notifies subscribers', () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeTerminalPlacement(onChange)

    writeTerminalPlacement('bottom')

    expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBe('bottom')
    expect(readTerminalPlacement()).toBe('bottom')
    expect(onChange).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('keeps the session choice when persistent storage rejects the write', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })

    writeTerminalPlacement('bottom')

    expect(readTerminalPlacement()).toBe('bottom')
  })
})
