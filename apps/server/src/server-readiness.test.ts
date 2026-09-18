import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { startServer } from './server.js'

describe('server readiness', () => {
  it('rejects an occupied port without opening the profile', async () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'harness-server-port-clash-'))
    const previousDataDirectory = process.env['HARNESS_DATA_DIR']
    process.env['HARNESS_DATA_DIR'] = dataDirectory
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('missing reserved port')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await expect(startServer({ port: address.port, host: '127.0.0.1' })).rejects.toMatchObject({
        code: 'EADDRINUSE',
        message:
          `port ${address.port} is already in use — another TasteCode server is probably ` +
          'still running. Stop it, or set HARNESS_PORT to a free port.',
      })
      expect(readdirSync(dataDirectory)).toEqual([])
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      )
      if (previousDataDirectory === undefined) delete process.env['HARNESS_DATA_DIR']
      else process.env['HARNESS_DATA_DIR'] = previousDataDirectory
      rmSync(dataDirectory, { recursive: true, force: true })
    }
  })

  it('releases the control port when profile initialization fails', async () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'harness-server-start-failure-'))
    const blockedDataDirectory = path.join(dataDirectory, 'not-a-directory')
    writeFileSync(blockedDataDirectory, '')
    const previousDataDirectory = process.env['HARNESS_DATA_DIR']
    process.env['HARNESS_DATA_DIR'] = blockedDataDirectory
    const port = await freePort()

    try {
      await expect(startServer({ port, host: '127.0.0.1' })).rejects.toThrow()
      expect(await portIsOpen(port)).toBe(false)
    } finally {
      if (previousDataDirectory === undefined) delete process.env['HARNESS_DATA_DIR']
      else process.env['HARNESS_DATA_DIR'] = previousDataDirectory
      rmSync(dataDirectory, { recursive: true, force: true })
    }
  })

  it('announces readiness after the server begins listening', async () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'harness-server-readiness-'))
    const previousDataDirectory = process.env['HARNESS_DATA_DIR']
    process.env['HARNESS_DATA_DIR'] = dataDirectory
    const port = await freePort()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let server: Awaited<ReturnType<typeof startServer>> | undefined

    try {
      const starting = startServer({ port, host: '127.0.0.1' })
      const loggedSynchronously = log.mock.calls.some(([message]) =>
        String(message).includes('[server] listening'),
      )
      server = await starting
      await expect(welcomeFrom(port)).resolves.toMatchObject({ channel: 'server.welcome' })
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

  it('drains a held-open HTTP request inside the shutdown budget', async () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'harness-server-drain-'))
    const previousDataDirectory = process.env['HARNESS_DATA_DIR']
    process.env['HARNESS_DATA_DIR'] = dataDirectory
    const port = await freePort()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    let stalled: ReturnType<typeof connect> | undefined

    try {
      server = await startServer({ port, host: '127.0.0.1' })
      // A request that never finishes would otherwise hold the listener's
      // close() pending for the full 300s request timeout.
      stalled = connect({ host: '127.0.0.1', port })
      const socket = stalled
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
      const destroyed = new Promise<void>((resolve) => socket.once('close', () => resolve()))

      const startedAt = Date.now()
      await server.close()
      expect(Date.now() - startedAt).toBeLessThan(15_000)
      await destroyed
      server = undefined
    } finally {
      stalled?.destroy()
      await server?.close()
      log.mockRestore()
      if (previousDataDirectory === undefined) delete process.env['HARNESS_DATA_DIR']
      else process.env['HARNESS_DATA_DIR'] = previousDataDirectory
      rmSync(dataDirectory, { recursive: true, force: true })
    }
  })

  it('runs shutdown once across repeated close calls', async () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), 'harness-server-close-'))
    const previousDataDirectory = process.env['HARNESS_DATA_DIR']
    process.env['HARNESS_DATA_DIR'] = dataDirectory
    const port = await freePort()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let server: Awaited<ReturnType<typeof startServer>> | undefined

    try {
      server = await startServer({ port, host: '127.0.0.1' })
      // A double SIGINT — or any second caller — rides the same drain.
      await Promise.all([server.close(), server.close()])
      await server.close()
      server = undefined
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

function welcomeFrom(port: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    socket.once('message', (raw) => {
      socket.close()
      resolve(JSON.parse(raw.toString()))
    })
    socket.once('error', reject)
  })
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
