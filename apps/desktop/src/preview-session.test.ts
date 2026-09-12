import { describe, expect, it, vi } from 'vitest'
import { clearPreviewSession } from './preview-session.js'

describe('preview session cleanup', () => {
  it('waits for storage and cache cleanup even when one fails', async () => {
    let clearCache: (() => void) | undefined
    const cacheCleared = new Promise<void>((resolve) => {
      clearCache = resolve
    })
    const previewSession = {
      clearStorageData: vi.fn(async () => {
        throw new Error('storage cleanup failed')
      }),
      clearCache: vi.fn(() => cacheCleared),
    }

    let finished = false
    const cleanup = clearPreviewSession(previewSession).catch((error: unknown) => {
      finished = true
      return error
    })
    await vi.waitFor(() => expect(previewSession.clearCache).toHaveBeenCalledOnce())

    expect(finished).toBe(false)
    clearCache?.()
    expect(await cleanup).toMatchObject({
      message: 'Preview storage cleanup failed',
      errors: [expect.any(Error)],
    })

    expect(previewSession.clearStorageData).toHaveBeenCalledOnce()
    expect(finished).toBe(true)
  })

  it('reports both failures and still calls cache cleanup after a synchronous throw', async () => {
    const storageError = new Error('storage failed')
    const cacheError = new Error('cache failed')
    const clearCache = vi.fn().mockRejectedValue(cacheError)
    await expect(
      clearPreviewSession({
        clearStorageData: () => {
          throw storageError
        },
        clearCache,
      }),
    ).rejects.toMatchObject({ errors: [storageError, cacheError] })
    expect(clearCache).toHaveBeenCalledOnce()
  })

  it('succeeds only when both operations succeed', async () => {
    const session = {
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
    }
    await expect(clearPreviewSession(session)).resolves.toBeUndefined()
    expect(session.clearStorageData).toHaveBeenCalledOnce()
    expect(session.clearCache).toHaveBeenCalledOnce()
  })
})
