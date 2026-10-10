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
  /** Client-to-agent notifications and permission answers, in wire order. */
  wire: string[] = []

  onStderr(): void {}

  onNotification(handler: (method: string, params: JsonRpcValue | undefined) => void): void {
    this.#onNotification = handler
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

  notify(method: string): void {
    this.wire.push(method)
  }
  dispose(): void {}

  sessionUpdate(update: { [key: string]: JsonRpcValue }): void {
    this.#onNotification('session/update', { sessionId: 'sess-1', update })
  }

  requestPermission(
    kind: ToolKind,
    toolCall: { [key: string]: JsonRpcValue } = {},
  ): Promise<JsonRpcValue> {
    return new Promise((resolve) => {
      this.#onServerRequest(
        'session/request_permission',
        {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 'tc-1', title: 'do something', kind, ...toolCall },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
            { optionId: 'always', kind: 'allow_always', name: 'Always' },
            { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
          ],
        },
        (result) => {
          this.wire.push('session/request_permission answer')
          resolve(result)
        },
      )
    })
  }

  resolvePrompt(result: JsonRpcValue): void {
    const resolve = this.#resolvePrompt
    if (!resolve) throw new Error('no ACP prompt is pending')
    this.#resolvePrompt = undefined
    resolve(result)
  }

  rejectPrompt(): void {
    this.#rejectPrompt?.(new Error('prompt failed'))
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

  it('answers a pending approval with cancelled after Stop sends session/cancel', async () => {
    const { adapter, events, turnId } = await startedAdapter('ask')
    const answered = activeRpc().requestPermission('execute')

    await adapter.interrupt()

    // ACP: the client cancels first, then answers every pending permission
    // request with `cancelled` so the agent can resolve its prompt.
    await expect(answered).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(activeRpc().wire).toEqual(['session/cancel', 'session/request_permission answer'])
    expect(events).toContainEqual({ type: 'approval.resolved', id: 'tc-1' })

    // A late click on the stale card must not reach the agent.
    adapter.respondToApproval('tc-1', 'approve')
    expect(activeRpc().wire).toHaveLength(2)

    activeRpc().resolvePrompt({ stopReason: 'cancelled' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events.filter((event) => event.type === 'approval.resolved')).toHaveLength(1)
    expect(events).toContainEqual({ type: 'turn.completed', turnId, status: 'interrupted' })
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

describe('ACP spec-valid null fields', () => {
  it('asks about a permission request whose optional tool fields are null', async () => {
    const { adapter, events } = await startedAdapter('ask')
    let answer: JsonRpcValue | 'unanswered' = 'unanswered'
    void activeRpc()
      .requestPermission('execute', {
        title: 'rm -rf build',
        status: null,
        content: null,
        locations: null,
        rawInput: null,
      })
      .then((result) => (answer = result))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(answer).toBe('unanswered')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval.requested',
        request: expect.objectContaining({ id: 'tc-1', kind: 'command', command: 'rm -rf build' }),
      }),
    )
    await adapter.dispose()
  })

  it('answers a switch_mode permission request under full access', async () => {
    const { adapter } = await startedAdapter('full')
    await expect(activeRpc().requestPermission('switch_mode')).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
    await adapter.dispose()
  })

  it('completes a tool call whose updates carry null fields', async () => {
    const { adapter, events, turnId } = await startedAdapter('ask')
    const remote = activeRpc()
    remote.sessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'Edit notes.txt',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'notes.txt', line: null }],
      rawInput: null,
    })
    remote.sessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-2',
      title: null,
      status: null,
      content: [{ type: 'diff', path: 'notes.txt', oldText: 'old\n', newText: 'new\n' }],
    })
    remote.sessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-2',
      kind: null,
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'resource_link',
            uri: 'file:///notes.txt',
            name: 'notes.txt',
            mimeType: null,
          },
        },
      ],
      locations: null,
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'item.completed',
        item: expect.objectContaining({ id: 'tc-2', type: 'file_change', status: 'completed' }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'diff.updated',
        turnId,
        diff: expect.stringContaining('-old\n+new\n'),
      }),
    )
    await adapter.dispose()
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
