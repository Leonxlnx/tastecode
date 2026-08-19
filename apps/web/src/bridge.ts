import type { PreviewCaptureRequest, PreviewCaptureResult } from '@harness/contracts'
import { z } from 'zod'

/**
 * The native bridge, when one exists.
 *
 * The same UI runs in a browser during development and in Electron in
 * production, so every native call has to degrade rather than crash. Anything
 * that cannot work without the bridge is hidden, not shown broken.
 */
export const PickedAttachmentSchema = z.object({
  path: z.string(),
  name: z.string(),
  mediaType: z.enum(['image', 'video']).optional(),
  previewUrl: z.string().optional(),
  thumbnailUrl: z.string().optional(),
})

export type PickedAttachment = z.infer<typeof PickedAttachmentSchema>

export type Bridge = {
  pickFolder: () => Promise<string | undefined>
  pickSkillFolder: () => Promise<string | undefined>
  pickFiles: () => Promise<Array<PickedAttachment | string>>
  previewViewedImage?: (reference: string) => Promise<PickedAttachment | undefined>
  revealPath: (path: string) => Promise<void>
  revealProjectFile?: (path: string, projectPath: string) => Promise<void>
  savePastedFile: (file: {
    name: string
    type: string
    bytes: ArrayBuffer
  }) => Promise<PickedAttachment | string>
  writeClipboardText?: (text: string) => Promise<void>
  setZoom: (action: ZoomAction) => Promise<void>
  setTheme: (preference: AppThemePreference) => Promise<void>
  prepareHaptics?: () => void
  performHaptic?: (pattern: NativeHapticPattern) => void
  capturePreview: (request: PreviewCaptureRequest) => Promise<PreviewCaptureResult>
  openExternal: (url: string) => Promise<void>
  getDiagnosticsEnabled?: () => Promise<boolean>
  setDiagnosticsEnabled?: (enabled: boolean) => Promise<boolean>
  openDiagnostics?: () => Promise<boolean>
  reportRendererError?: (message: string) => void
  getUpdateState?: () => Promise<AppUpdateState>
  checkForUpdates?: () => Promise<AppUpdateState>
  installUpdate?: () => Promise<boolean>
  onUpdateState?: (listener: (state: AppUpdateState) => void) => () => void
  onZoomChange: (listener: (factor: number) => void) => () => void
  isDesktop: true
}

declare global {
  interface Window {
    harness?: Bridge
  }
}

export type ZoomAction = 'in' | 'out' | 'reset'
export type AppTheme = 'light' | 'dark'
export type AppThemePreference = AppTheme | 'system'
export type NativeHapticPattern = 'alignment' | 'generic'
export type AppUpdateState = {
  status: 'unsupported' | 'idle' | 'checking' | 'downloading' | 'current' | 'ready' | 'error'
  currentVersion: string
  version?: string
  progress?: number
  error?: string
}

const bridge = window.harness
const attachmentPreviews = new Map<string, PickedAttachment>()

export const isDesktop = bridge?.isDesktop === true
export const canCapturePreview = bridge?.capturePreview !== undefined
export const canRevealProjectFile = bridge?.revealProjectFile !== undefined

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

export async function pickFiles(): Promise<PickedAttachment[]> {
  if (bridge) {
    const files = await bridge.pickFiles()
    const picked = files.map((file) => {
      const path = z.string().safeParse(file)
      return path.success
        ? { path: path.data, name: attachmentName(path.data) }
        : PickedAttachmentSchema.parse(file)
    })
    for (const attachment of picked) attachmentPreviews.set(attachment.path, attachment)
    return picked
  }
  const typed = window.prompt('Full path of a file to attach')?.trim()
  return typed ? [{ path: typed, name: attachmentName(typed) }] : []
}

function attachmentName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

export function revealPath(path: string): Promise<void> {
  return bridge?.revealPath(path) ?? Promise.resolve()
}

export function revealProjectFile(path: string, projectPath: string): Promise<void> {
  return bridge?.revealProjectFile?.(path, projectPath) ?? Promise.resolve()
}

export async function previewViewedImage(reference: string): Promise<PickedAttachment | undefined> {
  const cached = attachmentPreviews.get(reference)
  if (cached) return cached
  try {
    const direct = await bridge?.previewViewedImage?.(reference)
    const preview =
      direct ??
      (attachmentName(reference) === reference
        ? undefined
        : await bridge?.previewViewedImage?.(attachmentName(reference)))
    if (preview) attachmentPreviews.set(reference, preview)
    return preview
  } catch {
    return undefined
  }
}

export async function savePastedFile(file: File): Promise<PickedAttachment | undefined> {
  if (!bridge) return undefined
  const saved = await bridge.savePastedFile({
    name: file.name,
    type: file.type,
    bytes: await file.arrayBuffer(),
  })
  const path = z.string().safeParse(saved)
  const attachment = path.success
    ? { path: path.data, name: attachmentName(path.data) }
    : PickedAttachmentSchema.parse(saved)
  attachmentPreviews.set(attachment.path, attachment)
  return attachment
}

export async function writeClipboardText(text: string): Promise<void> {
  if (bridge?.writeClipboardText) return bridge.writeClipboardText(text)
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable')
  await navigator.clipboard.writeText(text)
}

export function setAppZoom(action: ZoomAction): Promise<void> {
  return bridge?.setZoom(action) ?? Promise.resolve()
}

export function setDesktopTheme(preference: AppThemePreference): Promise<void> {
  return bridge?.setTheme(preference) ?? Promise.resolve()
}

export function prepareNativeHaptics(): void {
  bridge?.prepareHaptics?.()
}

export function performNativeHaptic(pattern: NativeHapticPattern): void {
  bridge?.performHaptic?.(pattern)
}

export function onAppZoomChange(listener: (factor: number) => void): () => void {
  return bridge?.onZoomChange(listener) ?? (() => undefined)
}

export async function capturePreview(
  request: PreviewCaptureRequest,
): Promise<PreviewCaptureResult> {
  if (!bridge) {
    return { status: 'failed', requestId: request.requestId, error: 'Preview capture unavailable' }
  }
  try {
    return await bridge.capturePreview(request)
  } catch (error) {
    return {
      status: 'failed',
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function openExternalUrl(url: string): Promise<void> {
  if (!url) return Promise.resolve()
  return bridge?.openExternal(url) ?? Promise.resolve()
}

export function localDiagnosticsEnabled(): Promise<boolean> {
  return bridge?.getDiagnosticsEnabled?.() ?? Promise.resolve(false)
}

export function setLocalDiagnosticsEnabled(enabled: boolean): Promise<boolean> {
  return bridge?.setDiagnosticsEnabled?.(enabled) ?? Promise.resolve(false)
}

export function openLocalDiagnostics(): Promise<boolean> {
  return bridge?.openDiagnostics?.() ?? Promise.resolve(false)
}

export function reportRendererError(cause: unknown): void {
  const message = cause instanceof Error ? cause.stack || cause.message : String(cause)
  bridge?.reportRendererError?.(message.slice(0, 4_000))
}

const unsupportedUpdate: AppUpdateState = {
  status: 'unsupported',
  currentVersion: 'pre-release',
}

export function appUpdateState(): Promise<AppUpdateState> {
  return bridge?.getUpdateState?.() ?? Promise.resolve(unsupportedUpdate)
}

export function checkForAppUpdates(): Promise<AppUpdateState> {
  return bridge?.checkForUpdates?.() ?? Promise.resolve(unsupportedUpdate)
}

export function installAppUpdate(): Promise<boolean> {
  return bridge?.installUpdate?.() ?? Promise.resolve(false)
}

export function onAppUpdateState(listener: (state: AppUpdateState) => void): () => void {
  return bridge?.onUpdateState?.(listener) ?? (() => undefined)
}
