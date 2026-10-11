import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@harness/contracts'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'
import { prepareMcpConfig } from './mcp.js'

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

function signInFixture() {
  const state = { signedIn: false }
  const rpc = new FakeCodexRpc((method) =>
    method === 'mcpServerStatus/list'
      ? {
          data: [
            {
              name: 'docs',
              serverInfo: state.signedIn
                ? { name: 'docs', title: null, version: '1.0.0', description: null }
                : null,
              authStatus: state.signedIn ? 'oAuth' : 'notLoggedIn',
              tools: state.signedIn
                ? { lookup: { name: 'lookup', inputSchema: { type: 'object' } } }
                : {},
              resources: [],
              resourceTemplates: [],
            },
          ],
          nextCursor: null,
        }
      : method === 'mcpServer/oauth/login'
        ? { authorizationUrl: 'https://example.com/authorize' }
        : {},
  )
  proc.rpc = rpc
  return { rpc, state, adapter: new CodexAdapter() }
}

async function loadedInventory(adapter: CodexAdapter) {
  await adapter.listMcpServers('t1')
  await vi.waitFor(async () =>
    expect(await adapter.listMcpServers('t1')).toMatchObject([{ id: 'docs', resources: [] }]),
  )
}

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

  it('reloads the inventory after a successful MCP sign-in', async () => {
    const { rpc, state, adapter } = signInFixture()
    try {
      await adapter.start()
      await loadedInventory(adapter)
      expect((await adapter.listMcpServers('t1'))[0]?.auth.status).toBe('sign_in_required')
      await adapter.startMcpOAuth('docs', 't1')

      state.signedIn = true
      rpc.emitNotification('mcpServer/oauthLogin/completed', {
        name: 'docs',
        threadId: 't1',
        success: true,
      })

      await vi.waitFor(async () =>
        expect(await adapter.listMcpServers('t1')).toMatchObject([
          { auth: { status: 'authenticated' }, tools: [{ name: 'lookup' }] },
        ]),
      )
      expect(rpc.calls.filter((call) => call.method === 'mcpServerStatus/list')).toHaveLength(2)
    } finally {
      await adapter.dispose()
    }
  })

  it('reloads the inventory when a server finishes starting', async () => {
    const { rpc, state, adapter } = signInFixture()
    try {
      await adapter.start()
      await loadedInventory(adapter)

      state.signedIn = true
      rpc.emitNotification('mcpServer/startupStatus/updated', {
        threadId: 't1',
        name: 'docs',
        status: 'ready',
        error: null,
        failureReason: null,
      })

      await vi.waitFor(async () =>
        expect(await adapter.listMcpServers('t1')).toMatchObject([
          { startup: { state: 'ready' }, tools: [{ name: 'lookup' }] },
        ]),
      )
    } finally {
      await adapter.dispose()
    }
  })

  it('blanks header credentials in the shell environment of every chat', async () => {
    const rpc = new FakeCodexRpc(() => ({
      thread: { id: 't1', createdAt: 1_700_000_000 },
      model: 'fake-model',
    }))
    proc.rpc = rpc
    const options = {
      mcpServers: [
        {
          id: 'docs',
          enabled: true,
          transport: {
            type: 'http',
            url: 'https://example.com/mcp',
            headers: {
              Authorization: { source: 'credential', credentialRef: 'mcp/docs/auth' },
            },
          },
        } satisfies McpServerConfig,
      ],
      mcpCredentials: { 'mcp/docs/auth': 'Bearer secret-value' },
    }
    const [variable] = Object.keys(
      prepareMcpConfig(options.mcpServers, options.mcpCredentials).environment,
    )
    const adapter = new CodexAdapter(options)
    try {
      await adapter.start()
      await adapter.startThread(process.cwd())
      await adapter.resumeThread('t1', process.cwd())

      for (const method of ['thread/start', 'thread/resume']) {
        expect(rpc.calls.find((call) => call.method === method)?.params).toMatchObject({
          config: {
            mcp_servers: { docs: { env_http_headers: { Authorization: variable } } },
            [`shell_environment_policy.set.${variable}`]: '',
          },
        })
      }
    } finally {
      await adapter.dispose()
    }
  })
})
