// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRANSPORT_LIMITS, type ConnectionState, type Transport } from '../transport.js'
import { acquireTerminalLease } from './terminal-ownership.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('terminal close ownership', () => {
  it('waits beyond the transport request deadline before dispatching an offline close', async () => {
    const harness = fakeTransport('reconnecting')
    const lease = acquireTerminalLease(harness.transport, 'owner-A')
    lease.release()
    lease.closeWhenUnleased('terminal-A')
    await vi.advanceTimersByTimeAsync(TRANSPORT_LIMITS.requestTimeoutMs * 3)
    expect(harness.request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.listeners.size).toBe(1)

    harness.setState('open')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.request).toHaveBeenCalledExactlyOnceWith('terminal.close', {
      terminalId: 'terminal-A',
    })
    expect(harness.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a failed close after its request expires, then sends it on reconnect', async () => {
    const harness = fakeTransport('open')
    harness.request.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error('The request expired before it could be sent. Try again when connected.'),
              ),
            TRANSPORT_LIMITS.requestTimeoutMs,
          )
        }),
    )
    const lease = acquireTerminalLease(harness.transport, 'owner-A')
    lease.release()
    lease.closeWhenUnleased('terminal-A')
    harness.setState('reconnecting')
    await vi.advanceTimersByTimeAsync(TRANSPORT_LIMITS.requestTimeoutMs * 2)
    expect(harness.request).toHaveBeenCalledTimes(1)
    expect(harness.listeners.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    harness.setState('open')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.request.mock.calls).toEqual([
      ['terminal.close', { terminalId: 'terminal-A' }],
      ['terminal.close', { terminalId: 'terminal-A' }],
    ])
    expect(harness.listeners.size).toBe(0)
  })

  it('cancels an offline close when its owner returns', async () => {
    const harness = fakeTransport('reconnecting')
    const old = acquireTerminalLease(harness.transport, 'owner-A')
    old.release()
    old.closeWhenUnleased('terminal-A')
    const current = acquireTerminalLease(harness.transport, 'owner-A')
    expect(harness.listeners.size).toBe(0)
    harness.setState('open')
    await vi.advanceTimersByTimeAsync(TRANSPORT_LIMITS.requestTimeoutMs * 2)
    expect(harness.request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    current.release()
    current.closeWhenUnleased('terminal-A')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.request).toHaveBeenCalledTimes(1)
    expect(harness.listeners.size).toBe(0)
  })

  it('shares one connection listener and cancels only the matching owner', async () => {
    const harness = fakeTransport('reconnecting')
    const first = acquireTerminalLease(harness.transport, 'owner-A')
    const second = acquireTerminalLease(harness.transport, 'owner-B')
    first.release()
    second.release()
    first.closeWhenUnleased('terminal-A')
    second.closeWhenUnleased('terminal-B')
    first.closeWhenUnleased('terminal-A')
    expect(harness.listeners.size).toBe(1)
    const current = acquireTerminalLease(harness.transport, 'owner-A')
    harness.setState('open')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.request).toHaveBeenCalledExactlyOnceWith('terminal.close', {
      terminalId: 'terminal-B',
    })
    expect(harness.listeners.size).toBe(0)
    current.release()
  })

  it('bounds retries on one connection, then retries on a fresh connection', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const harness = fakeTransport('open')
    harness.request.mockRejectedValue(new Error('The connection is busy.'))
    const lease = acquireTerminalLease(harness.transport, 'owner-A')
    lease.release()
    lease.closeWhenUnleased('terminal-A')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.request).toHaveBeenCalledTimes(4)
    expect(warning).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.listeners.size).toBe(1)

    harness.request.mockResolvedValue({})
    harness.setState('reconnecting')
    harness.setState('open')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.request).toHaveBeenCalledTimes(5)
    expect(harness.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['reacquire', 'shutdown'] as const)(
    'clears a retry timer and listener on %s',
    async (action) => {
      const harness = fakeTransport('open')
      harness.request.mockRejectedValue(new Error('Too many requests are waiting for the server.'))
      const lease = acquireTerminalLease(harness.transport, 'owner-A')
      lease.release()
      lease.closeWhenUnleased('terminal-A')
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      const current =
        action === 'reacquire' ? acquireTerminalLease(harness.transport, 'owner-A') : undefined
      if (action === 'shutdown') harness.setState('closed')
      expect(vi.getTimerCount()).toBe(0)
      expect(harness.listeners.size).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.request).toHaveBeenCalledTimes(1)
      current?.release()
    },
  )

  it('ignores a late rejected close after a matching lease cancels it', async () => {
    const harness = fakeTransport('open')
    let reject!: (reason: Error) => void
    harness.request.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        }),
    )
    const old = acquireTerminalLease(harness.transport, 'owner-A')
    old.release()
    old.closeWhenUnleased('terminal-A')
    const current = acquireTerminalLease(harness.transport, 'owner-A')
    reject(new Error('Connection to the server was lost.'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.request).toHaveBeenCalledTimes(1)
    expect(harness.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    current.release()
  })
})

function fakeTransport(initial: ConnectionState) {
  let state = initial
  const listeners = new Set<(value: ConnectionState) => void>()
  const request = vi.fn(
    async (_method: string, _params: { terminalId: string }): Promise<object> => ({}),
  )
  const transport = {
    get state() {
      return state
    },
    request,
    onState(listener: (value: ConnectionState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as Transport
  return {
    transport,
    request,
    listeners,
    setState(next: ConnectionState) {
      state = next
      for (const listener of listeners) listener(next)
    },
  }
}
