import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Matches --titlebar-h; Windows sizes the caption buttons from it. */
const TITLE_BAR_HEIGHT = 34

export function windowThemeOptions(themeValue: unknown) {
  if (themeValue !== 'light' && themeValue !== 'dark') {
    throw new Error('Invalid window theme')
  }
  const theme = themeValue

  // The overlay colour must match the renderer's --bg-rail: the native caption
  // buttons sit on the title bar, and that bar carries the sidebar colour so
  // the two read as one element.
  if (theme === 'light') {
    return {
      backgroundColor: '#fdfdfd',
      titleBarOverlay: { color: '#fcfcfc', symbolColor: '#27272a', height: TITLE_BAR_HEIGHT },
    }
  }
  return {
    backgroundColor: '#202020',
    titleBarOverlay: { color: '#131313', symbolColor: '#ffffff', height: TITLE_BAR_HEIGHT },
  }
}

export function windowThemeSource(preference: unknown): 'system' | 'light' | 'dark' {
  if (preference !== 'system' && preference !== 'light' && preference !== 'dark') {
    throw new Error('Invalid window theme preference')
  }
  return preference
}

/**
 * The colours the renderer actually paints where native chrome meets it: the
 * page background, the title bar under the caption buttons and the title-bar
 * symbol colour. Theme, tinted backdrops and the open surface (the Settings
 * title bar is a shade off the rail) all change them, which a light/dark pair
 * of constants cannot follow.
 *
 * The caption may carry an alpha byte (#rrggbbaa): with a window background
 * the page's title bar is see-through, and the buttons must not paint an
 * opaque box over it.
 *
 * `seeThrough` is set while the page shows what is behind the window
 * (Window background › Transparent); the window colour then turns
 * transparent where the OS draws a material (window-material.ts). Absent
 * means opaque, which is also what a file from an older version reads as.
 */
export type WindowChrome = {
  theme: 'light' | 'dark'
  background: string
  caption: string
  symbol: string
  seeThrough?: true
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const HEX_COLOR_WITH_ALPHA = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i

/** Validates a renderer-supplied WindowChrome; throws on anything else. */
export function parseWindowChrome(value: unknown): WindowChrome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid window chrome')
  }
  const candidate = value as Record<string, unknown>
  const { theme, background, caption, symbol, seeThrough } = candidate
  if (
    (theme !== 'light' && theme !== 'dark') ||
    typeof background !== 'string' ||
    typeof caption !== 'string' ||
    typeof symbol !== 'string' ||
    !HEX_COLOR.test(background) ||
    !HEX_COLOR_WITH_ALPHA.test(caption) ||
    !HEX_COLOR.test(symbol) ||
    (seeThrough !== undefined && typeof seeThrough !== 'boolean')
  ) {
    throw new Error('Invalid window chrome')
  }
  // Kept only when on, so an opaque window's chrome reads and saves as before.
  return seeThrough === true
    ? { theme, background, caption, symbol, seeThrough }
    : { theme, background, caption, symbol }
}

export function windowChromeOptions(chrome: WindowChrome) {
  return {
    backgroundColor: chrome.background,
    titleBarOverlay: {
      color: chrome.caption,
      symbolColor: chrome.symbol,
      height: TITLE_BAR_HEIGHT,
    },
  }
}

/** The chrome the renderer last reported, so the next launch opens in it instead of dark. */
export function loadWindowChrome(filePath: string): WindowChrome | undefined {
  try {
    return parseWindowChrome(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return undefined
  }
}

export function saveWindowChrome(filePath: string, chrome: WindowChrome): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${JSON.stringify(chrome)}\n`, { encoding: 'utf8', mode: 0o600 })
}
