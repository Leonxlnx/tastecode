import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderIdSchema,
  type ProviderId,
  type ProviderLimit,
  type ProviderLimitSource,
} from '@harness/contracts'
import type { AgentSession } from './adapters.js'
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
      consumeRateLimitReset(idempotencyKey: string, creditId?: string): Promise<unknown> {
        return sources.consume(idempotencyKey, creditId)
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
      checkedAt: expect.any(Number),
      origin: 'read',
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

  it('answers the first shown view after a restart from the last session read', async () => {
    const store = new Store(':memory:')
    const handlers = { onEvent: () => {}, onLog: () => {}, onLogin: () => {} }
    sources.grok.mockResolvedValue({
      status: 'ready',
      limits: [{ label: 'Monthly', usedPercent: 30 }],
    })
    const first = new Orchestrator(store, handlers)
    await first.usageLimitSource('grok', 'visible')
    await first.disposeAll()

    const second = new Orchestrator(store, handlers)
    // No vendor read is needed to paint the limits view again.
    expect(second.heldLimitSource('grok', 'visible')).toMatchObject({
      status: 'ready',
      limits: [{ label: 'Monthly', usedPercent: 30 }],
      origin: 'read',
    })
    // A passive figure still waits for this session's own values.
    expect(second.heldLimitSource('grok', 'background')).toBeUndefined()
    expect(sources.grok).toHaveBeenCalledOnce()
    await second.disposeAll()
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

  it('answers the read after each Claude turn without another usage scan', async () => {
    sources.claude.mockResolvedValue({ status: 'unavailable' })
    let usageChanged = () => {}
    const session: AgentSession = {
      capabilities: {
        steer: false,
        fork: false,
        interrupt: true,
        reasoningItems: false,
        approvals: false,
        images: false,
      },
      sendTurn: async () => 'turn',
      interrupt: async () => {},
      respondToApproval: () => {},
      dispose: () => {},
      on: () => {},
      onUsageChanged: (listener) => {
        usageChanged = listener
      },
    }
    const signals: ProviderId[] = []
    const instance = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      onUsageChanged: (provider) => signals.push(provider),
      runtimeFor: (provider) => ({
        start: async (workspacePath) => ({
          thread: { id: 'claude-thread', provider, workspacePath, createdAt: Date.now() },
          session,
        }),
        listModels: async () => [],
      }),
    })
    await instance.startThread('claude-code', process.cwd())

    await instance.usageLimitSource('claude-code')
    for (let turn = 0; turn < 3; turn += 1) {
      // Each turn's rate-limit event, then the client's refresh it triggers.
      usageChanged()
      await expect(instance.usageLimitSource('claude-code')).resolves.toEqual({
        provider: 'claude-code',
        status: 'unavailable',
      })
    }
    expect(signals[0]).toBe('claude-code')
    expect(sources.claude).toHaveBeenCalledOnce()
    await instance.disposeAll()
  })

  it('merges the live windows of the attached session and pushes the snapshot', async () => {
    const week = { id: 'seven_day', label: 'Weekly', usedPercent: 20 }
    sources.claude.mockResolvedValue({
      status: 'ready',
      limits: [{ id: 'five_hour', label: '5-hour', usedPercent: 10 }, week],
    })
    let report: (limits: ProviderLimit[]) => void = () => {}
    const session: AgentSession = {
      capabilities: {
        steer: false,
        fork: false,
        interrupt: true,
        reasoningItems: false,
        approvals: false,
        images: false,
      },
      sendTurn: async () => 'turn',
      interrupt: async () => {},
      respondToApproval: () => {},
      dispose: () => {},
      on: () => {},
      onLimitsUpdated: (listener) => {
        report = listener
      },
    }
    const pushed: ProviderLimitSource[] = []
    const instance = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      onLimitsChanged: (source) => pushed.push(source),
      runtimeFor: (provider) => ({
        start: async (workspacePath) => ({
          thread: { id: 'claude-thread', provider, workspacePath, createdAt: Date.now() },
          session,
        }),
        listModels: async () => [],
      }),
    })
    await instance.startThread('claude-code', process.cwd())
    await instance.usageLimitSource('claude-code')

    report([{ id: 'five_hour', label: '5-hour', usedPercent: 12 }])

    const merged = {
      provider: 'claude-code',
      status: 'ready',
      limits: [{ id: 'five_hour', label: '5-hour', usedPercent: 12 }, week],
      checkedAt: expect.any(Number),
      origin: 'live',
    }
    // The read's own snapshot, then the merged one, spaced by the publish interval.
    await vi.waitFor(() => expect(pushed).toHaveLength(2), { timeout: 5_000 })
    expect(pushed[1]).toEqual(merged)
    await expect(instance.usageLimitSource('claude-code')).resolves.toEqual(merged)
    expect(sources.claude).toHaveBeenCalledOnce()
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
      instance.consumeRateLimitReset(
        'codex',
        '8ae96ff3-3425-4f4c-8772-b6fd61502868',
        'reset-fixture',
      ),
    ).resolves.toEqual({ outcome: 'reset' })
    expect(sources.consume).toHaveBeenCalledWith(
      '8ae96ff3-3425-4f4c-8772-b6fd61502868',
      'reset-fixture',
    )
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
