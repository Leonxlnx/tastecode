/** The model picker ships three layouts: the original flat list (default), the
 *  provider-rail catalog, and the ledger (a list beside an inspector, a design
 *  lab prototype). The choice is an appearance preference so it lives next to
 *  theme/font in localStorage, with a window event so an open picker
 *  re-renders when Settings flips it. */

export type ModelPickerLayout = 'list' | 'rail' | 'ledger'

export const MODEL_PICKER_LAYOUT_KEY = 'harness.modelPickerLayout'
const CHANGE_EVENT = 'harness:model-picker-layout'
let sessionLayout: ModelPickerLayout | undefined

function parseLayout(value: string | null): ModelPickerLayout {
  return value === 'rail' || value === 'ledger' ? value : 'list'
}

export function readModelPickerLayout(): ModelPickerLayout {
  if (sessionLayout) return sessionLayout
  try {
    return parseLayout(localStorage.getItem(MODEL_PICKER_LAYOUT_KEY))
  } catch {
    return 'list'
  }
}

export function writeModelPickerLayout(layout: ModelPickerLayout): void {
  try {
    localStorage.setItem(MODEL_PICKER_LAYOUT_KEY, layout)
    sessionLayout = undefined
  } catch {
    // Site data blocked: keep the choice for this session even though it
    // cannot persist across launches.
    sessionLayout = layout
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeModelPickerLayout(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}
