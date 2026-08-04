export type Theme = 'dark' | 'light'
export type ThemePreference = Theme | 'system'
export type FontPreference = 'geist' | 'system' | 'humanist' | 'rounded' | 'serif' | 'mono'
export type AccentPreference =
  'neutral' | 'ocean' | 'forest' | 'sunset' | 'amber' | 'rose' | 'lavender'

export const THEME_KEY = 'harness.theme'
export const FONT_KEY = 'harness.font'
export const ACCENT_KEY = 'harness.accent'
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
  const stored = localStorage.getItem(FONT_KEY)
  return stored === 'system' ||
    stored === 'humanist' ||
    stored === 'rounded' ||
    stored === 'serif' ||
    stored === 'mono'
    ? stored
    : 'geist'
}

export function applyFontPreference(font: FontPreference): void {
  document.documentElement.dataset.font = font
}

export function readAccentPreference(): AccentPreference {
  const stored = localStorage.getItem(ACCENT_KEY)
  return stored === 'ocean' ||
    stored === 'forest' ||
    stored === 'sunset' ||
    stored === 'amber' ||
    stored === 'rose' ||
    stored === 'lavender'
    ? stored
    : 'neutral'
}

export function applyAccentPreference(accent: AccentPreference): void {
  document.documentElement.dataset.accent = accent
}
