import type { DomainEvent } from '@harness/contracts'
import type {
  JsonRpcInput,
  JsonRpcRequestOptions,
  JsonRpcValue,
  ParsedJsonRpcRequestOptions,
  ServerRequestHandler,
} from '@harness/proc'
import { describe, expect, it } from 'vitest'
import { AcpAdapter, type AcpRpc } from './adapter.js'
import type { ToolKind } from './protocol.js'

/**
 * Approval lifecycle under a faithful in-memory transport. It drives
 * session/request_permission and prompt completion through the same public
 * interface as the stdio JSON-RPC transport.
 */

class FakeAcpRpc implements AcpRpc {
  #onServerRequest: ServerRequestHandler = (_method, _params, respond) => respond(null)
  #resolvePrompt: ((result: JsonRpcValue) => void) | undefined

  onStderr(): void {}
  onNotification(): void {}

  onServerRequest(handler: ServerRequestHandler): void {
    this.#onServerRequest = handler
  }

  request(
    method: string,
    params?: JsonRpcInput,
    options?: JsonRpcRequestOptions,
  ): Promise<JsonRpcValue | undefined>
  request<Result>(
    method: string,
    params: JsonRpcInput,
    options: ParsedJsonRpcRequestOptions<Result>,
  ): Promise<Result>
  request<Result>(
    method: string,
    _params: JsonRpcInput = {},
    options: JsonRpcRequestOptions | ParsedJsonRpcRequestOptions<Result> = {},
  ): Promise<JsonRpcValue | undefined | Result> {
    const parse = (value: JsonRpcValue) =>
      'result' in options ? options.result.parse(value) : value
    if (method === 'initialize') {
      return Promise.resolve(
        parse({
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: true } },
        }),
      )
    }
    if (method === 'session/new') return Promise.resolve(parse({ sessionId: 'sess-1' }))
    if (method === 'session/prompt') {
      return new Promise<JsonRpcValue>((resolve) => {
        this.#resolvePrompt = resolve
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
}

let rpc: FakeAcpRpc | undefined

function adapter(): AcpAdapter {
  return new AcpAdapter('gemini', {
    name: 'Gemini',
    command: 'gemini',
    connect: () => {
      rpc = new FakeAcpRpc()
      return rpc
    },
  })
}

function activeRpc(): FakeAcpRpc {
  if (!rpc) throw new Error('ACP test transport is not connected')
  return rpc
}

async function startedAdapter(approval: 'ask' | 'auto') {
  const current = adapter()
  const events: DomainEvent[] = []
  current.on('event', (event) => events.push(event))
  await current.startThread('C:\\repo', { approval })
  const threadId = 'acp-gemini-sess-1'
  const turnId = await current.sendTurn(threadId, 'go')
  return { adapter: current, events, turnId }
}

describe('ACP approval lifecycle', () => {
  it('does not start a turn when attachment preparation fails', async () => {
    const current = adapter()
    const events: DomainEvent[] = []
    current.on('event', (event) => events.push(event))
    await current.startThread('C:\\repo')

    await expect(
      current.sendTurn('acp-gemini-sess-1', 'review', ['preview.png']),
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
