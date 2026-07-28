import { contextBridge, ipcRenderer } from 'electron'

/**
 * The entire native surface exposed to the renderer.
 *
 * Deliberately three functions. Everything else goes over the server socket,
 * because the renderer is the least trusted process in the app and every
 * function added here is permanent attack surface. File dialogs are here only
 * because the OS picker cannot be reached any other way, and a browser prompt
 * asking a user to type a path by hand is not a real product.
 */
const api = {
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('harness:pickFolder'),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('harness:pickFiles'),
  isDesktop: true,
}

contextBridge.exposeInMainWorld('harness', api)

export type HarnessBridge = typeof api
