import { describe, expect, it, vi } from 'vitest'
import { clearPreviewSession } from './preview-session.js'

describe('preview session cleanup', () => {
  it('waits for cache cleanup before surfacing a storage cleanup rejection', async () => {
    let clearCache: (() => void) | undefined
    const cacheCleared = new Promise<void>((resolve) => {
      clearCache = resolve
    })
    const storageError = new Error('storage cleanup failed')
    const previewSession = {
      clearStorageData: vi.fn(async () => {
        throw storageError
      }),
      clearCache: vi.fn(() => cacheCleared),
    }

    let settled = false
    const cleanup = clearPreviewSession(previewSession).finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(previewSession.clearCache).toHaveBeenCalledOnce())

    expect(previewSession.clearStorageData).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    clearCache?.()
    await expect(cleanup).rejects.toBe(storageError)
    expect(settled).toBe(true)
  })

  it('waits for storage cleanup before surfacing a cache cleanup rejection', async () => {
    let clearStorage: (() => void) | undefined
    const storageCleared = new Promise<void>((resolve) => {
      clearStorage = resolve
    })
    const cacheError = new Error('cache cleanup failed')
    const previewSession = {
      clearStorageData: vi.fn(() => storageCleared),
      clearCache: vi.fn(async () => {
        throw cacheError
      }),
    }

    let settled = false
    const cleanup = clearPreviewSession(previewSession).finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(previewSession.clearStorageData).toHaveBeenCalledOnce())

    expect(previewSession.clearCache).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    clearStorage?.()
    await expect(cleanup).rejects.toBe(cacheError)
    expect(settled).toBe(true)
  })

  it('surfaces both cleanup rejections after attempting both operations', async () => {
    const storageError = new Error('storage cleanup failed')
    const cacheError = new Error('cache cleanup failed')
    const previewSession = {
      clearStorageData: vi.fn(async () => {
        throw storageError
      }),
      clearCache: vi.fn(async () => {
        throw cacheError
      }),
    }

    const failure = await clearPreviewSession(previewSession).catch((error: unknown) => error)

    expect(previewSession.clearStorageData).toHaveBeenCalledOnce()
    expect(previewSession.clearCache).toHaveBeenCalledOnce()
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toBe('Preview storage and cache cleanup failed')
    expect((failure as AggregateError).errors).toEqual([storageError, cacheError])
  })
})
