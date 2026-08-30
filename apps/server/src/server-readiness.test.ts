import { mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startServer } from './server.js'

describe('server readiness', () => {
  it('announces readiness after the server begins listening', async () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'harness-server-readiness-'))
    const previousDataDirectory = process.env['HARNESS_DATA_DIR']
    process.env['HARNESS_DATA_DIR'] = dataDirectory
    const port = await freePort()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let server: ReturnType<typeof startServer> | undefined

    try {
      server = startServer({ port, host: '127.0.0.1' })
      const loggedSynchronously = log.mock.calls.some(([message]) =>
        String(message).includes('[server] listening'),
      )
      await waitForPort(port)
      expect(loggedSynchronously).toBe(false)
      expect(log).toHaveBeenCalledWith(`[server] listening on ws://127.0.0.1:${port}`)
    } finally {
      await server?.close()
      log.mockRestore()
      if (previousDataDirectory === undefined) delete process.env['HARNESS_DATA_DIR']
      else process.env['HARNESS_DATA_DIR'] = previousDataDirectory
      rmSync(dataDirectory, { recursive: true, force: true })
    }
  })
})

async function freePort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await portIsOpen(port))) {
    if (Date.now() >= deadline) throw new Error(`server port ${port} did not become ready`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}
