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
 * - image: a local picture, resized, blurred and dimmed behind the panes.
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
}

export const APP_BACKGROUND_KEY = 'harness.appBackground'
export const APP_BACKGROUND_EFFECT_KEY = 'harness.appBackground.effect'
export const APP_BACKGROUND_MATERIAL_KEY = 'harness.appBackground.material'
export const APP_BACKGROUND_IMAGE_KEY = 'harness.appBackground.image'
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

export function parseAppBackground(values: {
  mode: string | null
  effect: string | null
  material: string | null
  image: string | null
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
  }
}

export function readAppBackground(): AppBackground {
  snapshot ??= parseAppBackground({
    mode: readStored(APP_BACKGROUND_KEY),
    effect: readStored(APP_BACKGROUND_EFFECT_KEY),
    material: readStored(APP_BACKGROUND_MATERIAL_KEY),
    image: readStored(APP_BACKGROUND_IMAGE_KEY),
  })
  return snapshot
}

export function writeAppBackground(updates: Partial<AppBackground>): void {
  const current = readAppBackground()
  const next = { ...current, ...updates }
  if (
    next.mode === current.mode &&
    next.effect === current.effect &&
    next.material === current.material &&
    next.image === current.image
  ) {
    return
  }
  if (next.mode !== current.mode) writeStored(APP_BACKGROUND_KEY, next.mode)
  if (next.effect !== current.effect) writeStored(APP_BACKGROUND_EFFECT_KEY, next.effect)
  if (next.material !== current.material) writeStored(APP_BACKGROUND_MATERIAL_KEY, next.material)
  if (next.image !== current.image) writeStored(APP_BACKGROUND_IMAGE_KEY, next.image)
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
