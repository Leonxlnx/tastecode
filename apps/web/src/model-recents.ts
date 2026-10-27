/**
 * The model and effort pairs the user actually sent with, newest first, for
 * the ledger picker's "Recent" rows. Picking alone records nothing: a pair
 * joins only when a message leaves with it. Kept per browser profile, like
 * the picker layout; losing it costs a shortcut, never a setting.
 */

export const MODEL_RECENTS_KEY = 'harness.modelRecents'
const CHANGE_EVENT = 'harness:model-recents'
/** One more than the picker shows, so the pair in use can be left out and three remain. */
export const MODEL_RECENTS_KEPT = 4

export type ModelRecent = {
  /** The model choice key, as `ModelChoice.key`. */
  key: string
  effort?: string | undefined
  serviceTier?: string | undefined
  /** When a message last left with this pair, Unix milliseconds. */
  at: number
}

let sessionRecents: ModelRecent[] | undefined
let cachedRaw: string | null | undefined
let cachedRecents: ModelRecent[] = []

function parseRecents(raw: string | null): ModelRecent[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const recents: ModelRecent[] = []
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record['key'] !== 'string' || !record['key']) continue
      if (typeof record['at'] !== 'number' || !Number.isFinite(record['at'])) continue
      recents.push({
        key: record['key'],
        at: record['at'],
        ...(typeof record['effort'] === 'string' ? { effort: record['effort'] } : {}),
        ...(typeof record['serviceTier'] === 'string'
          ? { serviceTier: record['serviceTier'] }
          : {}),
      })
      if (recents.length === MODEL_RECENTS_KEPT) break
    }
    return recents
  } catch {
    return []
  }
}

/** Stable between changes, so it can back `useSyncExternalStore`. */
export function readModelRecents(): ModelRecent[] {
  if (sessionRecents) return sessionRecents
  let raw: string | null
  try {
    raw = localStorage.getItem(MODEL_RECENTS_KEY)
  } catch {
    return cachedRecents
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedRecents = parseRecents(raw)
  }
  return cachedRecents
}

/** The same pair moves to the front instead of appearing twice. */
export function recordModelRecent(
  entry: { key: string; effort?: string | undefined; serviceTier?: string | undefined },
  now = Date.now(),
): void {
  if (!entry.key) return
  const next: ModelRecent = {
    key: entry.key,
    at: now,
    ...(entry.effort ? { effort: entry.effort } : {}),
    ...(entry.serviceTier ? { serviceTier: entry.serviceTier } : {}),
  }
  const current = readModelRecents()
  if (current[0]?.key === next.key && current[0].effort === next.effort) {
    if (current[0].serviceTier === next.serviceTier) return
  }
  const recents = [
    next,
    ...current.filter((recent) => !(recent.key === next.key && recent.effort === next.effort)),
  ].slice(0, MODEL_RECENTS_KEPT)
  try {
    localStorage.setItem(MODEL_RECENTS_KEY, JSON.stringify(recents))
    sessionRecents = undefined
  } catch {
    // Site data blocked: the pairs last for this session.
    sessionRecents = recents
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeModelRecents(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  // Another window of the app sent a message.
  const onStorage = (event: StorageEvent) => {
    if (event.key === MODEL_RECENTS_KEY) onChange()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}
