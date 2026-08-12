import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderIdSchema } from '@harness/contracts'
import { Store } from './store.js'

const sources = vi.hoisted(() => ({
  codex: vi.fn(),
  claude: vi.fn(),
  grok: vi.fn(),
  disposed: 0,
}))

vi.mock('@harness/adapter-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-codex')>()
  return {
    ...original,
    CodexAdapter: class {
      on(): void {}
      onUsageChanged(): void {}
      dispose(): void {
        sources.disposed += 1
      }
      async start(): Promise<void> {}
      rateLimitSource(): Promise<unknown> {
        return sources.codex()
      }
    },
  }
})

vi.mock('@harness/adapter-claude-code', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-claude-code')>()
  return { ...original, claudeLimitSource: () => sources.claude() }
})

vi.mock('@harness/adapter-grok', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-grok')>()
  return { ...original, grokLimitSource: () => sources.grok() }
})

const { Orchestrator } = await import('./orchestrator.js')

const orchestrator = () =>
  new Orchestrator(new Store(':memory:'), {
    onEvent: () => {},
    onLog: () => {},
    onLogin: () => {},
  })

beforeEach(() => {
  sources.codex.mockReset()
  sources.claude.mockReset()
  sources.grok.mockReset()
  sources.disposed = 0
})

describe('provider limit sources', () => {
  it.each([
    ['codex', 'codex'],
    ['claude-code', 'claude'],
    ['grok', 'grok'],
  ] as const)('keeps %s source state authoritative', async (provider, reader) => {
    sources[reader].mockResolvedValue({
      status: 'ready',
      limits: [{ label: 'Weekly', usedPercent: 25 }],
    })
    const instance = orchestrator()

    await expect(instance.usageLimitSource(provider)).resolves.toEqual({
      provider,
      status: 'ready',
      limits: [{ label: 'Weekly', usedPercent: 25 }],
    })
    await instance.disposeAll()
  })

  it('preserves a supported provider unavailable state', async () => {
    sources.claude.mockResolvedValue({ status: 'unavailable' })
    const instance = orchestrator()

    await expect(instance.usageLimitSource('claude-code')).resolves.toEqual({
      provider: 'claude-code',
      status: 'unavailable',
    })
    await instance.disposeAll()
  })

  it.each(
    ProviderIdSchema.options.filter(
      (provider) => !['codex', 'claude-code', 'grok'].includes(provider),
    ),
  )('marks %s unavailable without querying a subscription source', async (provider) => {
    const instance = orchestrator()

    await expect(instance.usageLimitSource(provider)).resolves.toEqual({
      provider,
      status: 'unavailable',
    })
    expect(sources.codex).not.toHaveBeenCalled()
    expect(sources.claude).not.toHaveBeenCalled()
    expect(sources.grok).not.toHaveBeenCalled()
    await instance.disposeAll()
  })

  it('propagates a real provider failure', async () => {
    sources.grok.mockRejectedValue(new Error('Grok billing request failed.'))
    const instance = orchestrator()

    await expect(instance.usageLimitSource('grok')).rejects.toThrow('Grok billing request failed.')
    await instance.disposeAll()
  })

  it('restarts a wedged Codex control connection before returning limits', async () => {
    vi.useFakeTimers()
    sources.codex.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce({
      status: 'ready',
      limits: [{ label: 'Weekly', usedPercent: 17 }],
    })
    const instance = orchestrator()

    const result = instance.usageLimitSource('codex')
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(result).resolves.toEqual({
      provider: 'codex',
      status: 'ready',
      limits: [{ label: 'Weekly', usedPercent: 17 }],
    })
    expect(sources.codex).toHaveBeenCalledTimes(2)
    expect(sources.disposed).toBe(1)
    await instance.disposeAll()
    vi.useRealTimers()
  })
})
