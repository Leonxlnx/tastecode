import type { JsonRpcValue } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'

const proc = vi.hoisted(() => ({ rpc: undefined as FakeCodexRpc | undefined }))

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    constructor() {
      if (!proc.rpc) throw new Error('fake Codex RPC was not installed')
      return proc.rpc
    }
  },
}))

type SourceState = {
  account: JsonRpcValue
  accountResponse?: JsonRpcValue
  failure?: string
  rateLimitsResponse?: JsonRpcValue
}

const emptyRateLimits = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: null,
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
} as const

function sourceAdapter(initial: Partial<SourceState> = {}) {
  const state: SourceState = { account: null, ...initial }
  const rpc = new FakeCodexRpc((method) => {
    if (method === state.failure) throw new Error(`${method} failed`)
    if (method === 'account/read') {
      return state.accountResponse ?? { account: state.account }
    }
    if (method === 'account/rateLimits/read') {
      return state.rateLimitsResponse ?? emptyRateLimits
    }
    return {}
  })
  proc.rpc = rpc
  return { adapter: new CodexAdapter(), rpc, state }
}

const capturedRateLimitUpdate = {
  rateLimits: emptyRateLimits.rateLimits,
}

describe('Codex rate-limit source', () => {
  it('bounds initialization and disposes a failed transport', async () => {
    const { adapter, rpc } = sourceAdapter({ failure: 'initialize' })

    await expect(adapter.start()).rejects.toThrow('initialize failed')
    expect(rpc.calls[0]).toMatchObject({ method: 'initialize', timeoutMs: 10_000 })
    expect(rpc.disposals).toBe(1)
  })

  it('maps only the exact provider update to a quiet usage-change event', async () => {
    const { adapter, rpc } = sourceAdapter()
    const changed = vi.fn()
    const logged = vi.fn()
    adapter.on('usageChanged', changed)
    adapter.on('log', logged)
    await adapter.start()

    rpc.emitNotification('account/rateLimits/updated', capturedRateLimitUpdate)

    expect(changed).toHaveBeenCalledTimes(1)
    expect(logged).not.toHaveBeenCalled()

    rpc.emitNotification('account/rateLimits/updated-v2', capturedRateLimitUpdate)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('unmapped notification: account/rateLimits/updated-v2')
    adapter.dispose()
  })

  it('ignores a buffered usage update after disposal', async () => {
    const { adapter, rpc } = sourceAdapter()
    const changed = vi.fn()
    adapter.onUsageChanged(changed)
    await adapter.start()

    adapter.dispose()
    rpc.emitNotification('account/rateLimits/updated', capturedRateLimitUpdate)

    expect(changed).not.toHaveBeenCalled()
  })

  it.each([
    ['signed out', null],
    ['API key', { type: 'apiKey' }],
    ['Bedrock', { type: 'amazonBedrock', credentialSource: 'environment' }],
  ] satisfies Array<[string, JsonRpcValue]>)(
    'marks %s accounts unavailable without requesting subscription limits',
    async (_name, account) => {
      const { adapter, rpc } = sourceAdapter({ account })
      await adapter.start()

      await expect(adapter.rateLimitSource()).resolves.toEqual({ status: 'unavailable' })
      expect(rpc.calls.map(({ method }) => method)).not.toContain('account/rateLimits/read')
      adapter.dispose()
    },
  )

  it('marks a successful ChatGPT subscription response ready, including empty limits', async () => {
    const { adapter, rpc } = sourceAdapter({
      account: { type: 'chatgpt', email: null, planType: 'pro' },
    })
    await adapter.start()

    await expect(adapter.rateLimitSource()).resolves.toEqual({ status: 'ready', limits: [] })
    expect(rpc.calls.map(({ method }) => method)).toContain('account/rateLimits/read')
    expect(rpc.calls.filter(({ method }) => method.includes('account/'))).toMatchObject([
      { method: 'account/read', timeoutMs: 10_000 },
      { method: 'account/rateLimits/read', timeoutMs: 10_000 },
    ])
    adapter.dispose()
  })

  it('accepts a reset-credit summary without optional detail rows', async () => {
    const { adapter } = sourceAdapter({
      account: { type: 'chatgpt', email: null, planType: 'pro' },
      rateLimitsResponse: {
        ...emptyRateLimits,
        rateLimitResetCredits: { availableCount: 2 },
      },
    })
    await adapter.start()

    await expect(adapter.rateLimitSource()).resolves.toEqual({
      status: 'ready',
      limits: [{ label: 'Rate limit resets', usedPercent: 0, valueLabel: '2 available' }],
    })
    adapter.dispose()
  })

  it.each(['account/read', 'account/rateLimits/read'])(
    'propagates a failed %s request',
    async (method) => {
      const { adapter } = sourceAdapter({
        account: { type: 'chatgpt', email: null, planType: 'pro' },
        failure: method,
      })
      await adapter.start()

      await expect(adapter.rateLimitSource()).rejects.toThrow(`${method} failed`)
      adapter.dispose()
    },
  )

  it('rejects a malformed successful account response', async () => {
    const { adapter } = sourceAdapter({ accountResponse: {} })
    await adapter.start()

    await expect(adapter.rateLimitSource()).rejects.toThrow('Codex account response was invalid.')
    adapter.dispose()
  })

  it('rejects a malformed successful rate-limit response', async () => {
    const { adapter } = sourceAdapter({
      account: { type: 'chatgpt', email: null, planType: 'pro' },
      rateLimitsResponse: {
        rateLimits: {},
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      },
    })
    await adapter.start()

    await expect(adapter.rateLimitSource()).rejects.toThrow(
      'Codex rate-limit response was invalid.',
    )
    adapter.dispose()
  })
})
