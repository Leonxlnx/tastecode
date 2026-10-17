import { readFileSync } from 'node:fs'
import type { DomainEvent } from '@harness/contracts'
import type {
  JsonRpcRequestOptions,
  JsonRpcValue,
  ParsedJsonRpcRequestOptions,
  ServerRequestHandler,
} from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { AcpAdapter, type AcpRpc } from './adapter.js'

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    constructor() {
      if (!rpc) throw new Error('fake ACP RPC was not installed')
      return rpc
    }
  },
}))

/** A sanitized `available_commands_update` from grok 1.0.62 `agent stdio`, no prompt sent. */
const captured = JSON.parse(
  readFileSync(new URL('./fixtures/available-commands-grok-1.0.62.json', import.meta.url), 'utf8'),
) as { [key: string]: JsonRpcValue }

/** Grok sends its commands while session/new is still pending, as captured. */
class FakeAcpRpc implements AcpRpc {
  #onNotification: (method: string, params: JsonRpcValue | undefined) => void = () => {}
  #resolvePrompt: ((result: JsonRpcValue) => void) | undefined
  /** Notifications the agent sends before it answers session/new. */
  beforeSession: [string, JsonRpcValue][] = []

  onStderr(): void {}
  onNotification(handler: (method: string, params: JsonRpcValue | undefined) => void): void {
    this.#onNotification = handler
  }
  onServerRequest(_handler: ServerRequestHandler): void {}
  notify(): void {}
  dispose(): void {}

  emit(method: string, params: JsonRpcValue): void {
    this.#onNotification(method, params)
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
    if (method === 'initialize') return Promise.resolve(parse({ protocolVersion: 1 }))
    if (method === 'session/new') {
      for (const [name, params] of this.beforeSession) this.emit(name, params)
      return Promise.resolve(parse({ sessionId: captured.sessionId! }))
    }
    if (method === 'session/prompt') {
      return new Promise<JsonRpcValue>((resolve) => {
        this.#resolvePrompt = resolve
      }).then(parse)
    }
    return Promise.resolve(parse({}))
  }

  resolvePrompt(result: JsonRpcValue): void {
    this.#resolvePrompt?.(result)
  }
}

let rpc: FakeAcpRpc | undefined

function grokOverAcp() {
  const remote = new FakeAcpRpc()
  rpc = remote
  return {
    adapter: new AcpAdapter('grok', { name: 'Grok', command: 'grok', provider: 'grok' }),
    remote,
  }
}

function update(sessionUpdate: string, availableCommands: JsonRpcValue[]): JsonRpcValue {
  return { sessionId: captured.sessionId!, update: { sessionUpdate, availableCommands } }
}

describe('ACP available commands', () => {
  it('keeps the list an agent sends before session/new answers', async () => {
    const { adapter, remote } = grokOverAcp()
    remote.beforeSession.push(['session/update', captured], ['session/update', captured])
    const changed = vi.fn()
    adapter.on('commandsChanged', changed)
    await adapter.startThread('C:\\repo')
    const commands = await adapter.listCommands()
    expect(commands).toHaveLength(13)
    expect(commands.find((command) => command.name === 'user:help')).toEqual({
      name: 'user:help',
      description: 'Help with configuration and features',
      kind: 'skill',
    })
    // The second, identical frame announces nothing new.
    expect(changed).toHaveBeenCalledOnce()
    await adapter.dispose()
    await expect(adapter.listCommands()).resolves.toEqual([])
  })

  it('replaces the list on a later update and accepts the older update name', async () => {
    const { adapter, remote } = grokOverAcp()
    await adapter.startThread('C:\\repo')
    const changed = vi.fn()
    const off = adapter.onCommandsChanged(changed)
    remote.emit('session/update', update('available_commands_update', [{ name: 'compact' }]))
    remote.emit('session/update', update('available_commands', [{ name: 'context' }, 'broken']))
    await expect(adapter.listCommands()).resolves.toEqual([{ name: 'context', description: '' }])
    expect(changed).toHaveBeenCalledTimes(2)
    off()
    remote.emit('session/update', update('available_commands_update', []))
    expect(changed).toHaveBeenCalledTimes(2)
    await adapter.dispose()
  })

  it('ignores another session and leaves a running turn untouched', async () => {
    const { adapter, remote } = grokOverAcp()
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(`acp-grok-${String(captured.sessionId)}`, 'go')
    remote.emit('session/update', {
      sessionId: 'another-session',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'x' }] },
    })
    remote.emit('session/update', update('available_commands_update', [{ name: 'compact' }]))
    remote.emit('session/update', {
      sessionId: captured.sessionId!,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    })
    await expect(adapter.listCommands()).resolves.toEqual([{ name: 'compact', description: '' }])
    remote.resolvePrompt({ stopReason: 'end_turn' })
    await new Promise((resolve) => setImmediate(resolve))
    // The command lists added nothing to the turn; its message streamed as usual.
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'item.started',
      'item.completed',
      'turn.completed',
    ])
    expect(JSON.stringify(events[1])).toContain('hi')
    expect(events.at(-1)).toEqual({ type: 'turn.completed', turnId, status: 'completed' })
    await adapter.dispose()
  })
})
