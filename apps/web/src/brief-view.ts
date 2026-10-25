/**
 * Whether chats offer the Brief view beside their conversation. A prototype
 * for Leon to try, so it is off unless turned on in Settings > General. It is
 * a per-device preference, like the model picker layout, with a window event
 * so an open chat's header follows Settings at once.
 */

import type { ThreadState } from './thread-state.js'

export const BRIEF_VIEW_KEY = 'harness.briefView'
const CHANGE_EVENT = 'harness:brief-view'
let sessionValue: boolean | undefined

export function readBriefView(): boolean {
  if (sessionValue !== undefined) return sessionValue
  try {
    return localStorage.getItem(BRIEF_VIEW_KEY) === 'on'
  } catch {
    return false
  }
}

export function writeBriefView(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(BRIEF_VIEW_KEY, 'on')
    else localStorage.removeItem(BRIEF_VIEW_KEY)
    sessionValue = undefined
  } catch {
    // Site data blocked: keep the choice for this session only.
    sessionValue = enabled
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeBriefView(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

/**
 * The switch appears once a chat has finished a turn: before that there is
 * nothing for a Brief to say that the conversation does not. Reads at most
 * the head of the transcript, so it is cheap on every structural update.
 */
export function hasFinishedTurn(
  state: Pick<ThreadState, 'items' | 'running' | 'activeTurn' | 'turnTiming'>,
): boolean {
  if (state.items.length === 0) return false
  if (!state.running) return true
  const active = state.activeTurn?.id
  for (const item of state.items) {
    if (!item.turnId) continue
    return item.turnId !== active
  }
  return Object.values(state.turnTiming).some((timing) => timing.completedAt !== undefined)
}
