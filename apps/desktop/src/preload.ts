import { contextBridge, ipcRenderer } from 'electron'

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
  savePastedImage: (image: { type: string; bytes: ArrayBuffer }): Promise<string> =>
    ipcRenderer.invoke('harness:savePastedImage', image),
  isDesktop: true,
}

contextBridge.exposeInMainWorld('harness', api)

export type HarnessBridge = typeof api
