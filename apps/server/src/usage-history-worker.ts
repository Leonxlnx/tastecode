import { parentPort, workerData } from 'node:worker_threads'
import type { UsageWorkerJob, UsageWorkerMessage } from './usage-history.js'

type UsageHistoryModule = typeof import('./usage-history.js')

function send(message: UsageWorkerMessage): void {
  parentPort?.postMessage(message)
}

const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
const job = workerData as UsageWorkerJob

void import(`./usage-history.${sourceExtension}`)
  .then(({ runUsageHistoryScan }: UsageHistoryModule) =>
    runUsageHistoryScan(job.request, (progress) => {
      send({ type: 'progress', progress })
    }),
  )
  .then((result) => send({ type: 'complete', result }))
  .catch((error: unknown) => {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  })
