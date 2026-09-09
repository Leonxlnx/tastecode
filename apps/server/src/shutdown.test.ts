import { describe, expect, it, vi } from 'vitest'
import { OWNED_PROCESS_SHUTDOWN_MESSAGE } from '@harness/proc'
import { installShutdownHandlers } from './shutdown.js'

type Signal = 'SIGINT' | 'SIGTERM'

function fakeProcess() {
  const handlers = new Map<Signal, () => void>()
  let messageHandler: ((message: unknown) => void) | undefined
  const exit = vi.fn()
  return {
    process: {
      once: (signal: Signal, handler: () => void) => handlers.set(signal, handler),
      on: (_event: 'message', handler: (message: unknown) => void) => {
        messageHandler = handler
      },
      exit,
    },
    emit: (signal: Signal) => handlers.get(signal)?.(),
    message: (message: unknown) => messageHandler?.(message),
    exit,
  }
}

describe('server shutdown', () => {
  it('reports a failed close with a failing process exit', async () => {
    const runtime = fakeProcess()
    const report = vi.fn()
    installShutdownHandlers(
      { close: vi.fn().mockRejectedValue(new Error('preview port remained in use')) },
      runtime.process,
      report,
    )

    runtime.emit('SIGTERM')
    await vi.waitFor(() => expect(runtime.exit).toHaveBeenCalledWith(1))

    expect(report).toHaveBeenCalledWith('[server] shutdown failed: preview port remained in use')
  })

  it('closes once across repeated signals and exits successfully', async () => {
    const runtime = fakeProcess()
    const close = vi.fn().mockResolvedValue(undefined)
    installShutdownHandlers({ close }, runtime.process, vi.fn())

    runtime.emit('SIGINT')
    runtime.emit('SIGTERM')
    await vi.waitFor(() => expect(runtime.exit).toHaveBeenCalledWith(0))

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes through the parent-process shutdown request', async () => {
    const runtime = fakeProcess()
    const close = vi.fn().mockResolvedValue(undefined)
    installShutdownHandlers({ close }, runtime.process, vi.fn())

    runtime.message(OWNED_PROCESS_SHUTDOWN_MESSAGE)
    await vi.waitFor(() => expect(runtime.exit).toHaveBeenCalledWith(0))

    expect(close).toHaveBeenCalledOnce()
  })
})
