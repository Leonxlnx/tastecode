import { describe, expect, it } from 'vitest'
import { windowThemeOptions, windowThemeSource } from './window-theme.js'

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
