import { DEFAULT_PORT, startServer } from './server.js'

const port = Number(process.env['HARNESS_PORT'] ?? DEFAULT_PORT)
const server = startServer({
  port,
  host: process.env['HARNESS_HOST'] ?? '127.0.0.1',
  accessToken: process.env['HARNESS_ACCESS_TOKEN'],
})

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  void Promise.resolve()
    .then(() => server.close())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('[server] shutdown failed', error)
        process.exit(1)
      },
    )
}

function shutdownMessage(value: unknown): void {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === 1 &&
    Object.hasOwn(value, 'type') &&
    'type' in value &&
    value.type === 'harness:shutdown'
  )
    shutdown()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown)
process.on('message', shutdownMessage)

// Electron utility processes expose their private parent channel separately
// from Node's child_process IPC channel.
const parentPort = (
  process as typeof process & {
    parentPort?: { on(event: 'message', listener: (event: { data: unknown }) => void): void }
  }
).parentPort
parentPort?.on('message', (event) => shutdownMessage(event.data))
