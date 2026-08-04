/**
 * The native bridge, when one exists.
 *
 * The same UI runs in a browser during development and in Electron in
 * production, so every native call has to degrade rather than crash. Anything
 * that cannot work without the bridge is hidden, not shown broken.
 */
type Bridge = {
  pickFolder: () => Promise<string | undefined>
  pickSkillFolder: () => Promise<string | undefined>
  pickFiles: () => Promise<string[]>
  revealPath: (path: string) => Promise<void>
  savePastedImage: (image: { type: string; bytes: ArrayBuffer }) => Promise<string>
  setZoom: (action: ZoomAction) => Promise<void>
  setTheme: (theme: AppTheme) => Promise<void>
  onZoomChange: (listener: (factor: number) => void) => () => void
  isDesktop: true
}

export type ZoomAction = 'in' | 'out' | 'reset'
export type AppTheme = 'light' | 'dark'

const bridge = (globalThis as { harness?: Bridge }).harness

export const isDesktop = bridge?.isDesktop === true

export function isMacOS(): boolean {
  return navigator.platform.startsWith('Mac')
}

export async function pickFolder(): Promise<string | undefined> {
  if (bridge) return bridge.pickFolder()
  return window.prompt('Folder to work in')?.trim() || undefined
}

export async function pickSkillFolder(): Promise<string | undefined> {
  if (bridge) return bridge.pickSkillFolder()
  return window.prompt('Full path of an Agent Skill folder')?.trim() || undefined
}

export async function pickFiles(): Promise<string[]> {
  if (bridge) return bridge.pickFiles()
  const typed = window.prompt('Full path of a file to attach')?.trim()
  return typed ? [typed] : []
}

export function revealPath(path: string): Promise<void> {
  return bridge?.revealPath(path) ?? Promise.resolve()
}

export async function savePastedImage(file: File): Promise<string | undefined> {
  if (!bridge) return undefined
  return bridge.savePastedImage({ type: file.type, bytes: await file.arrayBuffer() })
}

export function setAppZoom(action: ZoomAction): Promise<void> {
  return bridge?.setZoom(action) ?? Promise.resolve()
}

export function setDesktopTheme(theme: AppTheme): Promise<void> {
  return bridge?.setTheme(theme) ?? Promise.resolve()
}

export function onAppZoomChange(listener: (factor: number) => void): () => void {
  return bridge?.onZoomChange(listener) ?? (() => undefined)
}
