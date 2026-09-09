import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRuntime } from './adapters.js'

const adapters = vi.hoisted(() => ({
  providerRuntime: vi.fn(),
  apiRuntime: vi.fn(),
  verifyCustomHarness: vi.fn(),
}))

vi.mock('./adapters.js', () => adapters)

const { providerRuntime } = await import('./runtime-loader.js')

function fakeRuntime(): ProviderRuntime {
  return {
    async start() {
      throw new Error('not used')
    },
    async resume() {
      throw new Error('not used')
    },
    async listModels() {
      return []
    },
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('provider runtime loading', () => {
  it('does not construct an adapter runtime until the first provider operation', async () => {
    const loaded = fakeRuntime()
    const listModels = vi.spyOn(loaded, 'listModels')
    adapters.providerRuntime.mockReturnValue(loaded)

    const runtime = providerRuntime('codex', () => {})

    expect(adapters.providerRuntime).not.toHaveBeenCalled()
    await runtime.listModels()
    await runtime.listModels()

    expect(adapters.providerRuntime).toHaveBeenCalledTimes(1)
    expect(listModels).toHaveBeenCalledTimes(2)
  })

  it('preserves which providers support restart resume', () => {
    adapters.providerRuntime.mockReturnValue(fakeRuntime())

    expect(providerRuntime('codex', () => {}).resume).toEqual(expect.any(Function))
    expect(providerRuntime('pi', () => {}).resume).toBeUndefined()
    expect(providerRuntime('antigravity', () => {}).resume).toBeUndefined()
  })

  it('keeps API connections on their dedicated runtime path', () => {
    expect(() => providerRuntime('api', () => {})).toThrow('provider "api" is not implemented yet')
  })

  it('retries runtime construction after a temporary failure', async () => {
    const loaded = fakeRuntime()
    adapters.providerRuntime
      .mockImplementationOnce(() => {
        throw new Error('temporary failure')
      })
      .mockReturnValue(loaded)
    const runtime = providerRuntime('codex', () => {})

    await expect(runtime.listModels()).rejects.toThrow('temporary failure')
    await expect(runtime.listModels()).resolves.toEqual([])
    expect(adapters.providerRuntime).toHaveBeenCalledTimes(2)
  })
})
