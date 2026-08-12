import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId } from '@harness/contracts'
import { Store } from './store.js'

const sources = vi.hoisted(() => ({
  codex: vi.fn(),
  claude: vi.fn(),
  grok: vi.fn(),
}))

vi.mock('@harness/adapter-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-codex')>()
  return {
    ...original,
    CodexAdapter: class {
      on(): void {}
      onUsageChanged(): void {}
      dispose(): void {}
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

  it.each(['api', 'cursor', 'acp'] satisfies ProviderId[])(
    'marks %s unavailable without querying a subscription source',
    async (provider) => {
      const instance = orchestrator()

      await expect(instance.usageLimitSource(provider)).resolves.toEqual({
        provider,
        status: 'unavailable',
      })
      expect(sources.codex).not.toHaveBeenCalled()
      expect(sources.claude).not.toHaveBeenCalled()
      expect(sources.grok).not.toHaveBeenCalled()
      await instance.disposeAll()
    },
  )

  it('propagates a real provider failure', async () => {
    sources.grok.mockRejectedValue(new Error('Grok billing request failed.'))
    const instance = orchestrator()

    await expect(instance.usageLimitSource('grok')).rejects.toThrow('Grok billing request failed.')
    await instance.disposeAll()
  })
})
