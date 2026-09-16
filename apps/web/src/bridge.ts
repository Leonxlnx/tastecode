import type { PreviewCaptureRequest, PreviewCaptureResult } from '@harness/contracts'
import type { KeybindingId, Keybindings, Shortcut } from './shortcuts.js'

/**
 * The native bridge, when one exists.
 *
 * The same UI runs in a browser during development and in Electron in
 * production, so every native call has to degrade rather than crash. Anything
 * that cannot work without the bridge is hidden, not shown broken.
 */
export type PickedAttachment = {
  path: string
  name: string
  mediaType?: 'image' | 'video' | undefined
  previewUrl?: string | undefined
  thumbnailUrl?: string | undefined
}

type Bridge = {
  pickFolder: () => Promise<string | undefined>
  droppedFolderPaths?: (files: File[]) => Promise<string[]>
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
  cancelPreviewCapture?: (requestId: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  getDiagnosticsEnabled?: () => Promise<boolean>
  setDiagnosticsEnabled?: (enabled: boolean) => Promise<boolean>
  openDiagnostics?: () => Promise<boolean>
  reportRendererError?: (message: string) => void
  getUpdateState?: () => Promise<AppUpdateState>
  checkForUpdates?: () => Promise<AppUpdateState>
  installUpdate?: () => Promise<boolean>
  setMenuShortcuts?: (shortcuts: NativeMenuShortcuts) => void
  onMenuAction?: (listener: (action: NativeMenuAction) => void) => () => void
  onUpdateState?: (listener: (state: AppUpdateState) => void) => () => void
  onZoomChange: (listener: (factor: number) => void) => () => void
  reportStartupMilestone?: (name: RendererStartupMilestone) => void
  isDesktop: true
}

export type RendererStartupMilestone =
  | 'module-loaded'
  | 'react-commit'
  | 'first-frame'
  | 'projects-requested'
  | 'projects-frame-parsed'
  | 'projects-validated'
  | 'projects-received'
  | 'projects-reconciled'
  | 'projects-ready'
  | 'catalog-ready'

declare global {
  interface Window {
    harness?: Bridge
  }
}

export type ZoomAction = 'in' | 'out' | 'reset'
type AppTheme = 'light' | 'dark' | 'codex'
export type AppThemePreference = AppTheme | 'system'
export type NativeHapticPattern = 'alignment' | 'generic'
const NATIVE_MENU_ACTION_IDS = [
  'commandPalette',
  'settings',
  'keybindings',
  'toggleSidebar',
  'newChat',
  'searchSessions',
  'focusComposer',
  'interrupt',
  'previousChat',
  'nextChat',
  'toggleSessionPin',
  'archiveSession',
  'rollback',
  'switchProject',
  'newProject',
  'openPullRequests',
  'toggleTerminal',
  'toggleWorkspace',
  'toggleFastMode',
  'toggleDesignMode',
  'toggleIsolatedSession',
] as const satisfies readonly KeybindingId[]
export type NativeMenuAction = (typeof NATIVE_MENU_ACTION_IDS)[number]
type NativeMenuShortcuts = Record<NativeMenuAction, Shortcut | null>
export type AppUpdateState = {
  status:
    'unsupported' | 'manual' | 'idle' | 'checking' | 'downloading' | 'current' | 'ready' | 'error'
  currentVersion: string
  version?: string
  progress?: number
  error?: string
}

const bridge = window.harness
export const MAX_CACHED_ATTACHMENT_PREVIEWS = 128
const attachmentPreviews = new Map<string, PickedAttachment>()

function rememberAttachmentPreview(reference: string, attachment: PickedAttachment): void {
  // Signed preview URLs are cheap to recreate through the desktop bridge. Keep
  // the recent working set hot without retaining every attachment ever used.
  attachmentPreviews.delete(reference)
  attachmentPreviews.set(reference, attachment)
  while (attachmentPreviews.size > MAX_CACHED_ATTACHMENT_PREVIEWS) {
    const oldest = attachmentPreviews.keys().next().value
    if (oldest === undefined) break
    attachmentPreviews.delete(oldest)
  }
}

export const isDesktop = bridge?.isDesktop === true
export const isStartupBenchmark = bridge?.reportStartupMilestone !== undefined
export const canCapturePreview = bridge?.capturePreview !== undefined
export const canRevealProjectFile = bridge?.revealProjectFile !== undefined
export const canDropProjectFolders = bridge?.droppedFolderPaths !== undefined

export function reportStartupMilestone(name: RendererStartupMilestone): void {
  bridge?.reportStartupMilestone?.(name)
}

export function isMacOS(): boolean {
  return navigator.platform.startsWith('Mac')
}

export async function pickFolder(): Promise<string | undefined> {
  if (bridge) return bridge.pickFolder()
  return window.prompt('Folder to work in')?.trim() || undefined
}

export async function droppedProjectFolderPaths(files: ArrayLike<File>): Promise<string[]> {
  try {
    return (await bridge?.droppedFolderPaths?.(Array.from(files))) ?? []
  } catch {
    return []
  }
}

export async function pickSkillFolder(): Promise<string | undefined> {
  if (bridge) return bridge.pickSkillFolder()
  return window.prompt('Full path of an Agent Skill folder')?.trim() || undefined
}

export async function pickFiles(): Promise<PickedAttachment[]> {
  if (bridge) {
    const files = await bridge.pickFiles()
    const picked = files.map((file) =>
      typeof file === 'string'
        ? { path: file, name: attachmentName(file) }
        : parsePickedAttachment(file),
    )
    for (const attachment of picked) rememberAttachmentPreview(attachment.path, attachment)
    return picked
  }
  const typed = window.prompt('Full path of a file to attach')?.trim()
  return typed ? [{ path: typed, name: attachmentName(typed) }] : []
}

function attachmentName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

function parsePickedAttachment(value: unknown): PickedAttachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The native file picker returned invalid data.')
  }
  const attachment = value as Record<string, unknown>
  const path = attachment['path']
  const name = attachment['name']
  const mediaType = attachment['mediaType']
  const previewUrl = attachment['previewUrl']
  const thumbnailUrl = attachment['thumbnailUrl']
  if (
    typeof path !== 'string' ||
    typeof name !== 'string' ||
    (mediaType !== undefined && mediaType !== 'image' && mediaType !== 'video') ||
    (previewUrl !== undefined && typeof previewUrl !== 'string') ||
    (thumbnailUrl !== undefined && typeof thumbnailUrl !== 'string')
  ) {
    throw new Error('The native file picker returned invalid data.')
  }
  return {
    path,
    name,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(previewUrl === undefined ? {} : { previewUrl }),
    ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
  }
}

export function revealPath(path: string): Promise<void> {
  return bridge?.revealPath(path) ?? Promise.resolve()
}

export function revealProjectFile(path: string, projectPath: string): Promise<void> {
  return bridge?.revealProjectFile?.(path, projectPath) ?? Promise.resolve()
}

export async function previewViewedImage(reference: string): Promise<PickedAttachment | undefined> {
  const cached = attachmentPreviews.get(reference)
  if (cached) {
    rememberAttachmentPreview(reference, cached)
    return cached
  }
  try {
    const direct = await bridge?.previewViewedImage?.(reference)
    const preview =
      direct ??
      (attachmentName(reference) === reference
        ? undefined
        : await bridge?.previewViewedImage?.(attachmentName(reference)))
    if (preview) rememberAttachmentPreview(reference, preview)
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
  const attachment =
    typeof saved === 'string'
      ? { path: saved, name: attachmentName(saved) }
      : parsePickedAttachment(saved)
  rememberAttachmentPreview(attachment.path, attachment)
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

export function syncNativeMenuShortcuts(keybindings: Keybindings): void {
  const shortcuts = Object.fromEntries(
    NATIVE_MENU_ACTION_IDS.map((action) => [action, keybindings[action]]),
  ) as NativeMenuShortcuts
  bridge?.setMenuShortcuts?.(shortcuts)
}

export function onNativeMenuAction(listener: (action: NativeMenuAction) => void): () => void {
  return bridge?.onMenuAction?.(listener) ?? (() => undefined)
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

export async function cancelPreviewCapture(requestId: string): Promise<void> {
  await bridge?.cancelPreviewCapture?.(requestId)
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
