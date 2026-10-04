import type { DomainEvent } from '@harness/contracts'
import type {
  JsonRpcRequestOptions,
  JsonRpcValue,
  ParsedJsonRpcRequestOptions,
  ServerRequestHandler,
} from '@harness/proc'
import { spawnCli } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { AcpAdapter, type AcpRpc } from './adapter.js'
import type { ToolKind } from './protocol.js'

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    constructor(_child: unknown, _name: string, options: { onFailure?: (error: Error) => void }) {
      if (!rpc) throw new Error('fake ACP RPC was not installed')
      rpc.failTransport = options.onFailure
      return rpc
    }
  },
}))

/**
 * Approval lifecycle under a faithful in-memory transport. It drives
 * session/request_permission and prompt completion through the same public
 * interface as the stdio JSON-RPC transport.
 */

class FakeAcpRpc implements AcpRpc {
  #onServerRequest: ServerRequestHandler = (_method, _params, respond) => respond(null)
  #onNotification: (method: string, params: JsonRpcValue | undefined) => void = () => {}
  #resolvePrompt: ((result: JsonRpcValue) => void) | undefined
  #rejectPrompt: ((error: Error) => void) | undefined
  failTransport: ((error: Error) => void) | undefined
  loadSession = false
  methods: string[] = []

  onStderr(): void {}
  onNotification(handler: (method: string, params: JsonRpcValue | undefined) => void): void {
    this.#onNotification = handler
  }

  emitNotification(method: string, params: JsonRpcValue): void {
    this.#onNotification(method, params)
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.#onServerRequest = handler
  }

  request(
    method: string,
    params?: unknown,
    options?: JsonRpcRequestOptions,
  ): Promise<JsonRpcValue | undefined>
  request<Result>(
    method: string,
    params: unknown,
    options: ParsedJsonRpcRequestOptions<Result>,
  ): Promise<Result>
  request<Result>(
    method: string,
    _params: unknown = {},
    options: JsonRpcRequestOptions | ParsedJsonRpcRequestOptions<Result> = {},
  ): Promise<JsonRpcValue | undefined | Result> {
    const parse = (value: JsonRpcValue) =>
      'result' in options ? options.result.parse(value) : value
    this.methods.push(method)
    if (method === 'initialize') {
      return Promise.resolve(
        parse({
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: this.loadSession,
            promptCapabilities: { image: true },
          },
        }),
      )
    }
    if (method === 'session/new') return Promise.resolve(parse({ sessionId: 'sess-1' }))
    if (method === 'session/prompt') {
      return new Promise<JsonRpcValue>((resolve, reject) => {
        this.#resolvePrompt = resolve
        this.#rejectPrompt = reject
      }).then(parse)
    }
    return Promise.resolve(parse({}))
  }

  notify(): void {}
  dispose(): void {}

  requestPermission(kind: ToolKind): Promise<JsonRpcValue> {
    return new Promise((resolve) => {
      this.#onServerRequest(
        'session/request_permission',
        {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 'tc-1', title: 'do something', kind },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
            { optionId: 'always', kind: 'allow_always', name: 'Always' },
            { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
          ],
        },
        resolve,
      )
    })
  }

  resolvePrompt(result: JsonRpcValue): void {
    const resolve = this.#resolvePrompt
    if (!resolve) throw new Error('no ACP prompt is pending')
    this.#resolvePrompt = undefined
    resolve(result)
  }

  rejectPrompt(error = new Error('prompt failed')): void {
    this.#rejectPrompt?.(error)
  }
}

let rpc: FakeAcpRpc | undefined

function adapter(): AcpAdapter {
  rpc = new FakeAcpRpc()
  return new AcpAdapter('grok', {
    name: 'Grok',
    command: 'grok',
    provider: 'grok',
  })
}

function activeRpc(): FakeAcpRpc {
  if (!rpc) throw new Error('ACP test transport is not connected')
  return rpc
}

async function startedAdapter(approval: 'ask' | 'auto' | 'full') {
  const current = adapter()
  const events: DomainEvent[] = []
  current.on('event', (event) => events.push(event))
  await current.startThread('C:\\repo', { approval })
  const threadId = 'acp-grok-sess-1'
  const turnId = await current.sendTurn(threadId, 'go')
  return { adapter: current, events, turnId }
}

describe('ACP approval lifecycle', () => {
  it('settles failed prompts and makes the old approval unanswerable', async () => {
    const { adapter, events, turnId } = await startedAdapter('ask')
    const answer = activeRpc().requestPermission('execute')
    activeRpc().rejectPrompt()
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    adapter.respondToApproval('tc-1', 'approve')
    expect(events).toContainEqual({ type: 'approval.resolved', id: 'tc-1' })
    expect(events).toContainEqual({ type: 'turn.completed', turnId, status: 'failed' })
    await expect(adapter.sendTurn('acp-grok-sess-1', 'retry')).resolves.toBeTypeOf('string')
    await adapter.dispose()
  })

  it.each([false, true])(
    'signals transport loss after terminal cleanup (active: %s)',
    async (active) => {
      const current = adapter()
      const events: DomainEvent[] = []
      current.on('event', (event) => events.push(event))
      const disconnected = vi.fn(() => events.slice())
      current.onDisconnected(disconnected)
      await current.startThread('C:\\repo')
      if (active) await current.sendTurn('acp-grok-sess-1', 'go')
      const remote = activeRpc()
      const pending = active ? remote.requestPermission('execute') : undefined
      remote.failTransport!(new Error('process died'))
      remote.failTransport!(new Error('late process failure'))
      remote.rejectPrompt()
      await new Promise((resolve) => setImmediate(resolve))
      if (pending) await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
      expect(disconnected).toHaveBeenCalledOnce()
      expect(disconnected.mock.results[0]!.value).toEqual(events)
      expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(active ? 1 : 0)
      await current.dispose()
    },
  )

  it('does not leave a lasting grant when changing full access to ask', async () => {
    const { adapter, events } = await startedAdapter('full')
    await expect(activeRpc().requestPermission('execute')).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
    adapter.setApproval('ask')
    const pending = activeRpc().requestPermission('execute')
    expect(events).toContainEqual(expect.objectContaining({ type: 'approval.requested' }))
    adapter.respondToApproval('tc-1', 'deny')
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    await adapter.dispose()
  })

  it('does not start a turn when attachment preparation fails', async () => {
    const current = adapter()
    const events: DomainEvent[] = []
    current.on('event', (event) => events.push(event))
    await current.startThread('C:\\repo')

    await expect(
      current.sendTurn('acp-grok-sess-1', 'review', ['preview.png']),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(events).toEqual([])
  })

  it('answers an abandoned approval with cancelled when the turn ends', async () => {
    const { events, turnId } = await startedAdapter('ask')
    const answered = activeRpc().requestPermission('execute')

    activeRpc().resolvePrompt({ stopReason: 'end_turn' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(answered).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events).toContainEqual(expect.objectContaining({ type: 'approval.resolved' }))
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'turn.completed', turnId, status: 'completed' }),
    )
  })

  it('settles text, tool and approval exactly once when the prompt request rejects', async () => {
    const { events, turnId } = await startedAdapter('ask')
    const update = (value: JsonRpcValue) =>
      activeRpc().emitNotification('session/update', { sessionId: 'sess-1', update: value })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' answer' } })
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-run',
      status: 'in_progress',
      title: 'pnpm test',
      kind: 'execute',
    })
    const answered = activeRpc().requestPermission('execute')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const settledFrom = events.length

    activeRpc().rejectPrompt(new Error('Internal error: MCP server exited'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A frame that arrives after the turn ended must not reopen it.
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } })

    // The agent, still blocked on its permission request, hears "cancelled".
    await expect(answered).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events).toContainEqual({
      type: 'item.completed',
      item: expect.objectContaining({ type: 'message', text: 'partial answer' }),
    })
    // Every open item and approval is terminal before the turn is, each once,
    // then the reason, then the turn itself — and nothing after it.
    expect(events.slice(settledFrom)).toEqual([
      {
        type: 'item.completed',
        item: expect.objectContaining({ id: 'tc-run', status: 'failed', command: 'pnpm test' }),
      },
      { type: 'approval.resolved', id: expect.any(String) },
      {
        type: 'thread.error',
        threadId: 'acp-grok-sess-1',
        message: 'Internal error: MCP server exited',
      },
      { type: 'turn.completed', turnId, status: 'failed' },
    ])
  })

  it('auto mode only waves through reads — mutations stay questions', async () => {
    const { events } = await startedAdapter('auto')

    const read = activeRpc().requestPermission('read')
    await expect(read).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })

    for (const kind of ['execute', 'edit', 'delete', 'move', 'fetch'] as const) {
      void activeRpc().requestPermission(kind)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const asked = events.filter((event) => event.type === 'approval.requested')
    expect(asked).toHaveLength(5)
  })
})

describe('ACP launch-only settings', () => {
  const launch = (loadSession: boolean) => {
    rpc = new FakeAcpRpc()
    rpc.loadSession = loadSession
    return new AcpAdapter('grok', {
      name: 'Grok',
      command: 'grok',
      provider: 'grok',
      argsFor: ({ model, effort }) => [
        'agent',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--reasoning-effort', effort] : []),
        'stdio',
      ],
      settings: { model: 'a', effort: 'low' },
    })
  }

  it('relaunches with the new settings and reloads the same session', async () => {
    const current = launch(true)
    await current.startThread('C:\\repo', {})
    expect(vi.mocked(spawnCli).mock.lastCall?.[1]).toEqual([
      'agent',
      '--model',
      'a',
      '--reasoning-effort',
      'low',
      'stdio',
    ])
    const relaunched = new FakeAcpRpc()
    relaunched.loadSession = true
    rpc = relaunched
    vi.mocked(spawnCli).mockClear()

    await current.sendTurn('acp-grok-sess-1', 'go', [], { model: 'b', effort: 'high' })
    expect(vi.mocked(spawnCli).mock.calls.map(([, args]) => args)).toEqual([
      ['agent', '--model', 'b', '--reasoning-effort', 'high', 'stdio'],
    ])
    expect(relaunched.methods).toEqual(['initialize', 'session/load', 'session/prompt'])

    relaunched.resolvePrompt({ stopReason: 'end_turn' })
    await vi.waitFor(() =>
      expect(current.sendTurn('acp-grok-sess-1', 'again', [], { model: 'b' })).resolves.toEqual(
        expect.any(String),
      ),
    )
    expect(spawnCli).toHaveBeenCalledOnce()
  })

  it('refuses a change it cannot apply instead of ignoring it', async () => {
    const current = launch(false)
    await current.startThread('C:\\repo', {})
    await expect(current.sendTurn('acp-grok-sess-1', 'go', [], { effort: 'high' })).rejects.toThrow(
      'Start a new chat to change them',
    )
    expect(current.resumable).toBe(false)
  })
})
