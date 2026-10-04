import { describe, expect, it, vi } from 'vitest'
import { retryableLazy } from './retryable-lazy.js'

describe('retryable lazy loading', () => {
  it('shares one in-flight load', async () => {
    let finish: ((value: string) => void) | undefined
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const lazy = retryableLazy(load)

    const first = lazy()
    const second = lazy()
    expect(second).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)

    finish?.('ready')
    await expect(first).resolves.toBe('ready')
    await expect(lazy()).resolves.toBe('ready')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed load', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue('ready')
    const lazy = retryableLazy(load)

    await expect(lazy()).rejects.toThrow('temporary failure')
    await expect(lazy()).resolves.toBe('ready')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
