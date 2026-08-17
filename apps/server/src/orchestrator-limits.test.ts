import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter, type CodexLimitSource } from '@harness/adapter-codex'
import type { ClaudeLimitSource } from '@harness/adapter-claude-code'
import type { GrokLimitSource } from '@harness/adapter-grok'
import { ProviderIdSchema } from '@harness/contracts'
import { Store } from './store.js'
import { Orchestrator } from './orchestrator.js'

const disposedIds: number[] = []
const sources = {
  codex: vi.fn<() => Promise<CodexLimitSource>>(),
  claude: vi.fn<() => Promise<ClaudeLimitSource>>(),
  grok: vi.fn<() => Promise<GrokLimitSource>>(),
  constructed: 0,
  disposed: disposedIds,
}

class TestCodexAdapter extends CodexAdapter {
  readonly id = ++sources.constructed

  override dispose(): void {
    sources.disposed.push(this.id)
  }
  override async start(): Promise<void> {}
  override async account() {
    return { signedIn: true }
  }
  override rateLimitSource(): Promise<CodexLimitSource> {
    return sources.codex()
  }
}

const orchestrator = () =>
  new Orchestrator(new Store(':memory:'), {
    onEvent: () => {},
    onLog: () => {},
    onLogin: () => {},
    createCodexAdapter: () => new TestCodexAdapter(),
    claudeLimitSource: sources.claude,
    grokLimitSource: sources.grok,
  })

beforeEach(() => {
  sources.codex.mockReset()
  sources.claude.mockReset()
  sources.grok.mockReset()
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
