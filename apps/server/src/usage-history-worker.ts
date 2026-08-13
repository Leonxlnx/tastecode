import { parentPort, workerData } from 'node:worker_threads'
import type { UsageScanProgress, UsageScanRequest, UsageScanResult } from './usage-history.js'

type UsageHistoryModule = typeof import('./usage-history.js')

type WorkerMessage =
  | { type: 'progress'; progress: UsageScanProgress }
  | { type: 'complete'; result: UsageScanResult }
  | { type: 'error'; message: string }

function send(message: WorkerMessage): void {
  parentPort?.postMessage(message)
}

const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'

void import(`./usage-history.${sourceExtension}`)
  .then(({ runUsageHistoryScan }: UsageHistoryModule) =>
    runUsageHistoryScan(workerData as UsageScanRequest, (progress) => {
      send({ type: 'progress', progress })
    }),
  )
  .then((result) => send({ type: 'complete', result }))
  .catch((error: unknown) => {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  })
