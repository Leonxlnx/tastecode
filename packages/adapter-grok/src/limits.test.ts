import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; params: unknown }>,
  disposed: 0,
  billing: {} as unknown,
  error: undefined as Error | undefined,
}))

vi.mock('@harness/proc', () => ({
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    request(method: string, params: unknown): Promise<unknown> {
      fake.calls.push({ method, params })
      if (method === 'initialize') return Promise.resolve({ protocolVersion: 1 })
      return fake.error ? Promise.reject(fake.error) : Promise.resolve(fake.billing)
    }
    dispose(): void {
      fake.disposed += 1
    }
  },
}))

const { grokLimits, mapGrokBilling } = await import('./limits.js')

beforeEach(() => {
  fake.calls = []
  fake.disposed = 0
  fake.error = undefined
  fake.billing = {}
})

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

  it('reads billing through Grok ACP and lets provider failures stay failures', async () => {
    fake.billing = {
      config: {
        creditUsagePercent: 12,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
      },
    }

    await expect(grokLimits()).resolves.toEqual([{ label: 'Weekly limit', usedPercent: 12 }])
    expect(fake.calls.map((call) => call.method)).toEqual(['initialize', '_x.ai/billing'])
    expect(fake.disposed).toBe(1)

    fake.calls = []
    fake.error = new Error('billing unavailable')
    await expect(grokLimits()).rejects.toThrow('billing unavailable')
    expect(fake.disposed).toBe(2)
  })
})
