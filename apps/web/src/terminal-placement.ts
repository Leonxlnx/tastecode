export type TerminalPlacement = 'bottom' | 'workspace'

export const TERMINAL_PLACEMENT_KEY = 'harness.terminalPlacement'
const CHANGE_EVENT = 'harness:terminal-placement'
let sessionPlacement: TerminalPlacement | undefined

export function readTerminalPlacement(): TerminalPlacement {
  if (sessionPlacement) return sessionPlacement
  try {
    return localStorage.getItem(TERMINAL_PLACEMENT_KEY) === 'workspace' ? 'workspace' : 'bottom'
  } catch {
    return 'bottom'
  }
}

export function writeTerminalPlacement(placement: TerminalPlacement): void {
  try {
    localStorage.setItem(TERMINAL_PLACEMENT_KEY, placement)
    sessionPlacement = undefined
  } catch {
    sessionPlacement = placement
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeTerminalPlacement(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}
