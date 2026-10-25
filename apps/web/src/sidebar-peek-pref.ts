/** Design lab prototype switch for the sidebar peek (Needs you rows that say
 *  what each chat asks, answered from beside the rail). On in this branch so
 *  it can be judged; Debug settings turns it off to compare with dev's band. */

export const SIDEBAR_PEEK_KEY = 'harness.sidebarPeek'
const CHANGE_EVENT = 'harness:sidebar-peek'
let sessionValue: boolean | undefined

export function readSidebarPeek(): boolean {
  if (sessionValue !== undefined) return sessionValue
  try {
    return localStorage.getItem(SIDEBAR_PEEK_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeSidebarPeek(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(SIDEBAR_PEEK_KEY)
    else localStorage.setItem(SIDEBAR_PEEK_KEY, 'off')
    sessionValue = undefined
  } catch {
    sessionValue = enabled
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeSidebarPeek(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}
