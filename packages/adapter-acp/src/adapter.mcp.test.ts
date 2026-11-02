import type { JsonRpcValue } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { AcpAdapter, type AcpRpc } from './adapter.js'
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
  constructor(readonly agentCapabilities: JsonRpcValue) {}
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
          ? { sessionId: 'sess-1' }
          : {}
    return Promise.resolve(options.result ? options.result.parse(value) : value)
  }
  notify(): void {}
  dispose(): void {}
}

let rpc: FakeAcpRpc | undefined

const STDIO: AcpMcpServer = { name: 'files', command: 'node', args: ['files.js'], env: [] }
const HTTP: AcpMcpServer = { type: 'http', name: 'docs', url: 'https://mcp.test/', headers: [] }

async function sessionServers(agentCapabilities: JsonRpcValue): Promise<{
  servers: unknown
  logs: string[]
}> {
  rpc = new FakeAcpRpc(agentCapabilities)
  const adapter = new AcpAdapter('gemini', undefined, { servers: [STDIO, HTTP] })
  const logs: string[] = []
  adapter.on('log', (line) => logs.push(line))
  await adapter.startThread('C:\\repo')
  const sessionNew = rpc.requests.find((request) => request.method === 'session/new')
  if (!sessionNew) throw new Error('no session/new was sent')
  return { servers: (sessionNew.params as { mcpServers: unknown }).mcpServers, logs }
}

describe('ACP managed MCP servers', () => {
  it('sends stdio servers and HTTP servers to an agent that accepts HTTP', async () => {
    const { servers, logs } = await sessionServers({ mcpCapabilities: { http: true } })
    expect(servers).toEqual([STDIO, HTTP])
    expect(logs).toEqual([])
  })

  it('leaves HTTP servers out for an agent that advertises only stdio, and says so', async () => {
    const { servers, logs } = await sessionServers({ loadSession: true })
    expect(servers).toEqual([STDIO])
    expect(logs).toEqual([expect.stringContaining('"docs" was left out')])
  })
})
