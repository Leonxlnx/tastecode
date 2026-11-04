import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadWindowChrome,
  parseWindowChrome,
  saveWindowChrome,
  windowChromeOptions,
  windowThemeOptions,
  windowThemeSource,
} from './window-theme.js'

describe('windowThemeOptions', () => {
  it('matches native chrome to the selected app theme', () => {
    expect(windowThemeOptions('light')).toMatchObject({
      backgroundColor: '#fdfdfd',
      titleBarOverlay: { symbolColor: '#27272a' },
    })
    expect(windowThemeOptions('dark')).toMatchObject({
      backgroundColor: '#202020',
      titleBarOverlay: { symbolColor: '#ffffff' },
    })
    expect(() => windowThemeOptions('codex')).toThrow('Invalid window theme')
  })

  it('rejects untrusted renderer values', () => {
    expect(() => windowThemeOptions('system')).toThrow('Invalid window theme')
    expect(windowThemeSource('system')).toBe('system')
    expect(windowThemeSource('light')).toBe('light')
    expect(windowThemeSource('dark')).toBe('dark')
    expect(() => windowThemeSource('codex')).toThrow('Invalid window theme preference')
    expect(() => windowThemeSource('sepia')).toThrow('Invalid window theme preference')
  })
})

describe('window chrome', () => {
  const slate = { theme: 'light', background: '#f8fafc', caption: '#f2f5f9', symbol: '#27272a' }

  it('paints the caption buttons with the colours the renderer reports', () => {
    expect(windowChromeOptions(parseWindowChrome(slate))).toEqual({
      backgroundColor: '#f8fafc',
      titleBarOverlay: { color: '#f2f5f9', symbolColor: '#27272a', height: 34 },
    })
  })

  it('lets the caption buttons go see-through over a window background', () => {
    const clear = parseWindowChrome({ ...slate, caption: '#00000000' })
    expect(windowChromeOptions(clear).titleBarOverlay.color).toBe('#00000000')
  })

  it('carries see-through only while it is on, so opaque chrome reads as before', () => {
    expect(parseWindowChrome({ ...slate, seeThrough: true })).toEqual({
      ...slate,
      seeThrough: true,
    })
    expect(parseWindowChrome({ ...slate, seeThrough: false })).toEqual(slate)
    expect(parseWindowChrome({ ...slate, seeThrough: false })).not.toHaveProperty('seeThrough')
    expect(parseWindowChrome(slate)).not.toHaveProperty('seeThrough')
    // The opaque colour stays known, for when Transparent is turned off.
    expect(windowChromeOptions(parseWindowChrome({ ...slate, seeThrough: true }))).toMatchObject({
      backgroundColor: '#f8fafc',
    })
  })

  it.each([
    undefined,
    'light',
    [],
    { ...slate, seeThrough: 'yes' },
    { ...slate, seeThrough: 1 },
    { ...slate, seeThrough: null },
    { ...slate, theme: 'system' },
    { ...slate, caption: 'red' },
    { ...slate, caption: '#fff' },
    { ...slate, caption: '#00000000ff' },
    { ...slate, symbol: '#27272a00' },
    { ...slate, background: '#f8fafc00' },
    { ...slate, symbol: 'var(--text)' },
    { ...slate, background: '#f8fafc; color: red' },
    { theme: 'dark', background: '#000000', caption: '#000000' },
  ])('rejects untrusted renderer chrome %j', (value) => {
    expect(() => parseWindowChrome(value)).toThrow('Invalid window chrome')
  })

  it('keeps the last chrome for the next launch and ignores a damaged file', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'window-chrome-'))
    try {
      const file = path.join(directory, 'nested', 'window-chrome.json')
      expect(loadWindowChrome(file)).toBeUndefined()
      saveWindowChrome(file, parseWindowChrome(slate))
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(slate)
      expect(loadWindowChrome(file)).toEqual(slate)
      // A window that showed the desktop through it reopens that way.
      saveWindowChrome(file, parseWindowChrome({ ...slate, seeThrough: true }))
      expect(loadWindowChrome(file)).toEqual({ ...slate, seeThrough: true })
      writeFileSync(file, '{"theme":"light","caption":"javascript:alert(1)"}')
      expect(loadWindowChrome(file)).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
