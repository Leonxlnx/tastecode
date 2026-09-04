export type Theme = 'dark' | 'light' | 'codex'
export type ThemeColorScheme = 'dark' | 'light'
export type ThemePreference = Theme | 'system'
export type FontPreset = 'geist' | 'inter' | 'system' | 'humanist' | 'rounded' | 'serif' | 'mono'
export type LocalFontPreference = `local:${string}`
export type FontPreference = FontPreset | LocalFontPreference
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
const LOCAL_FONT_PREFIX = 'local:'
const MAX_LOCAL_FONT_FAMILY_LENGTH = 256
const FONT_PRESETS = new Set<FontPreset>([
  'geist',
  'inter',
  'system',
  'humanist',
  'rounded',
  'serif',
  'mono',
])

export function readThemePreference(): ThemePreference {
  const stored = readStored(THEME_KEY)
  return stored === 'dark' || stored === 'light' || stored === 'codex' || stored === 'system'
    ? stored
    : 'system'
}

export function readSystemTheme(): ThemeColorScheme {
  return (globalThis.matchMedia?.(DARK_THEME_QUERY).matches ?? true) ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference): Theme {
  return preference === 'system' ? readSystemTheme() : preference
}

export function colorSchemeForTheme(theme: Theme): ThemeColorScheme {
  return theme === 'light' ? 'light' : 'dark'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.classList.toggle('dark', colorSchemeForTheme(theme) === 'dark')
}

export function readFontPreference(): FontPreference {
  const stored = readStored(FONT_KEY)
  if (FONT_PRESETS.has(stored as FontPreset)) return stored as FontPreset
  if (stored?.startsWith(LOCAL_FONT_PREFIX)) {
    return fontPreferenceForFamily(stored.slice(LOCAL_FONT_PREFIX.length)) ?? 'geist'
  }
  return 'geist'
}

export function fontPreferenceForFamily(family: string): LocalFontPreference | undefined {
  const normalized = family.trim()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_LOCAL_FONT_FAMILY_LENGTH ||
    /\p{Cc}/u.test(normalized)
  ) {
    return undefined
  }
  return `${LOCAL_FONT_PREFIX}${normalized}`
}

export function fontFamilyFromPreference(font: FontPreference): string | undefined {
  if (!font.startsWith(LOCAL_FONT_PREFIX)) return undefined
  const family = font.slice(LOCAL_FONT_PREFIX.length)
  return fontPreferenceForFamily(family)?.slice(LOCAL_FONT_PREFIX.length)
}

export function applyFontPreference(font: FontPreference): void {
  const root = document.documentElement
  const localFamily = fontFamilyFromPreference(font)
  root.dataset.font = localFamily ? 'local' : font
  if (localFamily) {
    root.style.setProperty('--font-ui', `${JSON.stringify(localFamily)}, system-ui, sans-serif`)
  } else {
    root.style.removeProperty('--font-ui')
  }
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
