import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The system backdrop Windows draws behind the window. Acrylic blurs whatever
 * sits behind the window; Mica tints the desktop wallpaper and stays still.
 * The renderer shows it wherever it paints nothing: the sidebar glass always,
 * and the whole window when Settings › Appearance › Window background is
 * Transparent.
 */
export type WindowMaterial = 'acrylic' | 'mica'

/**
 * What this OS can draw behind the window: a Windows 11 backdrop material,
 * macOS vibrancy, or nothing (Windows 10, Linux).
 */
export type WindowMaterialSupport = 'material' | 'vibrancy' | 'none'

export const DEFAULT_WINDOW_MATERIAL: WindowMaterial = 'acrylic'

/** Windows 11 22H2: the first build where Electron's backgroundMaterial takes effect. */
const FIRST_MATERIAL_BUILD = 22_621

export function windowMaterialSupport(
  platform: string,
  systemVersion: string,
): WindowMaterialSupport {
  if (platform === 'darwin') return 'vibrancy'
  if (platform !== 'win32') return 'none'
  // process.getSystemVersion() on Windows reads "10.0.<build>" for 10 and 11 alike.
  const build = Number(/^\d+\.\d+\.(\d+)/.exec(systemVersion)?.[1])
  return Number.isInteger(build) && build >= FIRST_MATERIAL_BUILD ? 'material' : 'none'
}

/** Fully transparent: the window colour while the page lets the OS material show. */
export const SEE_THROUGH_BACKGROUND = '#00000000'

/**
 * What the window and the page under everything the renderer draws are filled
 * with. Electron hands an explicit backgroundColor to the page as its base
 * colour, so an opaque one covers the acrylic, Mica or vibrancy completely,
 * however transparent the page's own CSS is. It is transparent only while the
 * renderer asks to show what is behind the window (Window background ›
 * Transparent) and this OS draws a material there; everywhere else the window
 * keeps the opaque colour the page paints, so nothing flashes through.
 */
export function windowBackgroundColor(
  opaque: string,
  seeThrough: boolean,
  support: WindowMaterialSupport,
): string {
  return seeThrough && support !== 'none' ? SEE_THROUGH_BACKGROUND : opaque
}

export type WindowBackdropOptions = {
  backgroundMaterial?: WindowMaterial
  vibrancy?: 'sidebar'
}

/**
 * The system backdrop the main window is created with: the Windows 11 DWM
 * material where it exists, sidebar vibrancy on macOS, nothing elsewhere.
 * Either one makes Electron create a translucent window, which is what lets
 * the material show where the page and window colour are transparent.
 *
 * Never `transparent: true`: on Windows Electron then drops the window's
 * thick (resize) frame, so it can no longer be resized or snapped, and the
 * system frame is what draws the Windows 11 rounded corners and shadow.
 */
export function windowBackdropOptions(
  platform: string,
  support: WindowMaterialSupport,
  material: WindowMaterial,
): WindowBackdropOptions {
  if (platform === 'win32' && support === 'material') return { backgroundMaterial: material }
  if (platform === 'darwin' && support === 'vibrancy') return { vibrancy: 'sidebar' }
  return {}
}

/** Validates a renderer-supplied material; throws on anything else. */
export function parseWindowMaterial(value: unknown): WindowMaterial {
  if (value !== 'acrylic' && value !== 'mica') throw new Error('Invalid window material')
  return value
}

/** The material the renderer last chose, so the next launch opens in it. */
export function loadWindowMaterial(filePath: string): WindowMaterial | undefined {
  try {
    const saved: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    const material =
      typeof saved === 'object' && saved !== null
        ? (saved as Record<string, unknown>)['material']
        : undefined
    return parseWindowMaterial(material)
  } catch {
    return undefined
  }
}

export function saveWindowMaterial(filePath: string, material: WindowMaterial): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${JSON.stringify({ material })}\n`, { encoding: 'utf8', mode: 0o600 })
}
