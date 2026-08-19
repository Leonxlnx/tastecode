import type { Session } from 'electron'

export async function clearPreviewSession(
  previewSession: Pick<Session, 'clearStorageData' | 'clearCache'>,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => previewSession.clearStorageData()),
    Promise.resolve().then(() => previewSession.clearCache()),
  ])
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
  }

  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Preview storage and cache cleanup failed')
  }
}
