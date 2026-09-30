import { mkdtempSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exitAfterCleanup, startServer } from './server.js'

describe('exitAfterCleanup', () => {
  it('runs the cleanup pass before exiting', async () => {
    const order: string[] = []
    exitAfterCleanup(
      async () => {
        await Promise.resolve()
        order.push('cleanup')
      },
      (code) => order.push(`exit:${code}`),
    )
    await vi.waitFor(() => expect(order).toEqual(['cleanup', 'exit:1']))
  })

  it('still exits when the cleanup pass rejects', async () => {
    const exit = vi.fn()
    exitAfterCleanup(() => Promise.reject(new Error('wedged dispose')), exit)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
  })

  it('exits at the budget when cleanup never settles', async () => {
    vi.useFakeTimers()
    try {
      const exit = vi.fn()
      exitAfterCleanup(() => new Promise(() => {}), exit, 2_000)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(exit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fatal socket error', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('runs the bounded cleanup pass before exit(1) on a port clash', async () => {
    // A plain listener holds the port so the server's bind reports EADDRINUSE.
    const holder = createServer()
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject)
      holder.listen(0, '127.0.0.1', resolve)
    })
    const port = (holder.address() as AddressInfo).port

    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-fatal-'))
    vi.stubEnv('HARNESS_DATA_DIR', dir)
    let exitCode: number | undefined
    const server = startServer({
      port,
      exitProcess: (code) => {
        exitCode = code
      },
    })
    // The error pass awaits the adapter imports inside the shutdown path,
    // which are cold on the first run — well under the test timeout.
    await vi.waitFor(() => expect(exitCode).toBe(1), { timeout: 15_000 })
    await server.close()
    await new Promise<void>((resolve) => holder.close(() => resolve()))

    // The cleanup pass released the data lease: a fresh core can own the same
    // folder. If exit(1) had skipped it, this start would refuse the lock.
    const replacement = startServer({ port: 0, exitProcess: () => {} })
    await replacement.close()
  })
})
