import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Exercise the registered handler without importing main.ts and starting Electron.
const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
const start = main.indexOf("  app.on('before-quit', (event) => {")
const end = main.indexOf("\n  app.on('will-quit'", start)
if (start < 0 || end < 0) throw new Error('The main before-quit handler was not found.')

function fixture(
  dispose: () => void | Promise<void>,
  status = 'preparing',
  serverSupervisor?: { stop: () => Promise<void> },
) {
  const events: Array<{ preventDefault: ReturnType<typeof vi.fn> }> = []
  const app = Object.assign(new EventEmitter(), {
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      events.push(event)
      app.emit('before-quit', event)
    }),
  })
  const context = {
    app,
    appUpdater: { state: () => ({ status }), dispose: vi.fn(dispose) },
    waitingForUpdateCleanup: false,
    waitingForServerShutdown: false,
    serverSupervisor,
    appIsQuitting: false,
    previewCaptures: { cancelAll: vi.fn() },
    mainWindowStatePersistence: { saveAndStop: vi.fn() },
    Promise,
  }
  vm.runInNewContext(main.slice(start, end), context)
  return { ...context, context, events }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('quit during an app update', () => {
  it.each(['downloading', 'preparing'])(
    'blocks repeated quit while %s, then allows the final quit once',
    async (status) => {
      let finish!: () => void
      const cleanup = new Promise<void>((resolve) => (finish = resolve))
      const { app, appUpdater, context, events, mainWindowStatePersistence } = fixture(
        () => cleanup,
        status,
      )

      app.quit()
      app.quit()
      await flush()
      app.quit()
      expect(events).toHaveLength(3)
      for (const event of events) expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(appUpdater.dispose).toHaveBeenCalledOnce()
      expect(context.appIsQuitting).toBe(false)
      expect(mainWindowStatePersistence.saveAndStop).not.toHaveBeenCalled()

      finish()
      await flush()
      expect(app.quit).toHaveBeenCalledTimes(4)
      expect(events[3]!.preventDefault).not.toHaveBeenCalled()
      expect(appUpdater.dispose).toHaveBeenCalledOnce()
      expect(context.waitingForUpdateCleanup).toBe(false)
      expect(context.appIsQuitting).toBe(true)
      expect(mainWindowStatePersistence.saveAndStop).toHaveBeenCalledOnce()
    },
  )

  it.each(['throw', 'reject'])(
    'finishes quitting without an unhandled failure when cleanup can %s',
    async (failure) => {
      const { app, appUpdater, events, context } = fixture(() => {
        const error = new Error('Cleanup failed')
        if (failure === 'throw') throw error
        return Promise.reject(error)
      })

      expect(() => app.quit()).not.toThrow()
      await flush()
      expect(app.quit).toHaveBeenCalledTimes(2)
      expect(events[0]!.preventDefault).toHaveBeenCalledOnce()
      expect(events[1]!.preventDefault).not.toHaveBeenCalled()
      expect(appUpdater.dispose).toHaveBeenCalledOnce()
      expect(context.waitingForUpdateCleanup).toBe(false)
      expect(context.appIsQuitting).toBe(true)
    },
  )

  it('allows an ordinary quit without starting update cleanup', () => {
    const { app, appUpdater, events } = fixture(() => {}, 'idle')
    app.quit()
    expect(events[0]!.preventDefault).not.toHaveBeenCalled()
    expect(appUpdater.dispose).not.toHaveBeenCalled()
  })

  it('holds repeated quit requests until the owned server flushes and exits', async () => {
    let finish!: () => void
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const { app, events, context, mainWindowStatePersistence } = fixture(() => {}, 'idle', { stop })
    app.quit()
    app.quit()
    await flush()
    expect(stop).toHaveBeenCalledOnce()
    for (const event of events) expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(context.waitingForServerShutdown).toBe(true)
    finish()
    await flush()
    expect(events).toHaveLength(3)
    expect(events[2]!.preventDefault).not.toHaveBeenCalled()
    expect(context.waitingForServerShutdown).toBe(false)
    expect(mainWindowStatePersistence.saveAndStop).toHaveBeenCalledOnce()
  })

  it('detaches an update before waiting for server shutdown', async () => {
    const calls: string[] = []
    const stop = vi.fn(async () => {
      calls.push('server')
    })
    const { app, events } = fixture(
      async () => {
        calls.push('update')
      },
      'preparing',
      { stop },
    )
    app.quit()
    await flush()
    expect(calls).toEqual(['update', 'server'])
    expect(events).toHaveLength(3)
    expect(events[2]!.preventDefault).not.toHaveBeenCalled()
  })
})
