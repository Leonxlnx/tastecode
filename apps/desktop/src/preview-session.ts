import type { Session } from 'electron'

export async function clearPreviewSession(
  previewSession: Pick<Session, 'clearStorageData' | 'clearCache'>,
): Promise<void> {
  // A synchronous failure must not prevent the other cleanup from starting.
  const results = await Promise.allSettled([
    Promise.resolve().then(() => previewSession.clearStorageData()),
    Promise.resolve().then(() => previewSession.clearCache()),
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Preview storage cleanup failed')
  }
}
