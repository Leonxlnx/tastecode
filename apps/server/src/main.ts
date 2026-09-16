import { installShutdownHandlers, parsePort } from './headless-cli.js'
import { DEFAULT_PORT, startServer } from './server.js'

const port = parsePort(process.env['HARNESS_PORT'] ?? String(DEFAULT_PORT), 'HARNESS_PORT')
const server = await startServer({
  port,
  host: process.env['HARNESS_HOST'] ?? '127.0.0.1',
  accessToken: process.env['HARNESS_ACCESS_TOKEN'],
})

installShutdownHandlers(server)
