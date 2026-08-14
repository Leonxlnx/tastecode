import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PreviewCaptureRequest, PreviewCaptureResult } from '@harness/contracts'
import { clipboardText } from './clipboard-text.js'

/**
 * The entire native surface exposed to the renderer.
 *
 * Everything else goes over the server socket, because the renderer is the
 * least trusted process in the app and every function added here is permanent
 * attack surface. Native dialogs, window-integrated surfaces, trackpad
 * feedback, and materializing validated clipboard images are the operations
 * that cannot work through the browser surface.
 */
const api = {
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('harness:pickFolder'),
  pickSkillFolder: (): Promise<string | undefined> => ipcRenderer.invoke('harness:pickSkillFolder'),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('harness:pickFiles'),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('harness:revealPath', path),
  revealProjectFile: (path: string, projectPath: string): Promise<void> =>
    ipcRenderer.invoke('harness:revealProjectFile', path, projectPath),
  savePastedFile: (file: { name: string; type: string; bytes: ArrayBuffer }): Promise<string> =>
    ipcRenderer.invoke('harness:savePastedFile', file),
  writeClipboardText: (text: string): Promise<void> =>
    ipcRenderer.invoke('harness:writeClipboardText', clipboardText(text)),
  setZoom: (action: 'in' | 'out' | 'reset'): Promise<void> =>
    ipcRenderer.invoke('harness:setZoom', action),
  setTheme: (preference: 'system' | 'light' | 'dark'): Promise<void> =>
    ipcRenderer.invoke('harness:setTheme', preference),
  prepareHaptics: (): void => ipcRenderer.send('harness:hapticsPrepare'),
  performHaptic: (pattern: NativeHapticPattern): void =>
    ipcRenderer.send('harness:hapticFeedback', pattern),
  capturePreview: (request: PreviewCaptureRequest): Promise<PreviewCaptureResult> =>
    ipcRenderer.invoke('harness:capturePreview', request),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('harness:openExternal', url),
  getDiagnosticsEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke('harness:getDiagnosticsEnabled'),
  setDiagnosticsEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('harness:setDiagnosticsEnabled', enabled),
  openDiagnostics: (): Promise<boolean> => ipcRenderer.invoke('harness:openDiagnostics'),
  reportRendererError: (message: string): void =>
    ipcRenderer.send('harness:reportRendererError', message.slice(0, 4_000)),
  onZoomChange: (listener: (factor: number) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, factor: unknown) => {
      if (typeof factor === 'number' && Number.isFinite(factor)) listener(factor)
    }
    ipcRenderer.on('harness:zoomChanged', handler)
    return () => ipcRenderer.removeListener('harness:zoomChanged', handler)
  },
  isDesktop: true,
}

contextBridge.exposeInMainWorld('harness', api)

export type HarnessBridge = typeof api

type NativeHapticPattern = 'alignment' | 'generic'
