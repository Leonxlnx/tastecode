import { describe, expect, it } from 'vitest'
import { mapGrokBilling } from './limits.js'

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

  it('emits nothing for non-weekly periods or junk', () => {
    expect(
      mapGrokBilling({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_DAILY' } } }),
    ).toEqual([])
    expect(mapGrokBilling({})).toEqual([])
    expect(mapGrokBilling(undefined)).toEqual([])
  })
})
