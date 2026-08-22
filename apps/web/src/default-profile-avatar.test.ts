// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDefaultProfileAvatar, readDefaultProfileAvatar } from './default-profile-avatar.js'

class AvatarWorker {
  static created = 0
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    AvatarWorker.created += 1
  }

  postMessage(seed: string): void {
    queueMicrotask(() => {
      this.onmessage?.(
        new MessageEvent('message', {
          data: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(seed)}`,
        }),
      )
    })
  }

  terminate(): void {}
}

beforeEach(() => {
  AvatarWorker.created = 0
  localStorage.clear()
  vi.stubGlobal('Worker', AvatarWorker)
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('default profile avatar', () => {
  it('uses one short-lived worker and reuses the rendered avatar', async () => {
    const seed = `Blue Emi ${Date.now()}`
    const [first, second] = await Promise.all([
      loadDefaultProfileAvatar(seed),
      loadDefaultProfileAvatar(seed),
    ])

    expect(first).toBe(second)
    expect(AvatarWorker.created).toBe(1)
    expect(readDefaultProfileAvatar(seed)).toBe(first)
    await expect(loadDefaultProfileAvatar(seed)).resolves.toBe(first)
    expect(AvatarWorker.created).toBe(1)
  })
})
