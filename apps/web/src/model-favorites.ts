/** Models starred in the picker's provider rail, stored by model choice key.
 *  Like the picker layout, this is a per-device preference in localStorage,
 *  with a window event so every open picker stays in step. */

export const MODEL_FAVORITES_KEY = 'harness.favoriteModels'
const CHANGE_EVENT = 'harness:model-favorites'
const NONE: readonly string[] = []
let sessionFavorites: readonly string[] | undefined
let cachedRaw: string | null = null
let cachedFavorites: readonly string[] = NONE

/** Returns the same array until the stored value changes, as
 *  useSyncExternalStore requires. */
export function readModelFavorites(): readonly string[] {
  if (sessionFavorites) return sessionFavorites
  let raw: string | null
  try {
    raw = localStorage.getItem(MODEL_FAVORITES_KEY)
  } catch {
    return NONE
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedFavorites = parseFavorites(raw)
  }
  return cachedFavorites
}

export function toggleModelFavorite(key: string): void {
  const current = readModelFavorites()
  const next = current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
  try {
    localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(next))
    sessionFavorites = undefined
  } catch {
    // Site data blocked: keep the stars for this session even though they
    // cannot persist across launches.
    sessionFavorites = next
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeModelFavorites(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

function parseFavorites(raw: string | null): readonly string[] {
  if (!raw) return NONE
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : NONE
  } catch {
    return NONE
  }
}
