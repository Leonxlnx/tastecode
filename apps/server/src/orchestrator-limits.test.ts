import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderIdSchema } from '@harness/contracts'
import { Store } from './store.js'

const sources = vi.hoisted(() => ({
  codex: vi.fn(),
  claude: vi.fn(),
  grok: vi.fn(),
  consume: vi.fn(),
  constructed: 0,
  disposed: [] as number[],
}))

vi.mock('@harness/adapter-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-codex')>()
  return {
    ...original,
    CodexAdapter: class {
      readonly id = ++sources.constructed
      on(): void {}
      onUsageChanged(): void {}
      dispose(): void {
        sources.disposed.push(this.id)
      }
      async start(): Promise<void> {}
      async account(): Promise<{ signedIn: boolean }> {
        return { signedIn: true }
      }
      rateLimitSource(): Promise<unknown> {
        return sources.codex()
      }
      consumeRateLimitReset(idempotencyKey: string): Promise<unknown> {
        return sources.consume(idempotencyKey)
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
  sources.consume.mockReset()
  sources.constructed = 0
  sources.disposed = []
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
    if (provider === 'codex') expect(sources.disposed).toEqual([1])
    await instance.disposeAll()
  })

  it('does not reuse or dispose the long-lived account adapter', async () => {
    sources.codex.mockResolvedValue({ status: 'ready', limits: [] })
    const instance = orchestrator()

    await instance.account('codex')
    await instance.usageLimitSource('codex')

    expect(sources.constructed).toBe(2)
    expect(sources.disposed).toEqual([2])
    await instance.disposeAll()
    expect(sources.disposed).toEqual([2, 1])
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
})

describe('rate-limit reset consume', () => {
  it('redeems through a short-lived Codex adapter and notifies usage listeners', async () => {
    const onUsageChanged = vi.fn()
    sources.consume.mockResolvedValue('reset')
    const instance = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      onUsageChanged,
    })

    await expect(
      instance.consumeRateLimitReset('codex', '8ae96ff3-3425-4f4c-8772-b6fd61502868'),
    ).resolves.toEqual({ outcome: 'reset' })
    expect(sources.consume).toHaveBeenCalledWith('8ae96ff3-3425-4f4c-8772-b6fd61502868')
    expect(sources.disposed).toEqual([1])
    expect(onUsageChanged).toHaveBeenCalledWith('codex')
    await instance.disposeAll()
  })

  it('does not consume through an engine that has no reset credits', async () => {
    const instance = orchestrator()

    await expect(
      instance.consumeRateLimitReset('grok', '8ae96ff3-3425-4f4c-8772-b6fd61502868'),
    ).rejects.toThrow('provider "grok" cannot consume a rate-limit reset')
    expect(sources.consume).not.toHaveBeenCalled()
    expect(sources.constructed).toBe(0)
    await instance.disposeAll()
  })
})
