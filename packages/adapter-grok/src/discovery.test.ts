import { readFileSync } from 'node:fs'
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
 * server, skill and session names and paths.
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

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Grok project discovery', () => {
  it('reports the captured commands, skills and MCP servers, then closes the session', async () => {
    const rpc = new ReplayRpc()
    const updates: Awaited<ReturnType<typeof discoverGrokProject>>[] = []
    const discovery = discoverGrokProject('C:\\repo', {
      connect: () => rpc,
      onUpdate: (inventory) => updates.push(inventory),
    })
    await vi.advanceTimersByTimeAsync(3_000)
    const inventory = await discovery

    expect(inventory.commands).toHaveLength(13)
    expect(inventory.commands.find((command) => command.name === 'goal')).toEqual({
      name: 'goal',
      description: 'Set or check an autonomous goal',
      argumentHint: '<objective> | status | clear',
    })
    expect(inventory.servers.map(({ id, startup, auth }) => ({ id, startup, auth }))).toEqual([
      {
        id: 'remote-docs',
        startup: { state: 'stopped' },
        auth: { status: 'sign_in_required', method: 'oauth' },
      },
      { id: 'design-kit', startup: { state: 'ready' }, auth: { status: 'not_required' } },
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
    const discovery = discoverGrokProject('C:\\repo', { connect: () => rpc, settleMs: 5_000 })
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

  it('does not wait for MCP when Grok has no servers to start', async () => {
    const rpc = new ReplayRpc(
      captured.filter((frame) => !('method' in frame) || !frame.method.startsWith('_x.ai/mcp')),
    )
    const discovery = discoverGrokProject('C:\\repo', { connect: () => rpc })
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
      discoverGrokProject('C:\\repo', { connect: () => signedOut }),
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
        tools: ['search', { name: 'fetch' }, 3],
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
