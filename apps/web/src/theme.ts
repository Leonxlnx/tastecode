export type Theme = 'dark' | 'light'
export type ThemePreference = Theme | 'system'
export type FontPreference = 'geist' | 'system'

export const THEME_KEY = 'harness.theme'
export const FONT_KEY = 'harness.font'
export const DARK_THEME_QUERY = '(prefers-color-scheme: dark)'

export function readThemePreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY)
  return stored === 'light' || stored === 'system' ? stored : 'dark'
}

export function readSystemTheme(): Theme {
  return (globalThis.matchMedia?.(DARK_THEME_QUERY).matches ?? true) ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference): Theme {
  return preference === 'system' ? readSystemTheme() : preference
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function readFontPreference(): FontPreference {
  return localStorage.getItem(FONT_KEY) === 'system' ? 'system' : 'geist'
}

export function applyFontPreference(font: FontPreference): void {
  document.documentElement.dataset.font = font
}
