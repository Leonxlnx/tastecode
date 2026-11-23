import type { JsonRpcValue } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { AcpAdapter, type AcpLaunchOptions, type AcpRpc } from './adapter.js'
import type { AcpMcpServer } from './mcp.js'

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

/** Answers initialize with the given capabilities and records every request. */
class FakeAcpRpc implements Partial<AcpRpc> {
  requests: Array<{ method: string; params: unknown }> = []
  constructor(
    readonly agentCapabilities: JsonRpcValue,
    readonly configOptions?: unknown[],
  ) {}
  onStderr(): void {}
  onNotification(): void {}
  onServerRequest(): void {}
  request(
    method: string,
    params: unknown = {},
    options: { result?: { parse: (value: unknown) => unknown } } = {},
  ): Promise<unknown> {
    this.requests.push({ method, params })
    const value =
      method === 'initialize'
        ? { protocolVersion: 1, agentCapabilities: this.agentCapabilities }
        : method === 'session/new'
          ? {
              sessionId: 'sess-1',
              ...(this.configOptions ? { configOptions: this.configOptions } : {}),
            }
          : {}
    return Promise.resolve(options.result ? options.result.parse(value) : value)
  }
  notify(): void {}
  dispose(): void {}
}

let rpc: FakeAcpRpc | undefined

const STDIO: AcpMcpServer = { name: 'files', command: 'node', args: ['files.js'], env: [] }
const HTTP: AcpMcpServer = {
  type: 'http',
  name: 'docs',
  url: 'https://mcp.test/',
  headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
}

async function sessionServers(
  agentCapabilities: JsonRpcValue,
  launch?: AcpLaunchOptions,
): Promise<{
  servers: AcpMcpServer[]
  logs: string[]
}> {
  rpc = new FakeAcpRpc(agentCapabilities)
  const adapter = new AcpAdapter('gemini', launch, { servers: [STDIO, HTTP] })
  const logs: string[] = []
  adapter.on('log', (line) => logs.push(line))
  await adapter.startThread('C:\\repo')
  const sessionNew = rpc.requests.find((request) => request.method === 'session/new')
  if (!sessionNew) throw new Error('no session/new was sent')
  return { servers: (sessionNew.params as { mcpServers: AcpMcpServer[] }).mcpServers, logs }
}

describe('ACP managed MCP servers', () => {
  it('sends stdio servers and HTTP servers to an agent that accepts HTTP', async () => {
    const { servers, logs } = await sessionServers({ mcpCapabilities: { http: true } })
    expect(servers).toEqual([STDIO, HTTP])
    expect(logs).toEqual([])
  })

  it('passes HTTP servers straight through when assumeHttpMcp is set', async () => {
    const { servers, logs } = await sessionServers(
      { loadSession: true },
      { name: 'Antigravity', command: 'agy', args: ['acp'], assumeHttpMcp: true },
    )
    expect(servers).toEqual([STDIO, HTTP])
    expect(logs).toEqual([])
  })

  it('bridges HTTP servers over stdio for an agent that advertises only stdio, keeping secrets in env', async () => {
    const { servers, logs } = await sessionServers({ loadSession: true })
    expect(logs).toEqual([])
    expect(servers).toHaveLength(2)
    expect(servers[0]).toEqual(STDIO)
    const bridged = servers[1]!
    expect('type' in bridged).toBe(false)
    if ('type' in bridged) throw new Error('expected stdio bridge')
    expect(bridged.name).toBe('docs')
    expect(bridged.command).toBe(process.execPath)
    expect(bridged.args.join(' ')).not.toContain('secret-token')
    expect(bridged.env).toEqual(
      expect.arrayContaining([
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        expect.objectContaining({ value: 'https://mcp.test/' }),
        expect.objectContaining({ value: JSON.stringify({ Authorization: 'Bearer secret-token' }) }),
      ]),
    )
  })

  it('applies model, thought_level and mode config options on start, turn updates and setApproval', async () => {
    rpc = new FakeAcpRpc({ loadSession: true }, [
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'gemini-4-neon',
        options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
      },
      {
        id: 'thought_level',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'mode',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'accept-edits', name: 'Accept edits' },
        ],
      },
    ])
    const adapter = new AcpAdapter('antigravity', {
      name: 'Antigravity',
      command: 'agy',
      args: ['acp'],
      assumeHttpMcp: true,
      modeForApproval: (approval, available) => {
        const wanted = approval === 'auto' ? 'accept-edits' : 'default'
        return available.includes(wanted) ? wanted : undefined
      },
    })
    const thread = await adapter.startThread('C:\\repo', {
      model: 'gemini-4-neon',
      effort: 'low',
      approval: 'auto',
    })
    expect(rpc.requests.filter((r) => r.method === 'session/set_config_option')).toEqual([
      {
        method: 'session/set_config_option',
        params: { sessionId: 'sess-1', configId: 'model', value: 'gemini-4-neon' },
      },
      {
        method: 'session/set_config_option',
        params: { sessionId: 'sess-1', configId: 'thought_level', value: 'low' },
      },
      {
        method: 'session/set_config_option',
        params: { sessionId: 'sess-1', configId: 'mode', value: 'accept-edits' },
      },
    ])
    await adapter.setApproval('ask')
    await adapter.sendTurn(thread.id, 'hi', [], { effort: 'high' })
    expect(rpc.requests.filter((r) => r.method === 'session/set_config_option').slice(-2)).toEqual([
      {
        method: 'session/set_config_option',
        params: { sessionId: 'sess-1', configId: 'mode', value: 'default' },
      },
      {
        method: 'session/set_config_option',
        params: { sessionId: 'sess-1', configId: 'thought_level', value: 'high' },
      },
    ])
  })
})
