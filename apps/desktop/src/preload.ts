import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PreviewCaptureRequest, PreviewCaptureResult } from '@harness/contracts'

/**
 * The entire native surface exposed to the renderer.
 *
 * Everything else goes over the server socket, because the renderer is the
 * least trusted process in the app and every function added here is permanent
 * attack surface. Native dialogs and materializing validated clipboard images
 * are the only operations that cannot work through the browser surface.
 */
const api = {
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('harness:pickFolder'),
  pickSkillFolder: (): Promise<string | undefined> => ipcRenderer.invoke('harness:pickSkillFolder'),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('harness:pickFiles'),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('harness:revealPath', path),
  savePastedImage: (image: { type: string; bytes: ArrayBuffer }): Promise<string> =>
    ipcRenderer.invoke('harness:savePastedImage', image),
  writeClipboardText: (text: string): Promise<void> =>
    ipcRenderer.invoke('harness:writeClipboardText', text),
  setZoom: (action: 'in' | 'out' | 'reset'): Promise<void> =>
    ipcRenderer.invoke('harness:setZoom', action),
  setTheme: (preference: 'system' | 'light' | 'dark'): Promise<void> =>
    ipcRenderer.invoke('harness:setTheme', preference),
  capturePreview: (request: PreviewCaptureRequest): Promise<PreviewCaptureResult> =>
    ipcRenderer.invoke('harness:capturePreview', request),
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
