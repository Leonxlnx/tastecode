import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import type { JsonRpcValue } from '@harness/proc'
import { CodexAdapter } from './adapter.js'

const failures = vi.hoisted(() => [] as ((error: Error) => void)[])
// Test the new proc interface from source without rebuilding a live server's dist.
vi.mock('@harness/proc', async (original) => {
  const { StdioJsonRpc } = await import('../../proc/src/jsonrpc.js')
  return {
    ...(await original<typeof import('@harness/proc')>()),
    StdioJsonRpc: class extends StdioJsonRpc {
      constructor(...args: ConstructorParameters<typeof StdioJsonRpc>) {
        super(...args)
        if (args[2]?.onFailure) failures.push(args[2].onFailure)
      }
    },
  }
})

type Frame = {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}

function peer(options: { omitStarted?: boolean; completeBeforeReply?: boolean } = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, undefined, undefined] as [
      PassThrough,
      PassThrough,
      PassThrough,
      undefined,
      undefined,
    ],
  })
  child.kill = () => {
    child.exitCode = 0
    child.emit('close', 0)
    return true
  }
  const writes: Frame[] = []
  const send = (frame: Frame) => stdout.write(`${JSON.stringify(frame)}\n`)
  stdin.on('data', (chunk: Buffer) => {
    const frame = JSON.parse(chunk.toString()) as Frame
    writes.push(frame)
    if (frame.id === undefined || frame.method === undefined) return
    let result: JsonRpcValue = {}
    if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
      result = { thread: { id: 'thread-1', createdAt: 1_700_000_000 }, model: 'fake-model' }
    }
    if (frame.method === 'turn/start') {
      if (!options.omitStarted) {
        send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
      }
      if (options.completeBeforeReply) {
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
      }
      result = { turn: { id: 'turn-1' } }
    }
    if (frame.method === 'account/read') result = { account: { type: 'apiKey' } }
    if (frame.method === 'skills/list') result = { data: [] }
    if (frame.method === 'mcpServerStatus/list')
      result = {
        data: [
          {
            name: 'fresh',
            serverInfo: null,
            authStatus: 'unsupported',
            tools: {},
            resources: [],
            resourceTemplates: [],
          },
        ],
        nextCursor: null,
      }
    queueMicrotask(() => send({ id: frame.id!, result }))
  })
  return {
    child,
    send,
    writes,
    close: () => {
      child.exitCode = 23
      child.emit('close', 23)
    },
  }
}

const adapters: CodexAdapter[] = []
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
  failures.length = 0
})

function fixture(options: Parameters<typeof peer>[0] = {}) {
  const first = peer(options)
  const second = peer()
  const peers = [first, second]
  const spawn = vi.fn(() => {
    const next = peers.shift()
    if (!next) throw new Error('unexpected process')
    return next.child
  })
  const adapter = new CodexAdapter({ spawn })
  adapters.push(adapter)
  const events: DomainEvent[] = []
  adapter.on('event', (event) => events.push(event))
  return { adapter, first, second, spawn, events }
}

function approval(remote: ReturnType<typeof peer>, rpcId: number | string, itemId: string) {
  remote.send({
    id: rpcId,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId,
      command: 'fake command',
    },
  })
}

function question(remote: ReturnType<typeof peer>, rpcId: number | string, itemId: string) {
  remote.send({
    id: rpcId,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId,
      questions: [],
      autoResolutionMs: null,
    },
  })
}

const terminal = (events: DomainEvent[]) =>
  events.filter((event) => event.type === 'thread.error' || event.type === 'turn.completed')

describe('Codex transport lifetime', () => {
  it.each([false, true])(
    'fails accepted turns and requires resume after a crash (omitStarted=%s)',
    async (omitStarted) => {
      const { adapter, first, second, spawn, events } = fixture({ omitStarted })
      const disconnected = vi.fn(() => events.slice())
      adapter.onDisconnected(disconnected)
      await adapter.start()
      await adapter.startThread(process.cwd())
      await adapter.sendTurn('thread-1', 'Hello')
      approval(first, 100, 'approval')
      question(first, 101, 'question')
      first.close()
      // Proc reports a failure once, and the adapter also guards old transport callbacks.
      failures[0]!(new Error('duplicate failure'))
      expect(terminal(events)).toEqual([
        { type: 'thread.error', threadId: 'thread-1', message: 'Codex exited (code 23)' },
        { type: 'turn.completed', turnId: 'turn-1', status: 'failed' },
      ])
      expect(events).toContainEqual({ type: 'approval.resolved', id: 'approval' })
      expect(events).toContainEqual({ type: 'user_input.resolved', id: 'question' })
      expect(disconnected).toHaveBeenCalledOnce()
      expect(disconnected.mock.results[0]?.value).toEqual(events)
      adapter.respondToApproval('approval', 'approve')
      adapter.respondToUserInput('question', {})
      expect(first.writes.filter((frame) => !frame.method)).toEqual([])
      await adapter.start()
      expect(spawn).toHaveBeenCalledTimes(2)
      await expect(adapter.sendTurn('thread-1', 'Retry')).rejects.toThrow('Start or resume')
      expect(second.writes.some((frame) => frame.method === 'turn/start')).toBe(false)
      await adapter.resumeThread('thread-1', process.cwd())
      failures[0]!(new Error('late old failure'))
      await expect(adapter.sendTurn('thread-1', 'Retry')).resolves.toBe('turn-1')
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(terminal(events)).toHaveLength(2)
      expect(disconnected).toHaveBeenCalledOnce()
    },
  )

  it('restarts one dead shared control connection for concurrent reads', async () => {
    const { adapter, first, second, spawn } = fixture()
    const disconnected = vi.fn()
    const unsubscribe = adapter.onDisconnected(disconnected)
    await adapter.start()
    first.close()
    const [account, skills] = await Promise.all([
      adapter.account(),
      adapter.listSkills(process.cwd()),
      adapter.listMcpServers(),
    ])
    expect(account).toEqual({ signedIn: true, plan: 'API key' })
    expect(skills).toEqual({ skills: [], errors: [] })
    await vi.waitFor(async () =>
      expect((await adapter.listMcpServers()).map(({ id }) => id)).toEqual(['fresh']),
    )
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(second.writes.filter(({ method }) => method === 'initialize')).toHaveLength(1)
    expect(disconnected).toHaveBeenCalledOnce()
    unsubscribe()
    second.close()
    expect(disconnected).toHaveBeenCalledOnce()
  })

  it('does not resurrect a turn that completed before its start reply', async () => {
    const { adapter, first, events } = fixture({ completeBeforeReply: true })
    await adapter.start()
    await adapter.startThread(process.cwd())
    await adapter.sendTurn('thread-1', 'Hello')
    first.close()
    expect(terminal(events)).toEqual([
      { type: 'turn.completed', turnId: 'turn-1', status: 'completed' },
    ])
  })

  it('does not restart a deliberately disposed adapter or fail its turn', async () => {
    const { adapter, spawn, events } = fixture()
    const disconnected = vi.fn()
    adapter.onDisconnected(disconnected)
    await adapter.start()
    await adapter.startThread(process.cwd())
    await adapter.sendTurn('thread-1', 'Hello')
    await adapter.dispose()
    failures[0]!(new Error('late failure after disposal'))
    expect(terminal(events)).toEqual([])
    expect(disconnected).not.toHaveBeenCalled()
    await expect(adapter.account()).rejects.toThrow('adapter not started')
    expect(spawn).toHaveBeenCalledOnce()
  })
})

describe('Codex provider-resolved requests', () => {
  it('matches raw request IDs and threads without replying to resolved requests', async () => {
    const { adapter, first, events } = fixture()
    await adapter.start()
    approval(first, 0, 'numeric')
    approval(first, '0', 'string')
    question(first, 3, 'question')
    const resolve = (requestId: number | string, threadId = 'thread-1') =>
      first.send({
        method: 'serverRequest/resolved',
        params: { threadId, requestId },
      })
    resolve(0, 'another-thread')
    resolve(99)
    expect(events.filter((event) => event.type.endsWith('.resolved'))).toEqual([])
    resolve(0)
    resolve(3)
    resolve(3)
    expect(events.filter((event) => event.type.endsWith('.resolved'))).toEqual([
      { type: 'approval.resolved', id: 'numeric' },
      { type: 'user_input.resolved', id: 'question' },
    ])
    adapter.respondToApproval('numeric', 'approve')
    adapter.respondToUserInput('question', {})
    expect(first.writes.filter((frame) => !frame.method)).toEqual([])
    adapter.respondToApproval('string', 'deny')
    expect(first.writes.filter((frame) => !frame.method)).toEqual([
      { jsonrpc: '2.0', id: '0', result: { decision: 'decline' } },
    ])
  })

  it('does not clear a replacement approval when the old RPC request resolves', async () => {
    const { adapter, first, events } = fixture()
    await adapter.start()
    approval(first, 10, 'reused-item')
    approval(first, 11, 'reused-item')
    events.length = 0
    first.send({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 10 },
    })
    expect(events).toEqual([])
    adapter.respondToApproval('reused-item', 'approve')
    expect(first.writes.filter((frame) => !frame.method)).toEqual([
      { jsonrpc: '2.0', id: 10, result: { decision: 'decline' } },
      { jsonrpc: '2.0', id: 11, result: { decision: 'accept' } },
    ])
  })
})
