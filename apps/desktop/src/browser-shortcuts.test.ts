import { describe, expect, it, vi } from 'vitest'
import {
  browserShortcut,
  forwardBrowserShortcuts,
  isBrowserShortcutMessage,
  type BrowserShortcutInput,
} from './browser-shortcuts.js'

const key = (
  value: string,
  modifiers: Partial<Omit<BrowserShortcutInput, 'key'>> = {},
): BrowserShortcutInput => ({
  type: 'keyDown',
  key: value,
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...modifiers,
})

describe('browser shortcuts in a guest page', () => {
  it('maps the Windows and Linux browser keys', () => {
    expect(browserShortcut(key('ArrowLeft', { alt: true }), 'win32')).toBe('back')
    expect(browserShortcut(key('ArrowRight', { alt: true }), 'linux')).toBe('forward')
    expect(browserShortcut(key('r', { control: true }), 'win32')).toBe('reload')
    expect(browserShortcut(key('R', { control: true }), 'win32')).toBe('reload')
    expect(browserShortcut(key('F5'), 'win32')).toBe('reload')
    expect(browserShortcut(key('l', { control: true }), 'win32')).toBe('address')
    expect(browserShortcut(key('w', { control: true }), 'win32')).toBe('close')
  })

  it('maps the macOS Cmd keys and leaves caret movement to the page', () => {
    expect(browserShortcut(key('[', { meta: true }), 'darwin')).toBe('back')
    expect(browserShortcut(key('ü', { meta: true, code: 'BracketLeft' }), 'darwin')).toBe('back')
    expect(browserShortcut(key(']', { meta: true }), 'darwin')).toBe('forward')
    expect(browserShortcut(key('r', { meta: true }), 'darwin')).toBe('reload')
    expect(browserShortcut(key('l', { meta: true }), 'darwin')).toBe('address')
    expect(browserShortcut(key('w', { meta: true }), 'darwin')).toBe('close')
    // Option+Left jumps a word and Cmd+Left goes to the line start in a field.
    expect(browserShortcut(key('ArrowLeft', { alt: true }), 'darwin')).toBeUndefined()
    expect(browserShortcut(key('ArrowLeft', { meta: true }), 'darwin')).toBeUndefined()
    expect(browserShortcut(key('r', { control: true }), 'darwin')).toBeUndefined()
    expect(browserShortcut(key('F5'), 'darwin')).toBeUndefined()
  })

  it('leaves every other key to the page', () => {
    for (const input of [
      key('l'),
      key('ArrowLeft'),
      key('r', { control: true, shift: true }),
      key('w', { control: true, alt: true }),
      key('ArrowLeft', { alt: true, control: true }),
      key('F5', { control: true }),
      key('t', { control: true }),
      key('[', { control: true }),
    ]) {
      expect(browserShortcut(input, 'win32')).toBeUndefined()
    }
    expect(browserShortcut(key('w', { control: true, meta: true }), 'win32')).toBeUndefined()
  })

  it('validates the message the renderer receives', () => {
    expect(isBrowserShortcutMessage({ guestId: 12, action: 'back' })).toBe(true)
    expect(isBrowserShortcutMessage({ guestId: 12, action: 'quit' })).toBe(false)
    expect(isBrowserShortcutMessage({ guestId: 0, action: 'back' })).toBe(false)
    expect(isBrowserShortcutMessage({ guestId: 1.5, action: 'back' })).toBe(false)
    expect(isBrowserShortcutMessage({ guestId: '12', action: 'back' })).toBe(false)
    expect(isBrowserShortcutMessage({ guestId: 12, action: 'back', url: 'x' })).toBe(false)
    expect(isBrowserShortcutMessage(['back'])).toBe(false)
    expect(isBrowserShortcutMessage(null)).toBe(false)
  })
})

describe('forwarding guest keys to the window', () => {
  const setup = (destroyed = false) => {
    let listener:
      ((event: { preventDefault(): void }, input: BrowserShortcutInput) => void) | undefined
    const guest = {
      id: 42,
      on: vi.fn((_event: 'before-input-event', next: typeof listener) => {
        listener = next
      }),
    }
    const embedder = { isDestroyed: () => destroyed, send: vi.fn() }
    forwardBrowserShortcuts(guest, embedder, 'win32')
    const press = (input: BrowserShortcutInput) => {
      const event = { preventDefault: vi.fn() }
      listener!(event, input)
      return event.preventDefault
    }
    return { embedder, press }
  }

  it('takes a Browser key from the page and names the guest it came from', () => {
    const { embedder, press } = setup()
    expect(press(key('w', { control: true }))).toHaveBeenCalledOnce()
    expect(embedder.send).toHaveBeenCalledWith('harness:browserShortcut', {
      guestId: 42,
      action: 'close',
    })
  })

  it('lets ordinary typing and key releases through untouched', () => {
    const { embedder, press } = setup()
    expect(press(key('a'))).not.toHaveBeenCalled()
    expect(press({ ...key('w', { control: true }), type: 'keyUp' })).not.toHaveBeenCalled()
    expect(embedder.send).not.toHaveBeenCalled()
  })

  it('swallows a held key without repeating the action', () => {
    const { embedder, press } = setup()
    expect(press(key('w', { control: true, isAutoRepeat: true }))).toHaveBeenCalledOnce()
    expect(embedder.send).not.toHaveBeenCalled()
  })

  it('sends nothing to a window that is gone', () => {
    const { embedder, press } = setup(true)
    expect(press(key('F5'))).toHaveBeenCalledOnce()
    expect(embedder.send).not.toHaveBeenCalled()
  })
})
