import { describe, expect, it } from 'vitest'
import {
  backdropColorScheme,
  colorForeground,
  hexToHsv,
  hsvToHex,
  normalizeHexColor,
} from './theme-colors.js'

describe('custom color values', () => {
  it.each(['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#5E6AD2', '#777777'])(
    'round-trips %s through the picker without drift',
    (color) => {
      const hex = normalizeHexColor(color)!
      expect(hsvToHex(hexToHsv(hex))).toBe(hex)
    },
  )

  it('accepts pasted hex values with or without a hash', () => {
    expect(normalizeHexColor(' 5e6ad2 ')).toBe('#5E6AD2')
    expect(normalizeHexColor('#abc')).toBe('#AABBCC')
    expect(normalizeHexColor('transparent')).toBeUndefined()
  })

  it('uses readable text for light and dark backgrounds without changing preset schemes', () => {
    expect(colorForeground('#FFFFFF')).toBe('#171717')
    expect(colorForeground('#5E6AD2')).toBe('#ffffff')
    expect(backdropColorScheme('#FFFFFF')).toBe('light')
    expect(backdropColorScheme('#101010')).toBe('dark')
    expect(backdropColorScheme('midnight')).toBeUndefined()
  })
})
