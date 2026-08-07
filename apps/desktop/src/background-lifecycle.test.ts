import { describe, expect, it } from 'vitest'
import { shouldHideWindowOnClose } from './background-lifecycle.js'

describe('desktop background lifecycle', () => {
  it('keeps the host alive behind a hidden window on Windows and Linux', () => {
    expect(shouldHideWindowOnClose('win32', false)).toBe(true)
    expect(shouldHideWindowOnClose('linux', false)).toBe(true)
  })

  it('uses native macOS window closing and never blocks a real app quit', () => {
    expect(shouldHideWindowOnClose('darwin', false)).toBe(false)
    expect(shouldHideWindowOnClose('win32', true)).toBe(false)
  })
})
