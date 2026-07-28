import { DEFAULT_PORT, startServer } from './server.js'

const port = Number(process.env['HARNESS_PORT'] ?? DEFAULT_PORT)
const server = startServer(port)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close()
    process.exit(0)
  })
}
