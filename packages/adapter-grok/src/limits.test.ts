import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; params: unknown }>,
  spawns: [] as Array<{ command: string; args: string[]; options: unknown }>,
  disposed: 0,
  billing: {} as unknown,
  error: undefined as Error | undefined,
  hangs: new Set<string>(),
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn((command: string, args: string[], options: unknown) => {
    fake.spawns.push({ command, args, options })
    return { pid: 1 }
  }),
}))

vi.mock('@harness/proc', () => ({
  killTree: vi.fn(),
  readNdjson: vi.fn(),
  StdioJsonRpc: class {
    request(method: string, params: unknown): Promise<unknown> {
      fake.calls.push({ method, params })
      if (fake.hangs.has(method)) return new Promise(() => undefined)
      if (method === 'initialize') return Promise.resolve({ protocolVersion: 1 })
      return fake.error ? Promise.reject(fake.error) : Promise.resolve(fake.billing)
    }
    dispose(): void {
      fake.disposed += 1
    }
  },
}))

const { grokCommand } = await import('./adapter.js')
const { grokLimitSource, grokLimits, mapGrokBilling } = await import('./limits.js')

beforeEach(() => {
  fake.calls = []
  fake.spawns = []
  fake.disposed = 0
  fake.error = undefined
  fake.billing = {}
  fake.hangs.clear()
})

afterEach(() => vi.useRealTimers())

async function settle(): Promise<void> {
  for (let step = 0; step < 5; step += 1) await Promise.resolve()
}

describe('mapGrokBilling', () => {
  it('maps the captured weekly, prepaid, and on-demand credit fields', () => {
    const rows = mapGrokBilling({
      config: {
        creditUsagePercent: 99.2,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-04T00:00:00+00:00',
          end: '2026-08-11T00:00:00+00:00',
        },
        onDemandCap: { val: 2500 },
        onDemandUsed: { val: 300 },
        prepaidBalance: { val: -1250 },
      },
      on_demand_enabled: true,
      subscription_tier: 'SuperGrok',
    })
    expect(rows).toEqual([
      {
        label: 'Weekly',
        usedPercent: 99.2,
        resetsAt: Date.parse('2026-08-11T00:00:00+00:00'),
      },
      { label: 'Credits', usedPercent: 0, valueLabel: '$12.50 remaining' },
      {
        label: 'Pay-as-you-go',
        usedPercent: 12,
        valueLabel: '$3.00 used of $25.00 limit',
      },
    ])
  })

  it('does not present an absent percentage as zero usage', () => {
    const rows = mapGrokBilling({
      config: {
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
        prepaidBalance: {},
      },
    })
    expect(rows).toEqual([{ label: 'Weekly', usedPercent: 0, valueLabel: 'Usage not reported' }])
  })

  it('falls back to the provider documented legacy monthly amounts', () => {
    expect(
      mapGrokBilling({
        config: {
          monthlyLimit: { val: 2000 },
          used: { val: 1234 },
          billingPeriodEnd: '2026-09-01T00:00:00Z',
        },
      }),
    ).toEqual([
      {
        label: 'Monthly',
        usedPercent: 61.7,
        resetsAt: Date.parse('2026-09-01T00:00:00Z'),
        valueLabel: '$12.34 of $20.00 used',
      },
    ])
  })

  it('splits legacy overflow into pay-as-you-go without overstating included usage', () => {
    expect(
      mapGrokBilling({
        config: {
          monthlyLimit: { val: 2000 },
          used: { val: 2500 },
          onDemandCap: { val: 5000 },
        },
      }),
    ).toEqual([
      {
        label: 'Monthly',
        usedPercent: 100,
        valueLabel: '$20.00 of $20.00 used',
      },
      {
        label: 'Pay-as-you-go',
        usedPercent: 10,
        valueLabel: '$5.00 used of $50.00 limit',
      },
    ])
  })

  it('floors legacy pay-as-you-go usage at zero', () => {
    expect(
      mapGrokBilling({
        config: {
          monthlyLimit: { val: 2000 },
          used: { val: 1234 },
          onDemandCap: { val: 5000 },
        },
      }),
    ).toEqual([
      {
        label: 'Monthly',
        usedPercent: 61.7,
        valueLabel: '$12.34 of $20.00 used',
      },
      {
        label: 'Pay-as-you-go',
        usedPercent: 0,
        valueLabel: '$0.00 used of $50.00 limit',
      },
    ])
  })

  it('uses a neutral label when the provider omits or changes the period type', () => {
    const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY' }
    expect(mapGrokBilling({ config: { creditUsagePercent: 140, currentPeriod: period } })).toEqual([
      { label: 'Weekly', usedPercent: 100 },
    ])
    expect(mapGrokBilling({ config: { creditUsagePercent: -4, currentPeriod: period } })).toEqual([
      { label: 'Weekly', usedPercent: 0 },
    ])
    expect(mapGrokBilling({ config: { creditUsagePercent: 42 } })).toEqual([
      { label: 'Included credits', usedPercent: 42 },
    ])
  })

  it('hides disabled or inactive pay-as-you-go rows and rejects malformed money', () => {
    expect(
      mapGrokBilling({
        config: {
          prepaidBalance: { val: 'not-money' },
          onDemandCap: { val: 2500 },
          onDemandUsed: { val: 300 },
        },
        on_demand_enabled: false,
      }),
    ).toEqual([])
    expect(
      mapGrokBilling({
        config: {
          monthlyLimit: {},
          used: {},
          onDemandCap: {},
          onDemandUsed: {},
          prepaidBalance: [],
        },
      }),
    ).toEqual([])
  })

  it('rejects empty or non-finite percentages and junk', () => {
    const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY' }
    expect(mapGrokBilling({ config: { creditUsagePercent: ' ', currentPeriod: period } })).toEqual([
      { label: 'Weekly', usedPercent: 0, valueLabel: 'Usage not reported' },
    ])
    expect(
      mapGrokBilling({ config: { creditUsagePercent: Number.NaN, currentPeriod: period } }),
    ).toEqual([{ label: 'Weekly', usedPercent: 0, valueLabel: 'Usage not reported' }])
    expect(mapGrokBilling({})).toEqual([])
    expect(mapGrokBilling(undefined)).toEqual([])
  })

  it('reports signed-out billing as unavailable without starting provider ACP', async () => {
    const account = vi.fn().mockResolvedValue({ signedIn: false })

    await expect(grokLimitSource(account)).resolves.toEqual({ status: 'unavailable' })
    expect(account).toHaveBeenCalledOnce()
    expect(fake.spawns).toEqual([])
  })

  it('reports a recognized signed-in billing response as ready', async () => {
    fake.billing = {
      config: {
        creditUsagePercent: 12,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
      },
    }

    await expect(grokLimitSource(async () => ({ signedIn: true }))).resolves.toEqual({
      status: 'ready',
      limits: [{ label: 'Weekly', usedPercent: 12 }],
    })
  })

  it('rejects an unrecognized signed-in billing response', async () => {
    fake.billing = { futureBillingShape: true }

    await expect(grokLimitSource(async () => ({ signedIn: true }))).rejects.toThrow(
      'Grok billing response was invalid.',
    )
  })

  it('reads billing through the resolved Grok binary and provider ACP', async () => {
    fake.billing = {
      config: {
        creditUsagePercent: 12,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
      },
    }

    await expect(grokLimits()).resolves.toEqual([{ label: 'Weekly', usedPercent: 12 }])
    expect(fake.calls.map((call) => call.method)).toEqual(['initialize', '_x.ai/billing'])
    expect(fake.spawns).toEqual([
      {
        command: grokCommand(),
        args: ['agent', '--no-leader', 'stdio'],
        options: { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      },
    ])
    expect(fake.disposed).toBe(1)
  })

  it.each(['initialize', '_x.ai/billing'])(
    'times out a stalled %s call and disposes',
    async (method) => {
      vi.useFakeTimers()
      fake.hangs.add(method)

      const result = grokLimits()
      const rejected = expect(result).rejects.toThrow('grok billing did not answer in time')
      await settle()
      expect(fake.calls.map((call) => call.method)).toContain(method)
      await vi.advanceTimersByTimeAsync(10_000)

      await rejected
      expect(fake.disposed).toBe(1)
    },
  )

  it('coalesces concurrent reads and retries after a provider failure', async () => {
    let resolveBilling!: (value: unknown) => void
    fake.billing = new Promise((resolve) => {
      resolveBilling = resolve
    })

    const first = grokLimits()
    const second = grokLimits()
    await settle()
    expect(fake.spawns).toHaveLength(1)
    expect(fake.calls.filter((call) => call.method === '_x.ai/billing')).toHaveLength(1)
    resolveBilling({
      config: {
        creditUsagePercent: 12,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
      },
    })
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ label: 'Weekly', usedPercent: 12 }],
      [{ label: 'Weekly', usedPercent: 12 }],
    ])

    fake.error = new Error('billing unavailable')
    await expect(grokLimits()).rejects.toThrow('billing unavailable')
    fake.error = undefined
    fake.billing = {
      config: {
        creditUsagePercent: 34,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
      },
    }
    await expect(grokLimits()).resolves.toEqual([{ label: 'Weekly', usedPercent: 34 }])
    expect(fake.spawns).toHaveLength(3)
    expect(fake.disposed).toBe(3)
  })
})
