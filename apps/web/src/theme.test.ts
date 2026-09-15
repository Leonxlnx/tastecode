// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCENT_KEY,
  BACKDROP_KEY,
  GLASS_KEY,
  THEME_KEY,
  applyFontPreference,
  applyGlassPreference,
  applyTheme,
  colorSchemeForTheme,
  fontFamilyFromPreference,
  fontPreferenceForFamily,
  readAccentPreference,
  readBackdropPreference,
  readFontPreference,
  readGlassPreference,
  readThemePreference,
} from './theme.js'

/**
 * Preference readers face whatever localStorage happens to contain — old
 * builds, hand edits, other apps on the same origin. Garbage must degrade to
 * the default, never to a broken UI state.
 */

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-font')
  document.documentElement.style.removeProperty('--font-ui')
  document.documentElement.classList.remove('dark')
})

describe('preference readers', () => {
  it('defaults to the system theme when no choice is stored', () => {
    expect(readThemePreference()).toBe('system')
  })

  it('fall back to defaults on unknown stored values', () => {
    localStorage.setItem(THEME_KEY, 'solarized')
    localStorage.setItem(ACCENT_KEY, 'automatic')
    localStorage.setItem(BACKDROP_KEY, '42')
    expect(readThemePreference()).toBe('system')
    expect(readAccentPreference()).toBe('neutral')
    expect(readBackdropPreference()).toBe('default')
  })

  it('accept every advertised value', () => {
    for (const theme of ['system', 'light', 'dark']) {
      localStorage.setItem(THEME_KEY, theme)
      expect(readThemePreference()).toBe(theme)
    }
    localStorage.setItem(BACKDROP_KEY, 'midnight')
    expect(readBackdropPreference()).toBe('midnight')
  })

  it('falls back to system for the removed Codex theme', () => {
    localStorage.setItem(THEME_KEY, 'codex')
    expect(readThemePreference()).toBe('system')
  })

  it.each(['dark', 'light'] as const)('applies the %s browser color scheme', (theme) => {
    applyTheme(theme)

    expect(document.documentElement.dataset['theme']).toBe(theme)
    expect(document.documentElement.classList.contains('dark')).toBe(theme === 'dark')
    expect(colorSchemeForTheme(theme)).toBe(theme)
  })
})

describe('font preference', () => {
  it('round-trips an installed font family and rejects malformed stored values', () => {
    const preference = fontPreferenceForFamily('  Atkinson Hyperlegible  ')

    expect(preference).toBe('local:Atkinson Hyperlegible')
    expect(fontFamilyFromPreference(preference!)).toBe('Atkinson Hyperlegible')
    localStorage.setItem('harness.font', preference!)
    expect(readFontPreference()).toBe(preference)

    localStorage.setItem('harness.font', 'local:Broken\nFamily')
    expect(readFontPreference()).toBe('geist')
  })

  it('applies a quoted local family and clears it when returning to a preset', () => {
    applyFontPreference('local:Atkinson Hyperlegible')

    expect(document.documentElement.dataset['font']).toBe('local')
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
      '"Atkinson Hyperlegible", system-ui, sans-serif',
    )

    applyFontPreference('inter')
    expect(document.documentElement.dataset['font']).toBe('inter')
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe('')
  })
})

describe('glass preference', () => {
  it('clamps to the readable 0-60 range and survives garbage', () => {
    localStorage.setItem(GLASS_KEY, '95')
    expect(readGlassPreference()).toBe(60)
    localStorage.setItem(GLASS_KEY, '-10')
    expect(readGlassPreference()).toBe(0)
    localStorage.setItem(GLASS_KEY, 'opaque')
    expect(readGlassPreference()).toBe(35)
    localStorage.setItem(GLASS_KEY, '33.4')
    expect(readGlassPreference()).toBe(33)
  })

  it('defaults to Medium when nothing is stored, and honors an explicit Off', () => {
    localStorage.removeItem(GLASS_KEY)
    expect(readGlassPreference()).toBe(35)
    localStorage.setItem(GLASS_KEY, '0')
    expect(readGlassPreference()).toBe(0)
  })

  it('applies as a data flag plus a 0-1 custom property', () => {
    applyGlassPreference(40)
    expect(document.documentElement.dataset['glass']).toBe('on')
    expect(document.documentElement.style.getPropertyValue('--rail-glass')).toBe('0.4')
    applyGlassPreference(0)
    expect(document.documentElement.dataset['glass']).toBe('off')
  })
})
