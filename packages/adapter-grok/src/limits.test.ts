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
const { grokLimits, mapGrokBilling } = await import('./limits.js')

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
  it('maps the weekly credit pool with its reset time', () => {
    const rows = mapGrokBilling({
      config: {
        creditUsagePercent: 99.2,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-04T00:00:00+00:00',
          end: '2026-08-11T00:00:00+00:00',
        },
        onDemandCap: { val: 2500 },
      },
    })
    expect(rows).toEqual([
      {
        label: 'Weekly limit',
        usedPercent: 99.2,
        resetsAt: Date.parse('2026-08-11T00:00:00+00:00'),
      },
    ])
  })

  it('treats a missing percent as zero used (proto3 omits zero fields)', () => {
    const rows = mapGrokBilling({
      config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } },
    })
    expect(rows).toEqual([{ label: 'Weekly limit', usedPercent: 0 }])
  })

  it('clamps finite percentages and rejects empty or non-finite values', () => {
    const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY' }
    expect(mapGrokBilling({ config: { creditUsagePercent: 140, currentPeriod: period } })).toEqual([
      { label: 'Weekly limit', usedPercent: 100 },
    ])
    expect(mapGrokBilling({ config: { creditUsagePercent: -4, currentPeriod: period } })).toEqual([
      { label: 'Weekly limit', usedPercent: 0 },
    ])
    expect(mapGrokBilling({ config: { creditUsagePercent: ' ', currentPeriod: period } })).toEqual(
      [],
    )
    expect(
      mapGrokBilling({ config: { creditUsagePercent: Number.NaN, currentPeriod: period } }),
    ).toEqual([])
  })

  it('emits nothing for non-weekly periods or junk', () => {
    expect(
      mapGrokBilling({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_DAILY' } } }),
    ).toEqual([])
    expect(mapGrokBilling({})).toEqual([])
    expect(mapGrokBilling(undefined)).toEqual([])
  })

  it('reads billing through the resolved Grok binary and provider ACP', async () => {
    fake.billing = {
      config: {
        creditUsagePercent: 12,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
      },
    }

    await expect(grokLimits()).resolves.toEqual([{ label: 'Weekly limit', usedPercent: 12 }])
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
      [{ label: 'Weekly limit', usedPercent: 12 }],
      [{ label: 'Weekly limit', usedPercent: 12 }],
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
    await expect(grokLimits()).resolves.toEqual([{ label: 'Weekly limit', usedPercent: 34 }])
    expect(fake.spawns).toHaveLength(3)
    expect(fake.disposed).toBe(3)
  })
})
