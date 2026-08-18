import { z } from 'zod'

const WindowThemeSchema = z.enum(['light', 'dark'])
const WindowThemePreferenceSchema = z.enum(['system', 'light', 'dark'])

export function windowThemeOptions(themeValue: unknown) {
  const result = WindowThemeSchema.safeParse(themeValue)
  if (!result.success) throw new Error('Invalid window theme')
  const theme = result.data

  // The overlay colour must match the renderer's --bg-rail: the native caption
  // buttons sit on the title bar, and that bar carries the sidebar colour so
  // the two read as one element.
  return theme === 'light'
    ? {
        backgroundColor: '#fdfdfd',
        titleBarOverlay: { color: '#fcfcfc', symbolColor: '#27272a', height: 34 },
      }
    : {
        backgroundColor: '#202020',
        titleBarOverlay: { color: '#131313', symbolColor: '#ffffff', height: 34 },
      }
}

export function windowThemeSource(preference: unknown): 'system' | 'light' | 'dark' {
  const result = WindowThemePreferenceSchema.safeParse(preference)
  if (!result.success) throw new Error('Invalid window theme preference')
  return result.data
}
