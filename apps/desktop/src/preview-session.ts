import type { Session } from 'electron'

export async function clearPreviewSession(
  previewSession: Pick<Session, 'clearStorageData' | 'clearCache'>,
): Promise<void> {
  await Promise.allSettled([previewSession.clearStorageData(), previewSession.clearCache()])
}
