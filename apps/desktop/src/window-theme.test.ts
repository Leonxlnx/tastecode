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
    expect(windowThemeOptions('codex')).toEqual({
      backgroundColor: '#2d2d2b',
      titleBarOverlay: { color: '#353533', symbolColor: '#dededc', height: 34 },
    })
  })

  it('rejects untrusted renderer values', () => {
    expect(() => windowThemeOptions('system')).toThrow('Invalid window theme')
    expect(windowThemeSource('system')).toBe('system')
    expect(windowThemeSource('codex')).toBe('dark')
    expect(() => windowThemeSource('sepia')).toThrow('Invalid window theme preference')
  })
})
