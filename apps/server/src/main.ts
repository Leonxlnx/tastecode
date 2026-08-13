import { DEFAULT_PORT, startServer } from './server.js'

const port = Number(process.env['HARNESS_PORT'] ?? DEFAULT_PORT)
const server = startServer({
  port,
  host: process.env['HARNESS_HOST'] ?? '127.0.0.1',
  accessToken: process.env['HARNESS_ACCESS_TOKEN'],
  ...(process.env['HARNESS_WEB_DEV_SERVER']
    ? { webDevServerUrl: process.env['HARNESS_WEB_DEV_SERVER'] }
    : {}),
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0))
  })
}
