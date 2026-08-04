import { describe, expect, it } from 'vitest'
import { windowThemeOptions } from './window-theme.js'

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
  })

  it('rejects untrusted renderer values', () => {
    expect(() => windowThemeOptions('system')).toThrow('Invalid window theme')
  })
})
