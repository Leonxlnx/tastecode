import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountRateLimitsUpdatedNotification } from './generated/v2/AccountRateLimitsUpdatedNotification.js'

const fake = vi.hoisted(() => ({
  account: null as unknown,
  accountResponse: undefined as unknown,
  calls: [] as string[],
  disposals: 0,
  failure: undefined as string | undefined,
  notification: undefined as ((method: string, params: unknown) => void) | undefined,
  rateLimitsResponse: undefined as unknown,
  requests: [] as Array<{ method: string; timeoutMs?: number }>,
}))

vi.mock('@harness/proc', () => ({
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    onStderr(): void {}
    onNotification(listener: (method: string, params: unknown) => void): void {
      fake.notification = listener
    }
    onServerRequest(): void {}
    notify(): void {}
    dispose(): void {
      fake.disposals += 1
    }

    request(method: string, _params: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
      fake.calls.push(method)
      fake.requests.push({ method, timeoutMs: options?.timeoutMs })
      if (method === fake.failure) return Promise.reject(new Error(`${method} failed`))
      if (method === 'account/read') {
        return Promise.resolve(fake.accountResponse ?? { account: fake.account })
      }
      if (method === 'account/rateLimits/read') {
        return Promise.resolve(
          fake.rateLimitsResponse ?? {
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
          },
        )
      }
      return Promise.resolve({})
    }
  },
}))

const { CodexAdapter } = await import('./adapter.js')

beforeEach(() => {
  fake.account = null
  fake.accountResponse = undefined
  fake.calls = []
  fake.disposals = 0
  fake.failure = undefined
  fake.notification = undefined
  fake.rateLimitsResponse = undefined
  fake.requests = []
})

const capturedRateLimitUpdate = {
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
} satisfies AccountRateLimitsUpdatedNotification

describe('Codex rate-limit source', () => {
  it('bounds initialization and disposes a failed transport', async () => {
    fake.failure = 'initialize'
    const adapter = new CodexAdapter()

    await expect(adapter.start()).rejects.toThrow('initialize failed')
    expect(fake.requests[0]).toEqual({ method: 'initialize', timeoutMs: 10_000 })
    expect(fake.disposals).toBe(1)
  })

  it('maps only the exact provider update to a quiet usage-change event', async () => {
    const adapter = new CodexAdapter()
    const changed = vi.fn()
    const logged = vi.fn()
    adapter.on('usageChanged', changed)
    adapter.on('log', logged)
    await adapter.start()

    fake.notification?.('account/rateLimits/updated', capturedRateLimitUpdate)

    expect(changed).toHaveBeenCalledTimes(1)
    expect(logged).not.toHaveBeenCalled()

    fake.notification?.('account/rateLimits/updated-v2', capturedRateLimitUpdate)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('unmapped notification: account/rateLimits/updated-v2')
    adapter.dispose()
  })

  it('ignores a buffered usage update after disposal', async () => {
    const adapter = new CodexAdapter()
    const changed = vi.fn()
    adapter.onUsageChanged(changed)
    await adapter.start()

    adapter.dispose()
    fake.notification?.('account/rateLimits/updated', capturedRateLimitUpdate)

    expect(changed).not.toHaveBeenCalled()
  })

  it.each([
    ['signed out', null],
    ['API key', { type: 'apiKey' }],
    ['Bedrock', { type: 'amazonBedrock', credentialSource: 'environment' }],
  ])(
    'marks %s accounts unavailable without requesting subscription limits',
    async (_name, account) => {
      fake.account = account
      const adapter = new CodexAdapter()
      await adapter.start()

      await expect(adapter.rateLimitSource()).resolves.toEqual({ status: 'unavailable' })
      expect(fake.calls).not.toContain('account/rateLimits/read')
      adapter.dispose()
    },
  )

  it('marks a successful ChatGPT subscription response ready, including empty limits', async () => {
    fake.account = { type: 'chatgpt', email: null, planType: 'pro' }
    const adapter = new CodexAdapter()
    await adapter.start()

    await expect(adapter.rateLimitSource()).resolves.toEqual({ status: 'ready', limits: [] })
    expect(fake.calls).toContain('account/rateLimits/read')
    expect(fake.requests.filter(({ method }) => method.includes('account/'))).toEqual([
      { method: 'account/read', timeoutMs: 10_000 },
      { method: 'account/rateLimits/read', timeoutMs: 10_000 },
    ])
    adapter.dispose()
  })

  it('accepts a reset-credit summary without optional detail rows', async () => {
    fake.account = { type: 'chatgpt', email: null, planType: 'pro' }
    fake.rateLimitsResponse = {
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
      rateLimitResetCredits: { availableCount: 2 },
    }
    const adapter = new CodexAdapter()
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
      fake.account = { type: 'chatgpt', email: null, planType: 'pro' }
      fake.failure = method
      const adapter = new CodexAdapter()
      await adapter.start()

      await expect(adapter.rateLimitSource()).rejects.toThrow(`${method} failed`)
      adapter.dispose()
    },
  )

  it('rejects a malformed successful account response', async () => {
    fake.accountResponse = {}
    const adapter = new CodexAdapter()
    await adapter.start()

    await expect(adapter.rateLimitSource()).rejects.toThrow('Codex account response was invalid.')
    adapter.dispose()
  })

  it('rejects a malformed successful rate-limit response', async () => {
    fake.account = { type: 'chatgpt', email: null, planType: 'pro' }
    fake.rateLimitsResponse = {
      rateLimits: {},
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    }
    const adapter = new CodexAdapter()
    await adapter.start()

    await expect(adapter.rateLimitSource()).rejects.toThrow(
      'Codex rate-limit response was invalid.',
    )
    adapter.dispose()
  })
})
