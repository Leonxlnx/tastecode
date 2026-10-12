import { DEFAULT_PORT, startServer } from './server.js'

// The desktop's legacy launch runs this server as Electron in Node mode.
// Electron reads the switch only while it starts; left here, every terminal
// and provider CLI would inherit it, and an Electron app started from one of
// them would come up as plain Node.
delete process.env['ELECTRON_RUN_AS_NODE']

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
// A legacy desktop child keeps running when the main process dies without
// asking it to stop (crash, kill), and it would hold the port and the data
// lease against the next launch. Losing the parent's IPC channel means no one
// owns this server any more. Without an IPC channel this never fires.
process.on('disconnect', shutdown)

// Electron utility processes expose their private parent channel separately
// from Node's child_process IPC channel.
const parentPort = (
  process as typeof process & {
    parentPort?: { on(event: 'message', listener: (event: { data: unknown }) => void): void }
  }
).parentPort
parentPort?.on('message', (event) => shutdownMessage(event.data))
