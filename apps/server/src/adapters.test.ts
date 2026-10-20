import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CustomHarness, StoredModelConnection } from '@harness/contracts'
import type { StartOptions } from './adapters.js'

/**
 * Listing OpenCode models spawns a real `opencode serve` process for the
 * duration of the call. These tests pin the property that made a renderer
 * refresh loop harmless again: concurrent listings share one adapter run
 * instead of forking one process each.
 */

const constructed: FakeOpenCodeAdapter[] = []
let failOpenCodeThreadStart = false
let openingFailure: 'initialize' | 'session' | undefined
let release: (() => void) | undefined
let openCodeListing: Array<Record<string, unknown>> = []
let openCodeStartFailure: Error | undefined
const turnAdapters: FakeTurnAdapter[] = []

class FakeTurnAdapter {
  readonly capabilities = {
    steer: false,
    fork: false,
    interrupt: true,
    reasoningItems: true,
    approvals: false,
    images: false,
  }
  readonly provider: 'grok' | 'antigravity' | 'claude-code' | 'cursor' | 'opencode' | 'codex' | 'pi'
  disposed = false
  approval: string | undefined
  disconnected: (() => void) | undefined
  setApproval(approval: string): void {
    this.approval = approval
  }
  onDisconnected(listener: () => void): () => void {
    this.disconnected = listener
    return () => {
      this.disconnected = undefined
    }
  }
  startOptions: Record<string, unknown> | undefined
  turnOptions: Record<string, unknown> | undefined
  launchOptions: Record<string, unknown> | undefined
  resume: { threadId: string; providerSessionId: string; workspacePath: string } | undefined
  acpResume: { threadId: string; workspacePath: string } | undefined
  #providerSessionListeners: Array<(providerSessionId: string) => void> = []

  constructor(provider: FakeTurnAdapter['provider'], options?: Record<string, unknown>) {
    this.provider = provider
    this.launchOptions = options
    turnAdapters.push(this)
  }

  on(event?: string, listener?: (providerSessionId: string) => void): this {
    if (event === 'providerSessionId' && listener) this.#providerSessionListeners.push(listener)
    return this
  }

  emit(event: string, providerSessionId: string): void {
    if (event !== 'providerSessionId') return
    for (const listener of this.#providerSessionListeners) listener(providerSessionId)
  }

  async startThread(workspacePath: string, options: Record<string, unknown>) {
    if (openingFailure === 'session') throw new Error('session failed')
    this.startOptions = options
    return {
      id: `${this.provider}-thread`,
      provider: this.provider,
      workspacePath,
      createdAt: 1,
    }
  }

  async sendTurn(
    _threadId: string,
    _text: string,
    _attachments: string[] | undefined,
    options: Record<string, unknown> | undefined,
  ) {
    this.turnOptions = options
    return `${this.provider}-turn`
  }

  async interrupt(): Promise<void> {}
  dispose(): void {
    this.disposed = true
  }
}

class FakeResumableAdapter extends FakeTurnAdapter {
  async start() {
    if (openingFailure === 'initialize') throw new Error('initialize failed')
  }

  async resumeThread(threadId: string, workspacePath: string, options: Record<string, unknown>) {
    const thread = await this.startThread(workspacePath, options)
    this.acpResume = { threadId, workspacePath }
    return { ...thread, id: threadId }
  }
}

class FakeCursorAdapter extends FakeResumableAdapter {
  constructor(options?: Record<string, unknown>) {
    super('cursor', options)
  }
}

class FakeCodexAdapter extends FakeResumableAdapter {
  constructor(options?: Record<string, unknown>) {
    super('codex', options)
  }

  async listModels() {
    return []
  }
}

class FakeGrokAdapter extends FakeTurnAdapter {
  providerSessionId: string | undefined

  constructor(options?: Record<string, unknown>) {
    super('grok', options)
  }

  override async startThread(workspacePath: string, options: Record<string, unknown>) {
    this.providerSessionId = 'grok-created-session'
    return super.startThread(workspacePath, options)
  }

  async resumeThread(
    threadId: string,
    providerSessionId: string,
    workspacePath: string,
    options: Record<string, unknown>,
  ) {
    this.providerSessionId = providerSessionId
    this.resume = { threadId, providerSessionId, workspacePath }
    this.startOptions = options
    return { id: threadId, provider: 'grok' as const, workspacePath, createdAt: 1 }
  }
}

class FakeAcpAdapter extends FakeResumableAdapter {
  constructor(
    readonly agentId: string,
    options?: Record<string, unknown>,
  ) {
    super('grok', options)
  }

  respondToApproval(): void {}
}

class FakeAntigravityAdapter extends FakeTurnAdapter {
  constructor(options?: Record<string, unknown>) {
    super('antigravity', options)
  }
}

class FakeClaudeCodeAdapter extends FakeResumableAdapter {
  readonly inventoryListeners = new Map<string, Set<() => void>>()
  readonly inventoryReads: Array<[string, string | undefined]> = []

  constructor(options?: Record<string, unknown>) {
    super('claude-code', options)
  }

  async listModels() {
    return []
  }

  override on(event?: string, listener?: (value: string) => void): this {
    if ((event === 'mcpChanged' || event === 'commandsChanged') && listener) {
      const listeners = this.inventoryListeners.get(event) ?? new Set()
      listeners.add(listener as () => void)
      this.inventoryListeners.set(event, listeners)
      return this
    }
    return super.on(event, listener)
  }

  off(event: string, listener: () => void): this {
    this.inventoryListeners.get(event)?.delete(listener)
    return this
  }

  emitInventory(event: 'mcpChanged' | 'commandsChanged'): void {
    for (const listener of this.inventoryListeners.get(event) ?? []) listener()
  }

  async listMcpServers(threadId?: string) {
    this.inventoryReads.push(['mcp', threadId])
    return []
  }

  isMcpLoading(): boolean {
    return true
  }

  async listCommands(threadId?: string) {
    this.inventoryReads.push(['commands', threadId])
    return [{ name: 'context', description: 'Show current context usage' }]
  }
}

class FakePiAdapter extends FakeTurnAdapter {
  constructor(options?: Record<string, unknown>) {
    super('pi', options)
  }

  async listModels() {
    return [{ id: 'pi-model', name: 'Pi model' }]
  }
}

class FakeOpenCodeAdapter extends FakeResumableAdapter {
  constructor(options?: Record<string, unknown>) {
    super('opencode', options)
    constructed.push(this)
  }
  override async start() {
    if (openCodeStartFailure) throw openCodeStartFailure
    await super.start()
  }
  override async startThread(workspacePath: string, options: Record<string, unknown>) {
    if (failOpenCodeThreadStart) throw new Error('openCode startThread failed')
    return super.startThread(workspacePath, options)
  }
  async listModels() {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return openCodeListing
  }
}

vi.mock('@harness/adapter-opencode', () => ({
  OpenCodeAdapter: FakeOpenCodeAdapter,
  OPENCODE_CAPABILITIES: {
    steer: false,
    fork: false,
    interrupt: true,
    reasoningItems: true,
    approvals: true,
    images: false,
  },
}))

vi.mock('@harness/adapter-grok', () => ({
  GrokAdapter: FakeGrokAdapter,
  grokCommand: () => 'grok',
  grokContextEnvironment: () => undefined,
}))
vi.mock('@harness/adapter-acp', () => ({
  AcpAdapter: FakeAcpAdapter,
  prepareAcpMcpServers: (servers: unknown[]) =>
    servers.map((server) => ({ name: (server as { id: string }).id })),
}))
vi.mock('@harness/adapter-claude-code', () => ({
  ClaudeCodeAdapter: FakeClaudeCodeAdapter,
}))
vi.mock('@harness/adapter-antigravity', () => ({
  AntigravityAdapter: FakeAntigravityAdapter,
}))
vi.mock('@harness/adapter-cursor', () => ({ CursorAdapter: FakeCursorAdapter }))
vi.mock('@harness/adapter-codex', () => ({ CodexAdapter: FakeCodexAdapter }))
vi.mock('@harness/adapter-pi', () => ({ PiAdapter: FakePiAdapter }))
const spawnedCli = vi.hoisted(() => [] as Array<{ cwd: string | undefined; env: unknown }>)
vi.mock('@harness/proc/cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc/cli')>()),
  spawnCli: (_command: string, _args: string[], options: { cwd?: string; env?: unknown }) => {
    spawnedCli.push({ cwd: options.cwd, env: options.env })
    return { pid: 1 }
  },
}))

const { apiRuntime, providerRuntime, stopModelListings } = await import('./adapters.js')

afterEach(() => {
  constructed.length = 0
  failOpenCodeThreadStart = false
  openingFailure = undefined
  turnAdapters.length = 0
  release = undefined
  openCodeListing = []
  openCodeStartFailure = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('resumable provider setup', () => {
  it.each(['grok', 'claude-code'] as const)(
    'forwards live %s approval changes',
    async (provider) => {
      const { session } = await providerRuntime(provider, () => {}).start('/repo', {
        approval: 'full',
      })
      await session.setApproval!('ask')
      expect(turnAdapters.at(-1)!.approval).toBe('ask')
      if (provider === 'claude-code') {
        const listener = vi.fn()
        const unsubscribe = session.onDisconnected!(listener)
        turnAdapters.at(-1)!.disconnected!()
        expect(listener).toHaveBeenCalledOnce()
        unsubscribe()
        expect(turnAdapters.at(-1)!.disconnected).toBeUndefined()
      }
    },
  )

  it('reports live limit windows only from a Claude session on the default account', async () => {
    const harness: CustomHarness = {
      id: 'claude-wrapper',
      displayName: 'Claude wrapper',
      provider: 'claude-code',
      command: process.execPath,
      args: [],
    }
    const runtime = providerRuntime(
      'claude-code',
      () => {},
      () => harness,
    )
    // A wrapper runs from a real project folder.
    const workspace = realpathSync(os.tmpdir())
    const own = await runtime.start(workspace, {})
    expect(own.session.onLimitsUpdated).toBeTypeOf('function')
    expect(own.session.onUsageChanged).toBeUndefined()
    // A wrapper may run another account, whose windows are not the default account's.
    const wrapped = await runtime.start(workspace, { agent: harness.id })
    expect(wrapped.session.onLimitsUpdated).toBeUndefined()
  })

  it.each(['codex', 'claude-code'] as const)(
    'starts, resumes and lists %s models as the account in its folder',
    async (provider) => {
      const home = 'D:\\accounts\\codex-work'
      const runtime = providerRuntime(
        provider,
        () => {},
        () => undefined,
        home,
      )
      await runtime.start('/repo', {})
      await runtime.resume!('existing-thread', '/repo', {})
      await runtime.listModels()
      expect(turnAdapters.map((adapter) => adapter.launchOptions?.['accountHome'])).toEqual([
        home,
        home,
        home,
      ])

      // The default account gets exactly the options it always had.
      turnAdapters.length = 0
      await providerRuntime(provider, () => {}).start('/repo', {})
      expect(turnAdapters[0]?.launchOptions).not.toHaveProperty('accountHome')
    },
  )

  it("forwards the live Claude session's MCP servers and commands", async () => {
    const { thread, session } = await providerRuntime('claude-code', () => {}).start('/repo', {})
    const adapter = turnAdapters.at(-1) as FakeClaudeCodeAdapter
    await expect(session.listMcpServers!(thread.id)).resolves.toEqual([])
    expect(session.isMcpLoading!(thread.id)).toBe(true)
    await expect(session.listCommands!(thread.id)).resolves.toEqual([
      { name: 'context', description: 'Show current context usage' },
    ])
    expect(adapter.inventoryReads).toEqual([
      ['mcp', thread.id],
      ['commands', thread.id],
    ])

    const mcp = vi.fn()
    const commands = vi.fn()
    const offMcp = session.onMcpChanged!(mcp)
    const offCommands = session.onCommandsChanged!(commands)
    adapter.emitInventory('mcpChanged')
    adapter.emitInventory('commandsChanged')
    offMcp?.()
    offCommands?.()
    adapter.emitInventory('mcpChanged')
    adapter.emitInventory('commandsChanged')
    expect([mcp.mock.calls.length, commands.mock.calls.length]).toEqual([1, 1])
  })

  it.each([false, true])(
    'passes Claude MCP options and cleans up a failed open (resume: %s)',
    async (resume) => {
      const runtime = providerRuntime('claude-code', () => {})
      const options: StartOptions = {
        model: 'opus',
        mcpServers: [{ id: 'hidden', enabled: false }],
        mcpCredentials: { 'credential-ref': 'fixture-value' },
      }
      const open = () =>
        resume
          ? runtime.resume!('claude-existing', '/repo', options)
          : runtime.start('/repo', options)
      const result = await open()
      expect(turnAdapters.at(-1)!.startOptions).toMatchObject(options)
      await result.session.dispose()
      openingFailure = 'session'
      await expect(open()).rejects.toThrow('session failed')
      expect(turnAdapters.at(-1)!.disposed).toBe(true)
    },
  )
  it.each(['cursor', 'opencode', 'codex', 'acp'] as const)(
    'preserves %s source, session identity, and option forwarding on start and resume',
    async (provider) => {
      const source: CustomHarness = {
        id: 'custom-source',
        displayName: 'Custom',
        provider,
        command: 'custom-agent',
        args: [],
      }
      const runtime = providerRuntime(
        provider,
        () => {},
        () => source,
      )
      for (const resume of [false, true]) {
        for (const populated of [false, true]) {
          const options: StartOptions = {
            agent: source.id,
            model: populated ? 'chosen-model' : '',
            effort: populated ? 'high' : '',
            serviceTier: populated ? 'fast' : '',
            approval: populated ? 'ask' : undefined,
            instructions: populated ? 'instructions' : '',
            mcpServers: [],
            mcpCredentials: {},
            ephemeral: true,
          }
          const result = resume
            ? await runtime.resume!('existing-thread', 'C:\\repo', options)
            : await runtime.start('C:\\repo', options)
          const adapter = turnAdapters.at(-1)!
          const { model, approval, instructions } = options
          const expected =
            provider === 'acp'
              ? { model, approval, instructions }
              : populated
                ? {
                    approval,
                    instructions,
                    ...(provider === 'codex' ? {} : { model, effort: 'high' }),
                    ...(provider === 'cursor' ? { serviceTier: 'fast' } : {}),
                  }
                : {}
          if (provider === 'codex' && !resume) expect(adapter.startOptions).toBe(options)
          else expect(adapter.startOptions).toStrictEqual(expected)
          expect(result.session).toBe(adapter)
          expect(adapter.acpResume).toStrictEqual(
            resume ? { threadId: 'existing-thread', workspacePath: 'C:\\repo' } : undefined,
          )
          if (resume) expect(result.thread.id).toBe('existing-thread')
          expect(adapter.launchOptions).toStrictEqual({
            spawn: expect.any(Function),
            ...(provider === 'cursor' ? { run: expect.any(Function) } : {}),
            ...(provider === 'acp' ? { name: 'Custom', command: 'custom-agent', args: [] } : {}),
            ...(provider === 'codex' || provider === 'opencode'
              ? { mcpServers: [], mcpCredentials: {} }
              : {}),
            // A wrapper may run another account, so its limit windows stay out of the default's.
            ...(provider === 'codex' ? { liveLimits: false } : {}),
          })
          if (adapter instanceof FakeAcpAdapter) expect(adapter.agentId).toBe(source.id)
        }
      }
    },
  )

  it('launches a Codex wrapper from the chat project, not the server folder', async () => {
    // Anything but the server's own folder, which the wrapper would otherwise use.
    const workspace = realpathSync(os.tmpdir())
    const runtime = providerRuntime(
      'codex',
      () => {},
      () => ({
        id: 'custom-source',
        displayName: 'Custom',
        provider: 'codex',
        command: process.execPath,
        args: [],
      }),
    )
    for (const resume of [false, true]) {
      spawnedCli.length = 0
      if (resume) await runtime.resume!('existing-thread', workspace, { agent: 'custom-source' })
      else await runtime.start(workspace, { agent: 'custom-source' })
      const spawn = turnAdapters.at(-1)!.launchOptions!.spawn as (
        command: string,
        args: string[],
        options?: object,
      ) => unknown
      spawn('codex', ['app-server'])
      expect(spawnedCli).toEqual([
        {
          cwd: workspace,
          env: expect.objectContaining({ HARNESS_WORKSPACE_PATH: workspace }),
        },
      ])
    }
  })

  it.each([
    ['codex', 'initialize', 'initialize app-server', 'initialize app-server'],
    ['codex', 'session', undefined, undefined],
    ['opencode', 'initialize', 'start its server', 'start its server'],
    ['opencode', 'session', 'create a session', 'resume its session'],
    ['acp', 'session', 'complete the ACP session handshake', 'resume the ACP session'],
  ] as const)(
    'disposes %s on %s failure and keeps phase errors',
    async (provider, stage, startPhase, resumePhase) => {
      openingFailure = stage
      const runtime = providerRuntime(
        provider,
        () => {},
        () => ({
          id: 'custom-source',
          displayName: 'Custom',
          provider,
          command: 'custom-agent',
          args: [],
        }),
      )
      for (const resume of [false, true]) {
        const opening = resume
          ? runtime.resume!('existing-thread', '/repo', { agent: 'custom-source' })
          : runtime.start('/repo', { agent: 'custom-source' })
        const phase = resume ? resumePhase : startPhase
        await expect(opening).rejects.toThrow(
          phase ? `Custom could not ${phase}: ${stage} failed` : `${stage} failed`,
        )
        expect(turnAdapters.at(-1)?.disposed).toBe(true)
      }
    },
  )

  it('disposes a custom OpenCode session when its resume deadline expires', async () => {
    vi.useFakeTimers()
    const resume = vi
      .spyOn(FakeOpenCodeAdapter.prototype, 'resumeThread')
      .mockImplementation(() => new Promise(() => {}))
    const runtime = providerRuntime(
      'opencode',
      () => {},
      () => ({
        id: 'custom-source',
        displayName: 'Custom',
        provider: 'opencode',
        command: 'custom-agent',
        args: [],
      }),
    )
    const failed = expect(
      runtime.resume!('existing-thread', '/repo', { agent: 'custom-source' }),
    ).rejects.toThrow('Custom timed out while trying to resume its session')
    await vi.waitFor(() => expect(resume).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(25_000)
    await failed
    expect(constructed.at(-1)?.disposed).toBe(true)
  })
})

describe('Pi runtime setup', () => {
  const harness: CustomHarness = {
    id: 'custom-pi',
    displayName: 'Custom Pi',
    provider: 'pi',
    command: 'my-pi',
    args: ['--profile', 'work'],
  }

  it('starts the installed Pi CLI without a custom harness', async () => {
    const runtime = providerRuntime('pi', () => {})
    const options = {
      model: 'pi-model',
      effort: 'high',
      approval: 'full' as const,
      instructions: 'Help',
    }
    const { thread, session } = await runtime.start('/repo', options)
    const adapter = turnAdapters.at(-1)!
    expect(thread.provider).toBe('pi')
    expect(session).toBe(adapter)
    expect(adapter.launchOptions).toEqual({ command: 'pi', workspacePath: '/repo' })
    expect(adapter.startOptions).toEqual(options)
    expect(adapter.disposed).toBe(false)
  })

  it('lists native Pi models and disposes its discovery session', async () => {
    const models = await providerRuntime('pi', () => {}).listModels()
    expect(models).toEqual([{ id: 'pi-model', name: 'Pi model' }])
    expect(turnAdapters.at(-1)!.launchOptions).toEqual({ command: 'pi' })
    expect(turnAdapters.at(-1)!.disposed).toBe(true)
  })

  it.each(['start', 'listModels'] as const)(
    'cleans up a failed native Pi %s',
    async (operation) => {
      const method = operation === 'start' ? 'startThread' : 'listModels'
      vi.spyOn(FakePiAdapter.prototype, method).mockRejectedValueOnce(new Error('Pi unavailable'))
      const runtime = providerRuntime('pi', () => {})
      await expect(
        operation === 'start' ? runtime.start('/repo', {}) : runtime.listModels(),
      ).rejects.toThrow('Pi unavailable')
      expect(turnAdapters.at(-1)!.disposed).toBe(true)
    },
  )

  it('keeps explicit custom Pi launches for start and model discovery', async () => {
    const runtime = providerRuntime(
      'pi',
      () => {},
      () => harness,
    )
    await runtime.start('/repo', { agent: harness.id })
    await runtime.listModels(harness.id)
    expect(turnAdapters).toHaveLength(2)
    for (const adapter of turnAdapters) {
      expect(adapter.launchOptions).toMatchObject({
        command: 'my-pi',
        args: [],
        displayName: 'Custom Pi',
        spawn: expect.any(Function),
      })
    }
    expect(turnAdapters[0]!.disposed).toBe(false)
    expect(turnAdapters[1]!.disposed).toBe(true)
  })

  it.each([undefined, { ...harness, provider: 'codex' as const }])(
    'rejects a missing or incompatible explicit Pi source instead of using the native CLI',
    async (source) => {
      const runtime = providerRuntime(
        'pi',
        () => {},
        () => source,
      )
      const expected = source ? 'configured for codex' : 'no longer exists'
      await expect(runtime.start('/repo', { agent: harness.id })).rejects.toThrow(expected)
      await expect(runtime.listModels(harness.id)).rejects.toThrow(expected)
      expect(turnAdapters).toHaveLength(0)
    },
  )

  it.each(['start', 'listModels'] as const)(
    'retains the custom Pi %s protocol deadline',
    async (operation) => {
      vi.useFakeTimers()
      const method = operation === 'start' ? 'startThread' : 'listModels'
      const pending = vi
        .spyOn(FakePiAdapter.prototype, method)
        .mockImplementation(() => new Promise(() => {}))
      const runtime = providerRuntime(
        'pi',
        () => {},
        () => harness,
      )
      const phase = operation === 'start' ? 'complete the Pi RPC handshake' : 'list Pi models'
      const failed = expect(
        operation === 'start'
          ? runtime.start('/repo', { agent: harness.id })
          : runtime.listModels(harness.id),
      ).rejects.toThrow(`Custom Pi timed out while trying to ${phase}`)
      await vi.waitFor(() => expect(pending).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(25_000)
      await failed
      expect(turnAdapters.at(-1)!.disposed).toBe(true)
    },
  )
})

describe('one-shot provider turn options', () => {
  it.each(['grok', 'antigravity', 'claude-code'] as const)(
    'forwards model and effort changes to %s on every turn',
    async (provider) => {
      const runtime = providerRuntime(provider, () => {})
      const { thread, session } = await runtime.start('C:\\repo', {
        model: 'model-a',
        effort: 'low',
      })

      await session.sendTurn(thread.id, 'Think harder', [], {
        model: 'model-b',
        effort: 'high',
      })

      expect(turnAdapters[0]?.startOptions).toMatchObject({ model: 'model-a', effort: 'low' })
      expect(turnAdapters[0]?.turnOptions).toEqual({ model: 'model-b', effort: 'high' })
    },
  )

  it('forwards ephemeral Grok background sessions to the print adapter', async () => {
    const runtime = providerRuntime('grok', () => {})
    await runtime.start('C:\\repo', { ephemeral: true })
    expect(turnAdapters[0]?.startOptions).toMatchObject({ ephemeral: true })
  })

  it('binds a named custom source to the compatible adapter launch', async () => {
    const runtime = providerRuntime(
      'grok',
      () => {},
      (id) =>
        id === 'my-grok'
          ? {
              id,
              displayName: 'My Grok',
              provider: 'grok',
              command: '/opt/my-grok',
              args: ['--profile', 'work'],
            }
          : undefined,
    )

    await runtime.start('/repo', { agent: 'my-grok' })

    expect(turnAdapters[0]?.launchOptions?.spawn).toEqual(expect.any(Function))
  })

  it('starts Grok through ACP when the project has enabled MCP servers', async () => {
    const runtime = providerRuntime('grok', () => {})

    const { thread } = await runtime.start('/repo', {
      model: 'grok-4.6',
      effort: 'xhigh',
      mcpServers: [
        {
          id: 'test-tools',
          enabled: true,
          transport: { type: 'stdio', command: 'node', args: ['test-mcp.js'] },
        },
      ],
    })

    expect(thread.provider).toBe('grok')
    expect(turnAdapters).toHaveLength(1)
    expect(turnAdapters[0]).toBeInstanceOf(FakeAcpAdapter)
    expect(turnAdapters[0]?.launchOptions).toMatchObject({
      provider: 'grok',
      settings: { model: 'grok-4.6', effort: 'xhigh' },
      mcpServers: [{ name: 'test-tools' }],
    })
    expect(
      turnAdapters[0]?.launchOptions?.argsFor?.({ model: 'grok-4.6', effort: 'xhigh' }),
    ).toEqual(['agent', '--model', 'grok-4.6', '--reasoning-effort', 'xhigh', 'stdio'])
  })

  it('resumes Grok with separate TasteCode and provider session identities', async () => {
    const runtime = providerRuntime(
      'grok',
      () => {},
      () => undefined,
    )

    const { thread: resumed, session } = await runtime.resume!(
      'grok-tastecode-thread',
      'C:\\repo',
      {
        providerSessionId: 'grok-native-session',
        model: 'grok-4.6',
      },
    )
    const learned: string[] = []
    session.onProviderSessionId?.((sessionId) => learned.push(sessionId))
    const record = turnAdapters.at(-1)!
    expect(record).toBeInstanceOf(FakeGrokAdapter)
    record.emit('providerSessionId', 'grok-native-session-rotated')

    expect(resumed.id).toBe('grok-tastecode-thread')
    expect(record.resume).toEqual({
      threadId: 'grok-tastecode-thread',
      providerSessionId: 'grok-native-session',
      workspacePath: 'C:\\repo',
    })
    expect(record.startOptions).toMatchObject({ model: 'grok-4.6' })
    expect(learned).toEqual(['grok-native-session', 'grok-native-session-rotated'])
  })

  it('reports Grok print-mode native identity as soon as the session attaches', async () => {
    const runtime = providerRuntime(
      'grok',
      () => {},
      () => undefined,
    )
    const { session } = await runtime.start('/repo', { model: 'grok-4.6' })
    const learned: string[] = []
    session.onProviderSessionId?.((sessionId) => learned.push(sessionId))
    expect(learned).toEqual(['grok-created-session'])
  })

  it('resumes an MCP-enabled Grok thread through its ACP identity', async () => {
    const runtime = providerRuntime(
      'grok',
      () => {},
      () => undefined,
    )

    const { thread: resumed } = await runtime.resume!('acp-grok-native-session', '/repo', {
      model: 'grok-4.6',
      effort: 'xhigh',
      mcpServers: [
        {
          id: 'test-tools',
          enabled: true,
          transport: { type: 'stdio', command: 'node', args: ['test-mcp.js'] },
        },
      ],
    })

    expect(resumed.id).toBe('acp-grok-native-session')
    expect(turnAdapters).toHaveLength(1)
    expect(turnAdapters[0]).toBeInstanceOf(FakeAcpAdapter)
    expect(turnAdapters[0]?.acpResume).toEqual({
      threadId: 'acp-grok-native-session',
      workspacePath: '/repo',
    })
    expect(turnAdapters[0]?.launchOptions).toMatchObject({
      provider: 'grok',
      settings: { model: 'grok-4.6', effort: 'xhigh' },
      mcpServers: [{ name: 'test-tools' }],
    })
    expect(
      turnAdapters[0]?.launchOptions?.argsFor?.({ model: 'grok-4.6', effort: 'xhigh' }),
    ).toEqual(['agent', '--model', 'grok-4.6', '--reasoning-effort', 'xhigh', 'stdio'])
  })

  it('explains how to recover when Grok never reported a native session id', async () => {
    const runtime = providerRuntime(
      'grok',
      () => {},
      () => undefined,
    )

    await expect(runtime.resume!('grok-thread', 'C:\\repo', {})).rejects.toThrow(
      'Start a new Grok chat; the local history of this chat is still available.',
    )
  })

  it('fails instead of silently falling back after a custom source is removed', async () => {
    const runtime = providerRuntime(
      'grok',
      () => {},
      () => undefined,
    )
    await expect(runtime.start('/repo', { agent: 'removed-grok' })).rejects.toThrow(
      'custom harness "removed-grok" no longer exists',
    )
  })
})

describe('openCodeRuntime', () => {
  it('disposes the adapter if session creation fails', async () => {
    failOpenCodeThreadStart = true
    const runtime = providerRuntime('opencode', () => {})

    await expect(runtime.start('/repo', {})).rejects.toThrow('openCode startThread failed')

    expect(constructed).toHaveLength(1)
    expect(constructed[0]?.disposed).toBe(true)
  })

  it('shares one adapter run between concurrent listings', async () => {
    const runtime = providerRuntime('opencode', () => {})
    const first = runtime.listModels()
    const second = runtime.listModels()
    // A second runtime instance must join the same run too — requests from
    // different clients do not know about each other.
    const third = providerRuntime('opencode', () => {}).listModels()

    await vi.waitFor(() => expect(constructed).toHaveLength(1))
    release?.()
    await Promise.all([first, second, third])
    expect(constructed[0]?.disposed).toBe(true)
  })

  it('runs again after the previous listing finished', async () => {
    const runtime = providerRuntime('opencode', () => {})
    const first = runtime.listModels()
    await vi.waitFor(() => expect(constructed).toHaveLength(1))
    release?.()
    await first

    const second = runtime.listModels()
    await vi.waitFor(() => expect(constructed).toHaveLength(2))
    release?.()
    await second
    expect(constructed[1]?.disposed).toBe(true)
  })

  it('stops a listing that is still running when the server closes', async () => {
    const listing = providerRuntime('opencode', () => {}).listModels()
    await vi.waitFor(() => expect(constructed).toHaveLength(1))
    expect(constructed[0]?.disposed).toBe(false)

    await stopModelListings()
    expect(constructed[0]?.disposed).toBe(true)

    release?.()
    await listing
    // A finished listing is not stopped again.
    constructed[0]!.disposed = false
    await stopModelListings()
    expect(constructed[0]?.disposed).toBe(false)
  })
})

describe('apiRuntime', () => {
  let dataDir: string
  const previousDataDir = process.env['HARNESS_DATA_DIR']
  beforeAll(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'tastecode-api-runtime-'))
    process.env['HARNESS_DATA_DIR'] = dataDir
  })
  afterAll(() => {
    if (previousDataDir === undefined) delete process.env['HARNESS_DATA_DIR']
    else process.env['HARNESS_DATA_DIR'] = previousDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  const connection: StoredModelConnection = {
    id: 'openai-1',
    displayName: 'OpenAI API',
    preset: 'openai',
    transport: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    enabled: true,
    credentialRef: 'model-connections/openai-1',
  }

  it("runs the chat in OpenCode on the connection's provider and key", async () => {
    const { thread } = await apiRuntime(connection, 'sk-test-secret', () => {}).start('/repo', {
      approval: 'ask',
      instructions: 'Be brief.',
    })

    expect(thread).toMatchObject({
      id: 'opencode-thread',
      provider: 'api',
      connectionId: 'openai-1',
    })
    const adapter = constructed[0]!
    expect(adapter.startOptions).toEqual({
      model: 'openai/gpt-5.6',
      approval: 'ask',
      instructions: 'Be brief.',
    })
    const launch = adapter.launchOptions as {
      config: { enabled_providers: string[]; plugin: string[] }
      environment: Record<string, string>
    }
    expect(launch.config.enabled_providers).toEqual(['openai'])
    expect(launch.config.plugin[0]).toMatch(/^file:.*opencode-api.*key-guard\.js$/)
    expect(JSON.stringify(launch.config)).not.toContain('sk-test-secret')
    expect(launch.environment).toEqual({
      TASTECODE_API_KEY: 'sk-test-secret',
      OPENCODE_AUTH_CONTENT: '{}',
      OPENCODE_DB: path.join(dataDir, 'opencode-api', 'sessions.db'),
    })
  })

  it('keeps an OpenCode model id the picker already qualified', async () => {
    await apiRuntime(connection, 'sk-test-secret', () => {}).start('/repo', {
      model: 'openai/gpt-5.6-pro',
    })
    expect(constructed[0]?.startOptions?.['model']).toBe('openai/gpt-5.6-pro')
  })

  it('resumes through OpenCode and refuses a chat of the former runtime', async () => {
    const runtime = apiRuntime(connection, 'sk-test-secret', () => {})
    const { thread } = await runtime.resume!('opencode-ses_1', '/repo', {})
    expect(thread).toMatchObject({
      id: 'opencode-ses_1',
      provider: 'api',
      connectionId: 'openai-1',
    })

    await expect(runtime.resume!('api-1234', '/repo', {})).rejects.toThrow(
      'former built-in API runtime',
    )
    expect(constructed).toHaveLength(1)
  })

  it('says OpenCode is needed when it cannot start, and disposes the adapter', async () => {
    openCodeStartFailure = new Error(
      'OpenCode is unavailable. Install it and run `opencode` once to sign in.',
    )
    await expect(
      apiRuntime(connection, 'sk-test-secret', () => {}).start('/repo', {}),
    ).rejects.toThrow('API key connections run in OpenCode, which is not available.')
    expect(constructed[0]?.disposed).toBe(true)
  })

  it("marks the connection's own model as the default in one shared listing", async () => {
    openCodeListing = [
      { id: 'openai/gpt-5.6-terra-pro', displayName: 'Terra', isDefault: true },
      { id: 'openai/gpt-5.6', displayName: 'GPT-5.6', isDefault: false },
    ]
    const runtime = apiRuntime(connection, 'sk-test-secret', () => {})
    const first = runtime.listModels()
    const second = apiRuntime(connection, 'sk-test-secret', () => {}).listModels()
    await vi.waitFor(() => expect(constructed).toHaveLength(1))
    release?.()

    const models = await first
    expect(await second).toBe(models)
    expect(models.map((model) => [model.id, model.isDefault])).toEqual([
      ['openai/gpt-5.6-terra-pro', false],
      ['openai/gpt-5.6', true],
    ])
    expect(constructed[0]?.disposed).toBe(true)
  })
})
