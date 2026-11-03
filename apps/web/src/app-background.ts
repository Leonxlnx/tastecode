import {
  desktopWindowMaterialSupport,
  isDesktop,
  type WindowMaterial,
  type WindowMaterialSupport,
} from './bridge.js'

/**
 * Settings › Appearance › Window background: what the window shows behind
 * the sidebar and the chat. One choice for light and dark alike; every
 * option keeps the panes it shows through readable in both.
 *
 * - none: today's look, and the default.
 * - transparent: the OS backdrop (Windows 11 Acrylic or Mica, macOS
 *   vibrancy). Where the OS cannot draw one the look stays unchanged.
 * - image: a local picture, resized, blurred and dimmed behind the panes;
 *   how much of each is set with Dim and Blur.
 * - effect: a CSS backdrop preset (glow, grain or aurora).
 */
export type AppBackgroundMode = 'none' | 'transparent' | 'image' | 'effect'
export type AppBackgroundEffect = 'glow' | 'grain' | 'aurora'

export type AppBackground = {
  mode: AppBackgroundMode
  effect: AppBackgroundEffect
  /** The Windows 11 backdrop Transparent asks for. */
  material: WindowMaterial
  /** Changes whenever another image is stored; undefined while none is. */
  image: string | undefined
  /**
   * How strongly the picture is dimmed, 0 to 100. The default, 50, is the
   * dim the window always had; 0 takes it away and 100 doubles it.
   */
  dim: number
  /** Blur of the picture, in pixels of its display copy (see app-background-image.ts). */
  blur: number
}

export const DEFAULT_APP_BACKGROUND_DIM = 50
export const MAX_APP_BACKGROUND_DIM = 100
/** Matches DISPLAY_IMAGE_BLUR, so the stored display copies stay valid. */
export const DEFAULT_APP_BACKGROUND_BLUR = 14
export const MAX_APP_BACKGROUND_BLUR = 40

export const APP_BACKGROUND_KEY = 'harness.appBackground'
export const APP_BACKGROUND_EFFECT_KEY = 'harness.appBackground.effect'
export const APP_BACKGROUND_MATERIAL_KEY = 'harness.appBackground.material'
export const APP_BACKGROUND_IMAGE_KEY = 'harness.appBackground.image'
export const APP_BACKGROUND_DIM_KEY = 'harness.appBackground.dim'
export const APP_BACKGROUND_BLUR_KEY = 'harness.appBackground.blur'
const CHANGE_EVENT = 'harness:appBackground'

const MODES = new Set<AppBackgroundMode>(['none', 'transparent', 'image', 'effect'])
const EFFECTS = new Set<AppBackgroundEffect>(['glow', 'grain', 'aurora'])
const IMAGE_REVISION = /^[a-z0-9-]{1,64}$/i

/** Kept in memory so a render never reads storage; refreshed by every write. */
let snapshot: AppBackground | undefined
/** Where writes go while localStorage throws (site data blocked). */
const sessionValues = new Map<string, string | null>()

function readStored(key: string): string | null {
  if (sessionValues.has(key)) return sessionValues.get(key) ?? null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    sessionValues.delete(key)
  } catch {
    sessionValues.set(key, value ?? null)
  }
}

/** A whole number from 0 to `max` as stored, or `fallback` for anything else. */
function parseLevel(value: string | null | undefined, max: number, fallback: number): number {
  if (value === null || value === undefined || !/^\d{1,3}$/.test(value)) return fallback
  const level = Number(value)
  return level <= max ? level : fallback
}

/** The --app-bg-dim factor for a Dim level: 1 at the default, 0 to 2 across the slider. */
export function dimFactor(dim: number): string {
  return String(dim / DEFAULT_APP_BACKGROUND_DIM)
}

/** Keeps a level a whole number from 0 to `max`. */
export function clampLevel(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(max, Math.max(0, Math.round(value)))
}

export function parseAppBackground(values: {
  mode: string | null
  effect: string | null
  material: string | null
  image: string | null
  dim?: string | null
  blur?: string | null
}): AppBackground {
  const image =
    values.image !== null && IMAGE_REVISION.test(values.image) ? values.image : undefined
  return {
    mode: MODES.has(values.mode as AppBackgroundMode) ? (values.mode as AppBackgroundMode) : 'none',
    effect: EFFECTS.has(values.effect as AppBackgroundEffect)
      ? (values.effect as AppBackgroundEffect)
      : 'glow',
    material: values.material === 'mica' ? 'mica' : 'acrylic',
    image,
    dim: parseLevel(values.dim, MAX_APP_BACKGROUND_DIM, DEFAULT_APP_BACKGROUND_DIM),
    blur: parseLevel(values.blur, MAX_APP_BACKGROUND_BLUR, DEFAULT_APP_BACKGROUND_BLUR),
  }
}

export function readAppBackground(): AppBackground {
  snapshot ??= parseAppBackground({
    mode: readStored(APP_BACKGROUND_KEY),
    effect: readStored(APP_BACKGROUND_EFFECT_KEY),
    material: readStored(APP_BACKGROUND_MATERIAL_KEY),
    image: readStored(APP_BACKGROUND_IMAGE_KEY),
    dim: readStored(APP_BACKGROUND_DIM_KEY),
    blur: readStored(APP_BACKGROUND_BLUR_KEY),
  })
  return snapshot
}

export function writeAppBackground(updates: Partial<AppBackground>): void {
  const current = readAppBackground()
  const next = { ...current, ...updates }
  next.dim = clampLevel(next.dim, MAX_APP_BACKGROUND_DIM)
  next.blur = clampLevel(next.blur, MAX_APP_BACKGROUND_BLUR)
  if (
    next.mode === current.mode &&
    next.effect === current.effect &&
    next.material === current.material &&
    next.image === current.image &&
    next.dim === current.dim &&
    next.blur === current.blur
  ) {
    return
  }
  if (next.mode !== current.mode) writeStored(APP_BACKGROUND_KEY, next.mode)
  if (next.effect !== current.effect) writeStored(APP_BACKGROUND_EFFECT_KEY, next.effect)
  if (next.material !== current.material) writeStored(APP_BACKGROUND_MATERIAL_KEY, next.material)
  if (next.image !== current.image) writeStored(APP_BACKGROUND_IMAGE_KEY, next.image)
  if (next.dim !== current.dim) writeStored(APP_BACKGROUND_DIM_KEY, String(next.dim))
  if (next.blur !== current.blur) writeStored(APP_BACKGROUND_BLUR_KEY, String(next.blur))
  snapshot = next
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeAppBackground(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

/** A new image revision: unique per store, safe in a storage value. */
export function nextImageRevision(now = Date.now()): string {
  return `${now.toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`
}

let materialSupport: WindowMaterialSupport | undefined = isDesktop ? undefined : 'none'
let materialSupportRequest: Promise<WindowMaterialSupport> | undefined

/**
 * What the OS can draw behind the window, asked of the desktop shell once.
 * Undefined until it answers; a browser can draw nothing.
 */
export function windowMaterialSupport(): WindowMaterialSupport | undefined {
  return materialSupport
}

export function requestWindowMaterialSupport(): Promise<WindowMaterialSupport> {
  materialSupportRequest ??= desktopWindowMaterialSupport().then((support) => {
    materialSupport = support
    window.dispatchEvent(new Event(CHANGE_EVENT))
    return support
  })
  return materialSupportRequest
}

/** Forget the cached choice and support; tests only. */
export function resetAppBackgroundForTests(): void {
  snapshot = undefined
  sessionValues.clear()
  materialSupport = isDesktop ? undefined : 'none'
  materialSupportRequest = undefined
}
