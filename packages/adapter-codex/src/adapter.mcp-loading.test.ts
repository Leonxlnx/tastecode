import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { JsonRpcValue } from '@harness/proc'
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

/** Shape captured from Codex 0.163 `config/read`; names, paths and URLs are fixtures. */
const configRead = JSON.parse(
  readFileSync(new URL('./fixtures/config-read-mcp-codex-0.163.json', import.meta.url), 'utf8'),
) as JsonRpcValue

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const statusRow = (name: string) => ({
  name,
  serverInfo: { name, title: null, version: '1.0.0', description: null },
  authStatus: 'unsupported',
  tools: {},
  resources: [],
  resourceTemplates: [],
})

const configuredRow = (id: string, state: 'starting' | 'stopped' = 'starting') => ({
  id,
  scope: 'global',
  enabled: true,
  startup: { state },
  tools: [],
  resources: [],
  resourceTemplates: [],
})

function lateStatusList(config: () => JsonRpcValue | Promise<JsonRpcValue> = () => configRead) {
  const status = deferred<JsonRpcValue>()
  const rpc = new FakeCodexRpc((method) => {
    if (method === 'config/read') return config()
    if (method === 'mcpServerStatus/list') return status.promise
    if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-5.6' }
    return {}
  })
  proc.rpc = rpc
  const adapter = new CodexAdapter()
  const changed = vi.fn()
  adapter.onMcpChanged(changed)
  return { adapter, rpc, status, changed }
}

describe('Codex MCP inventory while the status list loads', () => {
  it('shows configured servers as starting until the late status list lands', async () => {
    const { adapter, rpc, status, changed } = lateStatusList()
    await adapter.start()

    const first = await adapter.listMcpServers()
    expect(first).toEqual([
      configuredRow('hosted-docs'),
      configuredRow('local-tools'),
      configuredRow('repl'),
      configuredRow('retired', 'stopped'),
      configuredRow('signed-api'),
    ])
    // Commands, URLs, environments and token variables stay in Codex.
    expect(JSON.stringify(first)).not.toMatch(/example\.test|FIXTURE_TOKEN|REPL_HOME|tools\.mjs/)
    expect(adapter.isMcpLoading()).toBe(true)

    await adapter.listMcpServers()
    expect(rpc.calls.filter(({ method }) => method === 'config/read')).toEqual([
      { method: 'config/read', params: { includeLayers: false }, timeoutMs: 10_000 },
    ])
    expect(rpc.calls.filter(({ method }) => method === 'mcpServerStatus/list')).toHaveLength(1)
    expect(changed).not.toHaveBeenCalled()

    const listed = adapter.whenMcpServersListed()
    status.resolve({ data: [statusRow('hosted-docs'), statusRow('plugin-apps')], nextCursor: null })
    await expect(listed).resolves.toBe(true)
    expect(changed).toHaveBeenCalledOnce()
    expect(adapter.isMcpLoading()).toBe(false)
    expect((await adapter.listMcpServers()).map(({ id, startup }) => [id, startup])).toEqual([
      ['hosted-docs', { state: 'ready' }],
      ['plugin-apps', { state: 'ready' }],
    ])
    await adapter.dispose()
  })

  it('keeps reported startup states and reads the chat folder for a thread', async () => {
    const { adapter, rpc } = lateStatusList()
    await adapter.start()
    const thread = await adapter.startThread('/work/project')
    rpc.emitNotification('mcpServer/startupStatus/updated', {
      threadId: thread.id,
      name: 'repl',
      status: 'failed',
      error: 'program not found',
      failureReason: null,
    })
    rpc.emitNotification('mcpServer/startupStatus/updated', {
      threadId: thread.id,
      name: 'plugin-apps',
      status: 'starting',
      error: null,
      failureReason: null,
    })

    const servers = await adapter.listMcpServers(thread.id)
    expect(servers.map(({ id, startup }) => [id, startup])).toEqual([
      ['hosted-docs', { state: 'starting' }],
      ['local-tools', { state: 'starting' }],
      ['plugin-apps', { state: 'starting' }],
      ['repl', { state: 'failed', message: 'program not found' }],
      ['retired', { state: 'stopped' }],
      ['signed-api', { state: 'starting' }],
    ])
    expect(rpc.calls.find(({ method }) => method === 'config/read')?.params).toEqual({
      includeLayers: false,
      cwd: '/work/project',
    })
    expect(adapter.isMcpLoading(thread.id)).toBe(true)
    expect(adapter.isMcpLoading()).toBe(false)
    await adapter.dispose()
  })

  it('falls back to reported startup states when the config cannot be read', async () => {
    const { adapter } = lateStatusList(() => Promise.reject(new Error('config/read failed')))
    const logs: string[] = []
    adapter.on('log', (line) => logs.push(line))
    await adapter.start()

    await expect(adapter.listMcpServers()).resolves.toEqual([])
    expect(adapter.isMcpLoading()).toBe(true)
    expect(logs).toContain('Could not read configured MCP servers: config/read failed')
    await adapter.dispose()
  })

  it('reports a failed status list as not listed', async () => {
    const { adapter, status, changed } = lateStatusList()
    await adapter.start()
    await adapter.listMcpServers()
    const listed = adapter.whenMcpServersListed()
    status.reject(new Error('Codex request timed out'))
    await expect(listed).resolves.toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(adapter.isMcpLoading()).toBe(false)
    await adapter.dispose()
  })
})
