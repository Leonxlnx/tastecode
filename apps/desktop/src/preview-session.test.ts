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
    const cleanup = clearPreviewSession(previewSession).then(() => {
      finished = true
    })
    await vi.waitFor(() => expect(previewSession.clearCache).toHaveBeenCalledOnce())

    expect(finished).toBe(false)
    clearCache?.()
    await cleanup

    expect(previewSession.clearStorageData).toHaveBeenCalledOnce()
    expect(finished).toBe(true)
  })
})
