import { describe, expect, it } from 'vitest'
import { browserShortcut, browserShortcutHints } from './browser-shortcuts.js'

const key = (
  value: string,
  modifiers: Partial<{
    code: string
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
    shiftKey: boolean
  }> = {},
) => ({
  key: value,
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
})

describe('Browser tab keys', () => {
  it('maps the Windows and Linux browser keys', () => {
    expect(browserShortcut(key('ArrowLeft', { altKey: true }), false)).toBe('back')
    expect(browserShortcut(key('ArrowRight', { altKey: true }), false)).toBe('forward')
    expect(browserShortcut(key('r', { ctrlKey: true }), false)).toBe('reload')
    expect(browserShortcut(key('F5'), false)).toBe('reload')
    expect(browserShortcut(key('L', { ctrlKey: true }), false)).toBe('address')
    expect(browserShortcut(key('w', { ctrlKey: true }), false)).toBe('close')
  })

  it('maps the macOS Cmd keys and leaves caret movement alone', () => {
    expect(browserShortcut(key('[', { metaKey: true }), true)).toBe('back')
    expect(browserShortcut(key('ü', { metaKey: true, code: 'BracketLeft' }), true)).toBe('back')
    expect(browserShortcut(key(']', { metaKey: true }), true)).toBe('forward')
    expect(browserShortcut(key('r', { metaKey: true }), true)).toBe('reload')
    expect(browserShortcut(key('l', { metaKey: true }), true)).toBe('address')
    expect(browserShortcut(key('w', { metaKey: true }), true)).toBe('close')
    expect(browserShortcut(key('ArrowLeft', { altKey: true }), true)).toBeUndefined()
    expect(browserShortcut(key('ArrowLeft', { metaKey: true }), true)).toBeUndefined()
    expect(browserShortcut(key('l', { ctrlKey: true }), true)).toBeUndefined()
  })

  it('ignores everything else', () => {
    for (const event of [
      key('l'),
      key('Escape'),
      key('r', { ctrlKey: true, shiftKey: true }),
      key('w', { ctrlKey: true, altKey: true }),
      key('ArrowLeft', { altKey: true, ctrlKey: true }),
      key('ArrowUp', { altKey: true }),
      key('t', { ctrlKey: true }),
    ]) {
      expect(browserShortcut(event, false)).toBeUndefined()
    }
  })

  it('names the keys in tooltips and for assistive technology', () => {
    expect(browserShortcutHints(false).back).toEqual({ label: 'Alt+←', aria: 'Alt+ArrowLeft' })
    expect(browserShortcutHints(false).reload.aria).toBe('Control+R F5')
    expect(browserShortcutHints(true).back).toEqual({ label: '⌘[', aria: 'Meta+[' })
    expect(browserShortcutHints(true).address.label).toBe('⌘L')
  })
})
