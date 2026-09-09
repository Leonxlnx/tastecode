import type { ProcessMetric } from 'electron'
import { describe, expect, it } from 'vitest'
import {
  MAX_STARTUP_SETTLE_MS,
  startupSettleDelay,
  summarizeAppMetrics,
} from './startup-metrics.js'

function metric(
  type: ProcessMetric['type'],
  cpuPercent: number,
  idleWakeupsPerSecond: number,
  workingSetKiB: number,
  peakWorkingSetKiB: number,
  privateKiB?: number,
): ProcessMetric {
  return {
    pid: 1,
    type,
    creationTime: 1,
    cpu: { percentCPUUsage: cpuPercent, idleWakeupsPerSecond },
    memory: {
      workingSetSize: workingSetKiB,
      peakWorkingSetSize: peakWorkingSetKiB,
      ...(privateKiB === undefined ? {} : { privateBytes: privateKiB }),
    },
  }
}

describe('startup process metrics', () => {
  it('accepts only a bounded benchmark settle delay', () => {
    expect(startupSettleDelay(undefined)).toBeUndefined()
    expect(startupSettleDelay('5000')).toBe(5000)
    expect(startupSettleDelay('99')).toBeUndefined()
    expect(startupSettleDelay(String(MAX_STARTUP_SETTLE_MS + 1))).toBeUndefined()
    expect(startupSettleDelay('1.5')).toBeUndefined()
  })

  it('sums application metrics and stable per-type totals', () => {
    expect(
      summarizeAppMetrics([
        metric('Tab', 0.25, 2, 30, 40),
        metric('Browser', 0.5, 3, 20, 35, 12),
        metric('Tab', 0.75, 4, 50, 60, 18),
      ]),
    ).toEqual({
      processes: 3,
      cpuPercent: 1.5,
      idleWakeupsPerSecond: 9,
      workingSetKiB: 100,
      peakWorkingSetKiB: 135,
      privateKiB: 30,
      byType: {
        Browser: {
          processes: 1,
          cpuPercent: 0.5,
          idleWakeupsPerSecond: 3,
          workingSetKiB: 20,
          peakWorkingSetKiB: 35,
          privateKiB: 12,
        },
        Tab: {
          processes: 2,
          cpuPercent: 1,
          idleWakeupsPerSecond: 6,
          workingSetKiB: 80,
          peakWorkingSetKiB: 100,
          privateKiB: 18,
        },
      },
    })
  })

  it('returns zero totals when Electron reports no processes', () => {
    expect(summarizeAppMetrics([])).toEqual({
      processes: 0,
      cpuPercent: 0,
      idleWakeupsPerSecond: 0,
      workingSetKiB: 0,
      peakWorkingSetKiB: 0,
      privateKiB: 0,
      byType: {},
    })
  })
})
