/** Whether code blocks soft-wrap long lines: one choice for every block, remembered per user. */
export const CODE_WRAP_KEY = 'harness.codeWrap'
const CHANGE_EVENT = 'harness:code-wrap'
let sessionPreference: boolean | undefined

export function readCodeWrap(): boolean {
  if (sessionPreference !== undefined) return sessionPreference
  try {
    return localStorage.getItem(CODE_WRAP_KEY) === 'on'
  } catch {
    return false
  }
}

/**
 * The document root carries the choice, so a toggle restyles every block,
 * streaming ones included, through CSS alone: no block renders again and no
 * code is highlighted again.
 */
export function applyCodeWrap(wrap: boolean = readCodeWrap()): void {
  const root = document.documentElement
  if (wrap) root.dataset.codeWrap = 'on'
  else delete root.dataset.codeWrap
}

export function writeCodeWrap(wrap: boolean): void {
  try {
    localStorage.setItem(CODE_WRAP_KEY, wrap ? 'on' : 'off')
    sessionPreference = undefined
  } catch {
    sessionPreference = wrap
  }
  applyCodeWrap(wrap)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeCodeWrap(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}
