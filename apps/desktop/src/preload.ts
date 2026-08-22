import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PreviewCaptureRequest, PreviewCaptureResult } from '@harness/contracts'
import type { AppUpdateState } from './app-updater.js'
import { clipboardText } from './clipboard-text.js'
import { isNativeMenuAction } from './menu-contract.js'
import { isAppUpdateState, isFiniteNumber } from './preload-validation.js'

type PickedAttachment = {
  path: string
  name: string
  mediaType?: 'image' | 'video'
  previewUrl?: string
  thumbnailUrl?: string
}

const startupStartedAt = Number(process.env['HARNESS_STARTUP_STARTED_AT'])
const startupBenchmarkEnabled = Number.isFinite(startupStartedAt) && startupStartedAt > 0

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
  pickFiles: (): Promise<PickedAttachment[]> => ipcRenderer.invoke('harness:pickFiles'),
  previewViewedImage: (reference: string): Promise<PickedAttachment | undefined> =>
    ipcRenderer.invoke('harness:previewViewedImage', reference),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('harness:revealPath', path),
  revealProjectFile: (path: string, projectPath: string): Promise<void> =>
    ipcRenderer.invoke('harness:revealProjectFile', path, projectPath),
  savePastedFile: (file: {
    name: string
    type: string
    bytes: ArrayBuffer
  }): Promise<PickedAttachment> => ipcRenderer.invoke('harness:savePastedFile', file),
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
  getUpdateState: (): Promise<AppUpdateState> => ipcRenderer.invoke('harness:getUpdateState'),
  checkForUpdates: (): Promise<AppUpdateState> => ipcRenderer.invoke('harness:checkForUpdates'),
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke('harness:installUpdate'),
  setMenuShortcuts: (shortcuts: unknown): void =>
    ipcRenderer.send('harness:setMenuShortcuts', shortcuts),
  onMenuAction: (listener: (action: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, action: unknown) => {
      if (isNativeMenuAction(action)) listener(action)
    }
    ipcRenderer.on('harness:menuAction', handler)
    return () => ipcRenderer.removeListener('harness:menuAction', handler)
  },
  onUpdateState: (listener: (state: AppUpdateState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown) => {
      if (isAppUpdateState(state)) listener(state)
    }
    ipcRenderer.on('harness:updateState', handler)
    return () => ipcRenderer.removeListener('harness:updateState', handler)
  },
  onZoomChange: (listener: (factor: number) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, factor: unknown) => {
      if (isFiniteNumber(factor)) listener(factor)
    }
    ipcRenderer.on('harness:zoomChanged', handler)
    return () => ipcRenderer.removeListener('harness:zoomChanged', handler)
  },
  ...(startupBenchmarkEnabled
    ? {
        reportStartupMilestone: (name: string): void =>
          ipcRenderer.send('harness:startupRendererMilestone', name),
      }
    : {}),
  isDesktop: true,
}

contextBridge.exposeInMainWorld('harness', api)

if (startupBenchmarkEnabled) {
  ipcRenderer.send('harness:startupPreloadReady', Date.now() - startupStartedAt)
}

export type HarnessBridge = typeof api

type NativeHapticPattern = 'alignment' | 'generic'
