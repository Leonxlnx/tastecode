// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const avatar = vi.hoisted(() => ({
  cached: undefined as string | undefined,
  load: vi.fn<() => Promise<string>>(),
}))

vi.mock('./default-profile-avatar.js', () => ({
  normalizeDefaultProfileAvatarSeed: (seed: string) => seed.trim() || 'TasteCode',
  readDefaultProfileAvatar: () => avatar.cached,
  loadDefaultProfileAvatar: avatar.load,
}))

import { useDefaultProfileAvatar } from './use-default-profile-avatar.js'

afterEach(() => {
  avatar.cached = undefined
  avatar.load.mockReset()
  vi.unstubAllGlobals()
})

describe('default profile avatar loading', () => {
  it('waits for browser idle time before starting the first-run worker', async () => {
    let idleCallback: IdleRequestCallback | undefined
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallback = callback
      return 42
    })
    const cancelIdleCallback = vi.fn()
    vi.stubGlobal('requestIdleCallback', requestIdleCallback)
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback)
    avatar.load.mockResolvedValue('data:image/svg+xml;charset=utf-8,avatar')

    const hook = renderHook(() => useDefaultProfileAvatar(' TasteCode '))

    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1_500 })
    expect(avatar.load).not.toHaveBeenCalled()

    await act(async () => {
      idleCallback?.({ didTimeout: false, timeRemaining: () => 10 })
      await Promise.resolve()
    })
    expect(avatar.load).toHaveBeenCalledWith('TasteCode')
    expect(hook.result.current).toBe('data:image/svg+xml;charset=utf-8,avatar')

    hook.unmount()
    expect(cancelIdleCallback).toHaveBeenCalledWith(42)
  })
})
