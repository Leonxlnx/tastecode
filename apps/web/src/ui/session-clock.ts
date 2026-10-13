/**
 * One shared clock for the relative times on chat rows. A single interval
 * serves every visible row and only runs while a row is listening, so a rail
 * with nothing to date costs nothing. Rows read it through
 * useSyncExternalStore, so a tick re-renders the time labels and nothing else.
 */
const TICK_MS = 30_000

let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function tick(): void {
  // A hidden window has nobody to show the time to; visibilitychange catches up.
  if (document.visibilityState === 'hidden') return
  now = Date.now()
  for (const listener of listeners) listener()
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'hidden') tick()
}

export function subscribeSessionClock(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    now = Date.now()
    timer = setInterval(tick, TICK_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    clearInterval(timer)
    timer = undefined
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

export function readSessionClock(): number {
  return now
}

/** "now", "5m", "3h", "2d", "3w", "4mo", "1y": short enough to sit beside a title. */
export function compactRelativeTime(at: number, current: number): string {
  const minutes = Math.floor(Math.max(0, current - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}
