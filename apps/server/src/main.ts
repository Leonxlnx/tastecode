import { DEFAULT_PORT, parsePort } from './server-config.js'
import { startServer } from './server.js'

// Unset or empty keeps the default; anything else must parse like the
// headless CLI's --port, or listen() fails on NaN with no usable message.
const configuredPort = process.env['HARNESS_PORT']
const port = configuredPort ? parsePort(configuredPort, 'HARNESS_PORT') : DEFAULT_PORT
const server = await startServer({
  port,
  host: process.env['HARNESS_HOST'] ?? '127.0.0.1',
  accessToken: process.env['HARNESS_ACCESS_TOKEN'],
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0))
  })
}
