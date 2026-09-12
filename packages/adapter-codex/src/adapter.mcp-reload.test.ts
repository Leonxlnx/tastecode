import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@harness/contracts'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc, type RecordedRpcCall } from './fake-rpc.test-support.js'

const proc = vi.hoisted(() => ({ rpc: undefined as FakeCodexRpc | undefined }))

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    constructor() {
      if (!proc.rpc) throw new Error('fake Codex RPC was not installed')
      return proc.rpc
    }
  },
}))

const stdioServer = (id: string): McpServerConfig => ({
  id,
  enabled: true,
  transport: { type: 'stdio', command: 'server.exe' },
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function mcpRpc(state: { failResume: boolean }) {
  return new FakeCodexRpc((method) => {
    if (method === 'thread/resume') {
      if (state.failResume) throw new Error('no such thread')
      return { threadId: 't1' }
    }
    if (method === 'mcpServerStatus/list') {
      return {
        data: [
          {
            name: 'github',
            serverInfo: {
              name: 'github',
              title: 'GitHub',
              description: null,
              version: '1.0',
            },
            authStatus: 'unsupported',
            tools: {},
            resources: [],
            resourceTemplates: [],
          },
        ],
        nextCursor: null,
      }
    }
    return {}
  })
}

async function startedAdapter() {
  const state = { failResume: false }
  const rpc = mcpRpc(state)
  proc.rpc = rpc
  const adapter = new CodexAdapter({
    mcpServers: [stdioServer('github')],
  })
  await adapter.start()

  // Prime the per-thread inventory cache.
  await adapter.listMcpServers('t1')
  await settle()
  const cached = await adapter.listMcpServers('t1')
  expect(cached.map((server) => server.id)).toEqual(['github'])

  rpc.calls.splice(0)
  return { adapter, rpc, state }
}

const listCalls = (calls: RecordedRpcCall[]): RecordedRpcCall[] =>
  calls.filter((call) => call.method === 'mcpServerStatus/list')

describe('Codex MCP hot-reload', () => {
  it('reloads in order and drops the stale inventory cache on success', async () => {
    const { adapter, rpc } = await startedAdapter()
    const changed = vi.fn()
    adapter.on('mcpChanged', changed)

    await adapter.reloadMcpServers('t1', [stdioServer('github'), stdioServer('files')], {})

    expect(rpc.calls.map((call) => call.method)).toEqual([
      'thread/resume',
      'config/mcpServer/reload',
    ])
    expect(changed).toHaveBeenCalledWith({ threadId: 't1' })

    await adapter.listMcpServers('t1')
    expect(listCalls(rpc.calls)).toHaveLength(1)
  })

  it('keeps config and cache untouched when the process refuses the reload', async () => {
    const { adapter, rpc, state } = await startedAdapter()
    state.failResume = true

    await expect(adapter.reloadMcpServers('t1', [stdioServer('files')], {})).rejects.toThrow(
      'Codex could not hot-reload MCP config; start a new session to apply it',
    )

    expect(rpc.calls.map((call) => call.method)).toEqual(['thread/resume'])
    const cached = await adapter.listMcpServers('t1')
    expect(cached.map((server) => server.id)).toEqual(['github'])
    expect(listCalls(rpc.calls)).toHaveLength(0)
  })

  it('refuses to hot-reload changed credentials', async () => {
    const withSecret: McpServerConfig = {
      id: 'github',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: { source: 'credential', credentialRef: 'github-token' } },
      },
    }
    const rpc = mcpRpc({ failResume: false })
    proc.rpc = rpc
    const adapter = new CodexAdapter({
      mcpServers: [withSecret],
      mcpCredentials: { 'github-token': 'old-secret' },
    })
    await adapter.start()

    await expect(
      adapter.reloadMcpServers('t1', [withSecret], { 'github-token': 'new-secret' }),
    ).rejects.toThrow('start a new session to apply new MCP credentials')
    expect(rpc.calls.some((call) => call.method === 'thread/resume')).toBe(false)
  })
})
