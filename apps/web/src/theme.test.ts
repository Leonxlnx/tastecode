// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCENT_KEY,
  BACKDROP_KEY,
  GLASS_KEY,
  THEME_KEY,
  applyGlassPreference,
  readAccentPreference,
  readBackdropPreference,
  readGlassPreference,
  readThemePreference,
} from './theme.js'

/**
 * Preference readers face whatever localStorage happens to contain — old
 * builds, hand edits, other apps on the same origin. Garbage must degrade to
 * the default, never to a broken UI state.
 */

afterEach(() => localStorage.clear())

describe('preference readers', () => {
  it('fall back to defaults on unknown stored values', () => {
    localStorage.setItem(THEME_KEY, 'solarized')
    localStorage.setItem(ACCENT_KEY, 'automatic')
    localStorage.setItem(BACKDROP_KEY, '42')
    expect(readThemePreference()).toBe('dark')
    expect(readAccentPreference()).toBe('neutral')
    expect(readBackdropPreference()).toBe('default')
  })

  it('accept every advertised value', () => {
    localStorage.setItem(THEME_KEY, 'system')
    expect(readThemePreference()).toBe('system')
    localStorage.setItem(BACKDROP_KEY, 'midnight')
    expect(readBackdropPreference()).toBe('midnight')
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
