import type { ProcessMetric } from 'electron'

export const MAX_STARTUP_SETTLE_MS = 60_000

type ProcessMetricSummary = {
  processes: number
  cpuPercent: number
  idleWakeupsPerSecond: number
  workingSetKiB: number
  peakWorkingSetKiB: number
  privateKiB: number
}

export type AppMetricSummary = ProcessMetricSummary & {
  byType: Record<string, ProcessMetricSummary>
}

export function startupSettleDelay(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const delay = Number(value)
  if (!Number.isSafeInteger(delay) || delay < 100 || delay > MAX_STARTUP_SETTLE_MS) {
    return undefined
  }
  return delay
}

function emptySummary(): ProcessMetricSummary {
  return {
    processes: 0,
    cpuPercent: 0,
    idleWakeupsPerSecond: 0,
    workingSetKiB: 0,
    peakWorkingSetKiB: 0,
    privateKiB: 0,
  }
}

function addMetric(summary: ProcessMetricSummary, metric: ProcessMetric): void {
  summary.processes += 1
  summary.cpuPercent += metric.cpu.percentCPUUsage
  summary.idleWakeupsPerSecond += metric.cpu.idleWakeupsPerSecond
  summary.workingSetKiB += metric.memory.workingSetSize
  summary.peakWorkingSetKiB += metric.memory.peakWorkingSetSize
  summary.privateKiB += metric.memory.privateBytes ?? 0
}

export function summarizeAppMetrics(metrics: ProcessMetric[]): AppMetricSummary {
  const total = emptySummary()
  const grouped = new Map<string, ProcessMetricSummary>()

  for (const metric of metrics) {
    addMetric(total, metric)
    let summary = grouped.get(metric.type)
    if (!summary) {
      summary = emptySummary()
      grouped.set(metric.type, summary)
    }
    addMetric(summary, metric)
  }

  const byType = Object.fromEntries(
    [...grouped].sort(([left], [right]) => left.localeCompare(right)),
  )
  return { ...total, byType }
}
