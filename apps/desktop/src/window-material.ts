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
