export type Theme = 'dark' | 'light'
export type ThemePreference = Theme | 'system'
export type FontPreference = 'geist' | 'system' | 'humanist' | 'rounded' | 'serif' | 'mono'
export type AccentPreference =
  'neutral' | 'ocean' | 'forest' | 'sunset' | 'amber' | 'rose' | 'lavender'

export type BackdropPreference = 'default' | 'slate' | 'mocha' | 'forest' | 'midnight' | 'plum'

/** With site data blocked, touching localStorage throws SecurityError — and
 *  these run during module init, where a throw is a white screen. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export const THEME_KEY = 'harness.theme'
export const FONT_KEY = 'harness.font'
export const ACCENT_KEY = 'harness.accent'
export const BACKDROP_KEY = 'harness.backdrop'
// v2: the default changed from Off to Medium. The v1 key is deliberately
// abandoned — every install under the old default had "0" auto-written on
// mount, which would pin the new default to Off forever.
export const GLASS_KEY = 'harness.sidebarGlass2'
export const DARK_THEME_QUERY = '(prefers-color-scheme: dark)'

export function readThemePreference(): ThemePreference {
  const stored = readStored(THEME_KEY)
  return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system'
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
  const stored = readStored(FONT_KEY)
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
  const stored = readStored(ACCENT_KEY)
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
  const stored = readStored(BACKDROP_KEY)
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
 * Sidebar translucency in percent, 0 (opaque) to 60 — anything above that
 * makes text sit on too little contrast to read comfortably. Defaults to
 * Medium (35): the glass is meant to be seen, not discovered in a submenu.
 */
export function readGlassPreference(): number {
  const raw = readStored(GLASS_KEY)
  if (raw === null || raw === '') return 35
  const stored = Number(raw)
  return Number.isFinite(stored) ? Math.min(60, Math.max(0, Math.round(stored))) : 35
}

export function applyGlassPreference(glass: number): void {
  const root = document.documentElement
  root.dataset.glass = glass > 0 ? 'on' : 'off'
  root.style.setProperty('--rail-glass', String(glass / 100))
}
