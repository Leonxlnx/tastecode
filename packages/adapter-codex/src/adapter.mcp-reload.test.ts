import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@harness/contracts'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'

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

describe('Codex MCP changes', () => {
  // Codex 0.162.1 keeps a loaded thread's MCP layers: `thread/resume` ignores
  // the new `mcp_servers` and `config/mcpServer/reload` only re-reads
  // config.toml. A live reload would report success and change nothing.
  it('offers no live reload, so the server resumes the chat instead', () => {
    expect(Reflect.get(new CodexAdapter(), 'reloadMcpServers')).toBeUndefined()
  })

  it('applies the project servers when the chat resumes on a fresh process', async () => {
    const rpc = new FakeCodexRpc((method) =>
      method === 'thread/resume'
        ? { thread: { id: 't1', createdAt: 1_700_000_000 }, model: 'fake-model' }
        : {},
    )
    proc.rpc = rpc
    const adapter = new CodexAdapter({
      mcpServers: [stdioServer('docs'), { id: 'inherited', enabled: false }],
    })
    try {
      await adapter.start()
      await adapter.resumeThread('t1', process.cwd())

      expect(rpc.calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({
        threadId: 't1',
        config: {
          mcp_servers: {
            docs: { command: 'server.exe', enabled: true },
            inherited: { enabled: false },
          },
        },
      })
    } finally {
      await adapter.dispose()
    }
  })
})
