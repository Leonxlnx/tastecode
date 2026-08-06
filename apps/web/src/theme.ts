export type Theme = 'dark' | 'light'
export type ThemePreference = Theme | 'system'
export type FontPreference = 'geist' | 'system' | 'humanist' | 'rounded' | 'serif' | 'mono'
export type AccentPreference =
  'neutral' | 'ocean' | 'forest' | 'sunset' | 'amber' | 'rose' | 'lavender'

export type BackdropPreference = 'default' | 'slate' | 'mocha' | 'forest' | 'midnight' | 'plum'

export const THEME_KEY = 'harness.theme'
export const FONT_KEY = 'harness.font'
export const ACCENT_KEY = 'harness.accent'
export const BACKDROP_KEY = 'harness.backdrop'
export const GLASS_KEY = 'harness.sidebarGlass'
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

export function readBackdropPreference(): BackdropPreference {
  const stored = localStorage.getItem(BACKDROP_KEY)
  return stored === 'slate' ||
    stored === 'mocha' ||
    stored === 'forest' ||
    stored === 'midnight' ||
    stored === 'plum'
    ? stored
    : 'default'
}

export function applyBackdropPreference(backdrop: BackdropPreference): void {
  document.documentElement.dataset.backdrop = backdrop
}

/**
 * Sidebar translucency in percent, 0 (opaque, the default) to 60. Anything
 * above that makes text sit on too little contrast to read comfortably.
 */
export function readGlassPreference(): number {
  const stored = Number(localStorage.getItem(GLASS_KEY))
  return Number.isFinite(stored) ? Math.min(60, Math.max(0, Math.round(stored))) : 0
}

export function applyGlassPreference(glass: number): void {
  const root = document.documentElement
  root.dataset.glass = glass > 0 ? 'on' : 'off'
  root.style.setProperty('--rail-glass', String(glass / 100))
}
