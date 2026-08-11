/** The model picker ships two layouts: the original flat list (default) and
 *  the provider-rail catalog. The choice is an appearance preference so it
 *  lives next to theme/font in localStorage, with a window event so an open
 *  picker re-renders when Settings flips it. */

export type ModelPickerLayout = 'list' | 'rail'

export const MODEL_PICKER_LAYOUT_KEY = 'harness.modelPickerLayout'
const CHANGE_EVENT = 'harness:model-picker-layout'
let sessionLayout: ModelPickerLayout | undefined

export function readModelPickerLayout(): ModelPickerLayout {
  if (sessionLayout) return sessionLayout
  try {
    return localStorage.getItem(MODEL_PICKER_LAYOUT_KEY) === 'rail' ? 'rail' : 'list'
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
