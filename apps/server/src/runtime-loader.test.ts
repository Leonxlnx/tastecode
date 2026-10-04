import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRuntime } from './adapters.js'

const adapters = vi.hoisted(() => ({
  providerRuntime: vi.fn(),
  apiRuntime: vi.fn(),
  verifyCustomHarness: vi.fn(),
}))

vi.mock('./adapters.js', () => adapters)

const { apiRuntime, providerRuntime } = await import('./runtime-loader.js')

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

    for (const provider of ['codex', 'claude-code', 'grok', 'cursor', 'opencode', 'acp'] as const) {
      expect(providerRuntime(provider, () => {}).resume).toEqual(expect.any(Function))
    }
    for (const provider of ['pi', 'antigravity'] as const) {
      expect(providerRuntime(provider, () => {}).resume).toBeUndefined()
    }
  })

  it('defers API connections and forwards restart resume state to their runtime', async () => {
    const loaded = fakeRuntime()
    const resume = vi.spyOn(loaded, 'resume').mockRejectedValue(new Error('resume reached'))
    adapters.apiRuntime.mockReturnValue(loaded)
    const connection = {
      id: 'local-models',
      displayName: 'Local models',
      preset: 'custom' as const,
      transport: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:8080/v1',
      enabled: true,
      credentialRef: 'model-connections/local-models',
    }
    const log = vi.fn()
    const runtime = apiRuntime(connection, 'test-only-credential', log)

    expect(runtime.resume).toEqual(expect.any(Function))
    expect(adapters.apiRuntime).not.toHaveBeenCalled()
    const resumeState = { version: 1, model: 'selected-model', state: {} }
    await expect(runtime.resume!('saved-thread', 'workspace', { resumeState })).rejects.toThrow(
      'resume reached',
    )
    expect(resume).toHaveBeenCalledExactlyOnceWith('saved-thread', 'workspace', { resumeState })
    await runtime.listModels()
    await runtime.listModels()
    expect(adapters.apiRuntime).toHaveBeenCalledExactlyOnceWith(
      connection,
      'test-only-credential',
      log,
    )
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
