import { describe, expect, it } from 'vitest'
import { shouldHideWindowOnClose } from './background-lifecycle.js'

describe('desktop background lifecycle', () => {
  it('keeps the host alive behind a hidden window on Windows and Linux', () => {
    expect(shouldHideWindowOnClose('win32', false, true)).toBe(true)
    expect(shouldHideWindowOnClose('linux', false, true)).toBe(true)
  })

  it('closes normally when the tray recovery surface is unavailable', () => {
    expect(shouldHideWindowOnClose('linux', false, false)).toBe(false)
    expect(shouldHideWindowOnClose('win32', false, false)).toBe(false)
  })

  it('uses native macOS window closing and never blocks a real app quit', () => {
    expect(shouldHideWindowOnClose('darwin', false, true)).toBe(false)
    expect(shouldHideWindowOnClose('win32', true, true)).toBe(false)
  })
})
