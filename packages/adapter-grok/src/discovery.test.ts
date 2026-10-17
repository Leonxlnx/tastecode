import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { methods, SkillSchema } from '@harness/contracts'
import type { JsonRpcValue } from '@harness/proc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoverGrokProject,
  mapGrokMcpServer,
  mapGrokSkills,
  type GrokDiscoveryRpc,
} from './discovery.js'

type Frame =
  | { at: number; method: string; params: JsonRpcValue }
  | { at: number; response: string; result: JsonRpcValue }

/**
 * grok 1.0.62 `agent stdio`, initialize and session/new without a prompt, in
 * the order and at the times captured (ms after spawn). Sanitized: invented
 * server, skill and session names and paths. The last command update, with
 * the connected server's tools, came 0.4-0.9 s after mcp_initialized on
 * other runs and is placed there.
 */
const captured: Frame[] = readFileSync(
  new URL('./fixtures/acp-session-grok-1.0.62.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Frame)

/** Replays captured frames on the fake clock; requests answer when Grok answered them. */
class ReplayRpc implements GrokDiscoveryRpc {
  readonly calls: string[] = []
  disposed = false
  #handler: ((method: string, params: JsonRpcValue | undefined) => void) | undefined
  readonly #started = Date.now()
  readonly #frames: Frame[]

  constructor(frames: Frame[] = captured, options: { failSessionNew?: Error } = {}) {
    this.#frames = frames
    this.#failSessionNew = options.failSessionNew
    for (const frame of frames) {
      if ('method' in frame) setTimeout(() => this.#handler?.(frame.method, frame.params), frame.at)
    }
  }
  readonly #failSessionNew: Error | undefined

  onNotification(handler: (method: string, params: JsonRpcValue | undefined) => void): void {
    this.#handler = handler
  }

  request(method: string): Promise<JsonRpcValue | undefined> {
    this.calls.push(method)
    if (method === 'session/new' && this.#failSessionNew)
      return Promise.reject(this.#failSessionNew)
    const frame = this.#frames.find((entry) => 'response' in entry && entry.response === method)
    if (!frame || !('result' in frame) || method === 'session/close') {
      return Promise.resolve(frame && 'result' in frame ? frame.result : null)
    }
    return new Promise((resolve) =>
      setTimeout(() => resolve(frame.result), Math.max(0, this.#started + frame.at - Date.now())),
    )
  }

  dispose(): void {
    this.disposed = true
  }
}

const SESSION = '01a14b32-0000-7000-8000-000000000002'
let home: string
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  home = mkdtempSync(path.join(tmpdir(), 'grok-home-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
})

/** What grok 1.0.62 logs to the session's events.jsonl as it connects servers (sanitized). */
function logConnections(projectPath: string): void {
  const folder = path.join(home, 'sessions', encodeURIComponent(projectPath), SESSION)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    path.join(folder, 'events.jsonl'),
    [
      { ts: '2026-10-17T18:49:09.900Z', type: 'mcp_config_resolved', servers: [], disabled: [] },
      {
        ts: '2026-10-17T18:49:10.600Z',
        type: 'mcp_server_failed',
        server_name: 'remote-docs',
        transport: 'http',
        error_type: 'auth_required',
      },
      {
        ts: '2026-10-17T18:49:10.700Z',
        type: 'mcp_server_connected',
        server_name: 'design-kit',
        transport: 'stdio',
        tool_count: 2,
        duration_ms: 400,
        tools: ['preview', 'capture'],
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n{"type":"mcp_ser',
  )
}

describe('Grok project discovery', () => {
  it('reports the captured commands, skills and MCP servers, then closes the session', async () => {
    const rpc = new ReplayRpc()
    const updates: Awaited<ReturnType<typeof discoverGrokProject>>[] = []
    logConnections('C:\\repo')
    const discovery = discoverGrokProject('C:\\repo', {
      connect: () => rpc,
      grokHome: home,
      onUpdate: (inventory) => updates.push(inventory),
    })
    // The last status, at 2935 ms, completes it; tool names come from the log.
    await vi.advanceTimersByTimeAsync(2_934)
    expect(rpc.disposed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const inventory = await discovery

    expect(inventory.commands).toHaveLength(13)
    expect(inventory.commands.find((command) => command.name === 'goal')).toEqual({
      name: 'goal',
      description: 'Set or check an autonomous goal',
      argumentHint: '<objective> | status | clear',
    })
    expect(
      inventory.servers.map(({ id, startup, auth, tools }) => ({ id, startup, auth, tools })),
    ).toEqual([
      {
        id: 'remote-docs',
        startup: { state: 'stopped' },
        auth: { status: 'sign_in_required', method: 'oauth' },
        tools: [],
      },
      {
        id: 'design-kit',
        startup: { state: 'ready' },
        auth: { status: 'not_required' },
        tools: [
          { name: 'preview', inputSchema: {} },
          { name: 'capture', inputSchema: {} },
        ],
      },
    ])
    // Grok names the transport only for some servers; it is never passed on.
    expect(inventory.servers.every((server) => server.transport === undefined)).toBe(true)
    expect(inventory.skills.map(({ name, scope }) => `${name}:${scope}`)).toEqual([
      'user:help:user',
      'release-notes:user',
      'brand-voice-old:user',
      'code-review:system',
      'bundled:imagine:system',
      'design-kit:user',
    ])
    // Grok listed its commands while its MCP servers still started.
    expect(updates).toHaveLength(1)
    expect(updates[0]!.commands).toHaveLength(13)
    expect(updates[0]!.servers).toEqual([
      expect.objectContaining({ id: 'remote-docs', startup: { state: 'starting' } }),
    ])
    expect(rpc.calls).toEqual(['initialize', 'session/new', 'session/close'])
    expect(rpc.disposed).toBe(true)
    expect(
      methods['mcp.list'].result.parse({
        capabilities: {
          inventory: true,
          add: true,
          update: true,
          remove: true,
          reload: false,
          startOAuth: false,
          cancelOAuth: false,
        },
        servers: inventory.servers,
      }).servers,
    ).toEqual(inventory.servers)
    for (const skill of inventory.skills) expect(SkillSchema.parse(skill)).toEqual(skill)
  })

  it('answers with servers still starting when Grok never finishes them', async () => {
    const rpc = new ReplayRpc(
      captured.filter(
        (frame) =>
          !('method' in frame) ||
          (frame.method !== '_x.ai/mcp/server_status' && frame.method !== '_x.ai/mcp_initialized'),
      ),
    )
    const discovery = discoverGrokProject('C:\\repo', {
      connect: () => rpc,
      grokHome: home,
      settleMs: 5_000,
    })
    await vi.advanceTimersByTimeAsync(2_444 + 4_999)
    expect(rpc.disposed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const inventory = await discovery
    expect(inventory.servers).toEqual([
      expect.objectContaining({ id: 'remote-docs', startup: { state: 'starting' } }),
    ])
    expect(rpc.calls.at(-1)).toBe('session/close')
    expect(rpc.disposed).toBe(true)
  })

  it('names tools from a command update when Grok sends one in time, without a log', async () => {
    // The update with the servers' tools came 0.4-0.9 s after mcp_initialized on
    // some runs; here it lands before the last status.
    const rpc = new ReplayRpc(
      captured.map((frame) => (frame.at === 3_767 ? { ...frame, at: 2_900 } : frame)),
    )
    const discovery = discoverGrokProject('C:\\repo', { connect: () => rpc, grokHome: home })
    await vi.advanceTimersByTimeAsync(2_935)
    const inventory = await discovery
    expect(inventory.servers.find((server) => server.id === 'design-kit')?.tools).toEqual([
      { name: 'preview', inputSchema: {} },
      { name: 'capture', inputSchema: {} },
    ])
  })

  it('leaves a server without tools when neither source names them', async () => {
    const rpc = new ReplayRpc(captured.filter((frame) => frame.at !== 3_767))
    const discovery = discoverGrokProject('C:\\repo', { connect: () => rpc, grokHome: home })
    await vi.advanceTimersByTimeAsync(2_935)
    const inventory = await discovery
    expect(inventory.servers.find((server) => server.id === 'design-kit')).toMatchObject({
      startup: { state: 'ready' },
      tools: [],
    })
  })

  it('does not wait for MCP when Grok has no servers to start', async () => {
    const rpc = new ReplayRpc(
      captured.filter((frame) => !('method' in frame) || !frame.method.startsWith('_x.ai/mcp')),
    )
    const discovery = discoverGrokProject('C:\\repo', { connect: () => rpc, grokHome: home })
    await vi.advanceTimersByTimeAsync(2_444 + 1_500)
    const inventory = await discovery
    expect(inventory.commands).toHaveLength(13)
    expect(inventory.servers).toEqual([])
  })

  it('stops the process when canceled or when Grok cannot start a session', async () => {
    const abort = new AbortController()
    const canceled = new ReplayRpc()
    const discovery = discoverGrokProject('C:\\repo', {
      connect: () => canceled,
      grokHome: home,
      signal: abort.signal,
    })
    const rejected = expect(discovery).rejects.toThrow('canceled')
    await vi.advanceTimersByTimeAsync(2_500)
    abort.abort()
    await rejected
    expect(canceled.calls).toEqual(['initialize', 'session/new', 'session/close'])
    expect(canceled.disposed).toBe(true)

    const signedOut = new ReplayRpc(captured, { failSessionNew: new Error('Auth required') })
    const failed = expect(
      discoverGrokProject('C:\\repo', { connect: () => signedOut, grokHome: home }),
    ).rejects.toThrow('Auth required')
    await vi.advanceTimersByTimeAsync(1_000)
    await failed
    expect(signedOut.calls).toEqual(['initialize', 'session/new'])
    expect(signedOut.disposed).toBe(true)
  })
})

describe('Grok inventory mapping', () => {
  it('keeps the useful part of a failed server and its tools', () => {
    expect(
      mapGrokMcpServer('docs', {
        status: 'unavailable',
        reason: 'spawn_failed',
        detail: "MCP server 'docs' failed: Transport [rmcp::Worker<a::B<c>>] error: not found",
        tools: ['search', 'fetch'],
      }),
    ).toMatchObject({
      startup: { state: 'failed', message: "MCP server 'docs' failed: Transport error: not found" },
      auth: { status: 'not_required' },
      tools: [
        { name: 'search', inputSchema: {} },
        { name: 'fetch', inputSchema: {} },
      ],
    })
    expect(mapGrokMcpServer('docs', { status: 'unavailable' }).startup).toEqual({
      state: 'failed',
      message: 'MCP server failed to start',
    })
  })

  it('maps skills by their SKILL.md path with Grok scope and shown name', () => {
    expect(
      mapGrokSkills([
        {
          name: 'user:help',
          description: 'Help',
          _meta: { scope: 'user', path: '/home/a/.grok/skills/help/SKILL.md', bareName: 'help' },
        },
        {
          name: 'lint-rules',
          _meta: { scope: 'project', path: 'C:\\repo\\.grok\\skills\\lint-rules\\SKILL.md' },
        },
        { name: 'compact', description: 'Not a skill' },
        { name: 'deep-research', _meta: { workflowPath: 'C:\\a\\deep-research.rhai' } },
      ]),
    ).toEqual([
      {
        id: '/home/a/.grok/skills/help/SKILL.md',
        name: 'user:help',
        displayName: 'help',
        description: 'Help',
        source: { type: 'folder', path: '/home/a/.grok/skills/help' },
        scope: 'user',
        enabled: true,
        dependencyErrors: [],
      },
      {
        id: 'C:\\repo\\.grok\\skills\\lint-rules\\SKILL.md',
        name: 'lint-rules',
        description: '',
        source: { type: 'folder', path: 'C:\\repo\\.grok\\skills\\lint-rules' },
        scope: 'project',
        enabled: true,
        dependencyErrors: [],
      },
    ])
  })
})
