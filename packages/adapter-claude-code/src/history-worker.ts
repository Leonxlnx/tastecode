import { parentPort, workerData } from 'node:worker_threads'
import type { ProviderHistorySession } from '@harness/contracts'
import { transcriptEvents } from './history.js'

const { locator, session } = workerData as { locator: string; session: ProviderHistorySession }

transcriptEvents(locator, session).then(
  (events) => parentPort?.postMessage({ events }),
  (error: unknown) =>
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }),
)
