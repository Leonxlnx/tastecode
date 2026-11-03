import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonRpcValue } from '@harness/proc'
import { CodexAdapter, codexThreadStartStalledMessage } from './adapter.js'
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

const started = (id: string): JsonRpcValue => ({ thread: { id }, model: 'gpt-6-astra' })

/** A Codex process whose thread/start answers through `answer`, or never. */
function peer(answer: () => Promise<JsonRpcValue> = () => new Promise(() => {})) {
  return new FakeCodexRpc((method) => (method === 'thread/start' ? answer() : {}))
}

const mcpStarting = (rpc: FakeCodexRpc, name: string) =>
  rpc.emitNotification('mcpServer/startupStatus/updated', {
    threadId: 'pending-thread',
    name,
    status: 'starting',
    error: null,
    failureReason: null,
  })

function adapterWithLog() {
  const adapter = new CodexAdapter()
  const logs: string[] = []
  adapter.on('log', (line) => logs.push(line))
  return { adapter, logs }
}

describe('Codex thread start', () => {
  it('keeps waiting while MCP servers report startup progress', async () => {
    vi.useFakeTimers()
    const answer = Promise.withResolvers<JsonRpcValue>()
    const rpc = peer(() => answer.promise)
    peers.queued.push(rpc)
    const { adapter } = adapterWithLog()
    try {
      await adapter.start()
      const thread = adapter.startThread('C:\\test7')
      for (const name of ['docs', 'browser', 'figma', 'repl']) {
        await vi.advanceTimersByTimeAsync(30_000)
        mcpStarting(rpc, name)
      }
      answer.resolve(started('thread-1'))
      await expect(thread).resolves.toMatchObject({ id: 'thread-1' })
      expect(peers.spawned).toBe(1)
      expect(rpc.disposals).toBe(0)
    } finally {
      await adapter.dispose()
    }
  })

  it('stops a silent process and says so plainly', async () => {
    vi.useFakeTimers()
    const rpc = peer()
    peers.queued.push(rpc)
    const { adapter, logs } = adapterWithLog()
    try {
      await adapter.start()
      const thread = adapter.startThread('C:\\test7')
      const failed = expect(thread).rejects.toThrow(codexThreadStartStalledMessage(false, []))
      await vi.advanceTimersByTimeAsync(44_999)
      expect(rpc.disposals).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      await failed
      expect(rpc.disposals).toBe(1)
      expect(logs).toContain('Codex thread/start had no answer and no output for 45s.')
    } finally {
      await adapter.dispose()
    }
  })

  it('gives up at the overall limit and names the MCP servers still starting', async () => {
    vi.useFakeTimers()
    const rpc = peer()
    peers.queued.push(rpc)
    const { adapter } = adapterWithLog()
    try {
      await adapter.start()
      const thread = adapter.startThread('C:\\test7')
      const failed = expect(thread).rejects.toThrow(
        'Codex did not finish starting this chat. MCP servers still starting: browser, docs. Try sending again.',
      )
      mcpStarting(rpc, 'docs')
      mcpStarting(rpc, 'browser')
      rpc.emitNotification('mcpServer/startupStatus/updated', {
        threadId: 'pending-thread',
        name: 'repl',
        status: 'ready',
        error: null,
        failureReason: null,
      })
      for (let elapsed = 0; elapsed < 180_000; elapsed += 20_000) {
        await vi.advanceTimersByTimeAsync(20_000)
        rpc.emitStderr('still starting MCP servers\n')
      }
      await failed
      expect(rpc.disposals).toBe(1)
    } finally {
      await adapter.dispose()
    }
  })

  it('leaves a process that already holds a chat running', async () => {
    vi.useFakeTimers()
    let calls = 0
    const rpc = peer(() =>
      ++calls === 1 ? Promise.resolve(started('thread-1')) : new Promise(() => {}),
    )
    peers.queued.push(rpc)
    const { adapter } = adapterWithLog()
    try {
      await adapter.start()
      await adapter.startThread('C:\\test7')
      const second = adapter.startThread('C:\\test7')
      const failed = expect(second).rejects.toThrow('Codex did not finish starting this chat.')
      await vi.advanceTimersByTimeAsync(45_000)
      await failed
      expect(rpc.disposals).toBe(0)
      expect(peers.spawned).toBe(1)
    } finally {
      await adapter.dispose()
    }
  })

  it('reports a process that exits during the start as that failure', async () => {
    const rpc = peer(() => Promise.reject(new Error('Codex exited (code 1)')))
    peers.queued.push(rpc)
    const { adapter } = adapterWithLog()
    try {
      await adapter.start()
      await expect(adapter.startThread('C:\\test7')).rejects.toThrow('Codex exited (code 1)')
      expect(peers.spawned).toBe(1)
    } finally {
      await adapter.dispose()
    }
  })
})
