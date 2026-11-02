import os from 'node:os'
import path from 'node:path'
import type { McpServerConfig } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_ACCOUNT_HOME, codexAccountEnvironment } from './account-home.js'
import { CodexAdapter } from './adapter.js'
import { codexLoginStatus } from './auth.js'
import { CODEX_CAPABILITIES } from './capabilities.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'
import { prepareMcpConfig } from './mcp.js'

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  StdioJsonRpc: class {
    constructor() {
      return new FakeCodexRpc()
    }
  },
}))

const home = path.join(os.tmpdir(), 'tastecode-accounts', 'codex', 'work')

describe('Codex account homes', () => {
  it('selects an account folder with CODEX_HOME and leaves the default account alone', () => {
    expect(CODEX_CAPABILITIES.multipleAccounts).toBe(true)
    expect(CODEX_ACCOUNT_HOME.environment(home)).toEqual({ CODEX_HOME: home })
    expect(codexAccountEnvironment(home)).toEqual({ CODEX_HOME: home })
    expect(codexAccountEnvironment(undefined)).toEqual({})
  })

  it("names the CLI's own folder as the default one", () => {
    expect(CODEX_ACCOUNT_HOME.defaultHome({ CODEX_HOME: home })).toBe(home)
    expect(CODEX_ACCOUNT_HOME.defaultHome({})).toBe(path.join(os.homedir(), '.codex'))
  })

  it("starts a new folder empty, without the default account's keys or login pins", () => {
    expect(CODEX_ACCOUNT_HOME.seedFiles).toEqual([])
  })

  it("starts the app-server in the account's folder, next to its MCP variables", async () => {
    const spawn = vi.fn(() => ({ pid: 1 }) as never)
    const mcpServers: McpServerConfig[] = [
      {
        id: 'docs',
        enabled: true,
        transport: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: { source: 'credential', credentialRef: 'mcp/docs/auth' } },
        },
      },
    ]
    const mcpCredentials = { 'mcp/docs/auth': 'Bearer fixture' }
    const adapter = new CodexAdapter({ spawn, mcpServers, mcpCredentials, accountHome: home })
    const defaultAdapter = new CodexAdapter({ spawn })
    try {
      await adapter.start()
      await defaultAdapter.start()
      const mcpEnvironment = prepareMcpConfig(mcpServers, mcpCredentials).environment
      expect(spawn).toHaveBeenNthCalledWith(1, 'codex', expect.arrayContaining(['app-server']), {
        env: { ...mcpEnvironment, CODEX_HOME: home },
      })
      expect(spawn).toHaveBeenNthCalledWith(2, 'codex', expect.arrayContaining(['app-server']), {
        env: {},
      })
    } finally {
      await adapter.dispose()
      await defaultAdapter.dispose()
    }
  })

  it("checks the sign-in of the account's folder", async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: 'Not logged in\n' })
    await expect(codexLoginStatus(run, { accountHome: home })).resolves.toBe('unauthenticated')
    expect(run).toHaveBeenCalledWith('codex', ['login', 'status'], undefined, {
      env: { CODEX_HOME: home },
    })

    await codexLoginStatus(run)
    expect(run).toHaveBeenLastCalledWith('codex', ['login', 'status'])
  })
})
