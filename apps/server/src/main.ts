import { DEFAULT_PORT, startServer } from './server.js'
import { installShutdownHandlers } from './shutdown.js'

const port = Number(process.env['HARNESS_PORT'] ?? DEFAULT_PORT)
const server = startServer({
  port,
  host: process.env['HARNESS_HOST'] ?? '127.0.0.1',
  accessToken: process.env['HARNESS_ACCESS_TOKEN'],
})

installShutdownHandlers(server)
