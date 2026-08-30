import { DEFAULT_PORT, startServer } from './server.js'
import { installShutdownHandlers } from './shutdown.js'

const port = Number(process.env['HARNESS_PORT'] ?? DEFAULT_PORT)
try {
  const server = await startServer({
    port,
    host: process.env['HARNESS_HOST'] ?? '127.0.0.1',
    accessToken: process.env['HARNESS_ACCESS_TOKEN'],
  })

  installShutdownHandlers(server)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[server] ${message}`)
  process.exitCode = 1
}
