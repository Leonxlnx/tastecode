import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'

const peers = vi.hoisted(() => ({ queued: [] as FakeCodexRpc[], spawned: 0 }))
vi.mock('@harness/proc', async (original) => ({
  ...(await original<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    constructor() {
      peers.spawned += 1
      const rpc = peers.queued.shift()
      if (!rpc) throw new Error('unexpected Codex process')
      return rpc
    }
  },
}))

afterEach(() => {
  peers.queued = []
  peers.spawned = 0
  vi.useRealTimers()
})

const timedOut = () =>
  new FakeCodexRpc(() => Promise.reject(new Error('Codex request timed out: initialize')))

describe('Codex initialization recovery', () => {
  it('shares concurrent startup and finishes cleanup before retrying once', async () => {
    const first = timedOut()
    const cleanup = Promise.withResolvers<void>()
    first.dispose = vi.fn(() => cleanup.promise)
    const recovered = new FakeCodexRpc()
    peers.queued.push(first, recovered)
    const adapter = new CodexAdapter()
    try {
      const requests = [adapter.start(), adapter.start(), adapter.start()]
      await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce())
      expect(peers.spawned).toBe(1)
      cleanup.resolve()
      await Promise.all(requests)
      expect(peers.spawned).toBe(2)
      expect(recovered.calls).toEqual([
        expect.objectContaining({ method: 'initialize', timeoutMs: 30_000 }),
      ])
      await adapter.start()
      expect(peers.spawned).toBe(2)
    } finally {
      cleanup.resolve()
      await adapter.dispose()
    }
  })

  it('allows a cold initialization to take longer than an account read', async () => {
    vi.useFakeTimers()
    const peer = new FakeCodexRpc(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 15_000)),
    )
    peers.queued.push(peer)
    const adapter = new CodexAdapter()
    try {
      const ready = adapter.start()
      await vi.advanceTimersByTimeAsync(15_000)
      await ready
      expect(peers.spawned).toBe(1)
      expect(peer.calls[0]?.timeoutMs).toBeGreaterThan(15_000)
    } finally {
      await adapter.dispose()
    }
  })

  it('stops after two initialization timeouts and disposes both processes', async () => {
    const first = timedOut()
    const second = timedOut()
    peers.queued.push(first, second)
    const adapter = new CodexAdapter()
    await expect(adapter.start()).rejects.toThrow('Codex request timed out: initialize')
    expect(peers.spawned).toBe(2)
    expect([first.disposals, second.disposals]).toEqual([1, 1])
    await adapter.dispose()
  })

  it('does not retry explicit protocol failures', async () => {
    const peer = new FakeCodexRpc(() => Promise.reject(new Error('unsupported client')))
    peers.queued.push(peer)
    const adapter = new CodexAdapter()
    await expect(adapter.start()).rejects.toThrow('unsupported client')
    expect(peers.spawned).toBe(1)
    expect(peer.disposals).toBe(1)
    await adapter.dispose()
  })

  it('does not restart a process after disposal cancels pending recovery', async () => {
    const first = timedOut()
    const cleanup = Promise.withResolvers<void>()
    first.dispose = vi.fn(() => cleanup.promise)
    peers.queued.push(first)
    const adapter = new CodexAdapter()
    const rejected = expect(adapter.start()).rejects.toThrow('timed out')
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce())
    const stopped = adapter.dispose()
    cleanup.resolve()
    await Promise.all([stopped, rejected])
    expect(peers.spawned).toBe(1)
  })
})
