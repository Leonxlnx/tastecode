import { parentPort, workerData } from 'node:worker_threads'
import type { UsageWorkerJob, UsageWorkerMessage } from './usage-history.js'

type UsageHistoryModule = typeof import('./usage-history.js')
type UsageWorkerResult = Extract<UsageWorkerMessage, { type: 'complete' }>['result']

function send(message: UsageWorkerMessage): void {
  parentPort?.postMessage(message)
}

const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
const job = workerData as UsageWorkerJob

void import(`./usage-history.${sourceExtension}`)
  .then(
    ({ loadUsageCache, runUsageHistoryScan }: UsageHistoryModule): Promise<UsageWorkerResult> =>
      job.kind === 'load'
        ? loadUsageCache(job.cacheFile)
        : runUsageHistoryScan(job.request, (progress) => {
            send({ type: 'progress', progress })
          }),
  )
  .then((result) => send({ type: 'complete', result }))
  .catch((error: unknown) => {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  })
