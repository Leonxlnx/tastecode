import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Listing OpenCode models spawns a real `opencode serve` process for the
 * duration of the call. These tests pin the property that made a renderer
 * refresh loop harmless again: concurrent listings share one adapter run
 * instead of forking one process each.
 */

const constructed: FakeOpenCodeAdapter[] = []
let release: (() => void) | undefined
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
  readonly provider: 'grok' | 'antigravity' | 'claude-code'
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
  dispose(): void {}
}

class FakeGrokAdapter extends FakeTurnAdapter {
  constructor(options?: Record<string, unknown>) {
    super('grok', options)
  }

  async resumeThread(
    threadId: string,
    providerSessionId: string,
    workspacePath: string,
    options: Record<string, unknown>,
  ) {
    this.resume = { threadId, providerSessionId, workspacePath }
    this.startOptions = options
    return { id: threadId, provider: 'grok' as const, workspacePath, createdAt: 1 }
  }
}

class FakeAcpAdapter extends FakeTurnAdapter {
  constructor(_agentId: string, options?: Record<string, unknown>) {
    super('grok', options)
  }

  setApproval(): void {}
  respondToApproval(): void {}

  async resumeThread(
    threadId: string,
    workspacePath: string,
    options: Record<string, unknown>,
  ) {
    this.acpResume = { threadId, workspacePath }
    this.startOptions = options
    return { id: threadId, provider: 'grok' as const, workspacePath, createdAt: 1 }
  }
}

class FakeAntigravityAdapter extends FakeTurnAdapter {
  constructor(options?: Record<string, unknown>) {
    super('antigravity', options)
  }
}

class FakeClaudeCodeAdapter extends FakeTurnAdapter {
  constructor(options?: Record<string, unknown>) {
    super('claude-code', options)
  }
}

class FakeOpenCodeAdapter {
  disposed = false
  constructor() {
    constructed.push(this)
  }
  async listModels() {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return []
  }
  dispose() {
    this.disposed = true
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
}))
vi.mock('@harness/adapter-acp', () => ({
  AcpAdapter: FakeAcpAdapter,
  prepareAcpMcpServers: (servers: unknown[]) =>
    servers.map((server) => ({ name: (server as { id: string }).id })),
}))
vi.mock('@harness/adapter-antigravity', () => ({
  AntigravityAdapter: FakeAntigravityAdapter,
}))
vi.mock('@harness/adapter-claude-code', () => ({
  ClaudeCodeAdapter: FakeClaudeCodeAdapter,
}))

const { providerRuntime } = await import('./adapters.js')

afterEach(() => {
  constructed.length = 0
  turnAdapters.length = 0
  release = undefined
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
      args: ['agent', '--model', 'grok-4.6', '--reasoning-effort', 'xhigh', 'stdio'],
      mcpServers: [{ name: 'test-tools' }],
    })
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
    expect(learned).toEqual(['grok-native-session-rotated'])
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
      args: ['agent', '--model', 'grok-4.6', '--reasoning-effort', 'xhigh', 'stdio'],
      mcpServers: [{ name: 'test-tools' }],
    })
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

describe('openCodeRuntime.listModels', () => {
  it('shares one adapter run between concurrent listings', async () => {
    const runtime = providerRuntime('opencode', () => {})
    const first = runtime.listModels()
    const second = runtime.listModels()
    // A second runtime instance must join the same run too — requests from
    // different clients do not know about each other.
    const third = providerRuntime('opencode', () => {}).listModels()

    expect(constructed).toHaveLength(1)
    release?.()
    await Promise.all([first, second, third])
    expect(constructed[0]?.disposed).toBe(true)
  })

  it('runs again after the previous listing finished', async () => {
    const runtime = providerRuntime('opencode', () => {})
    const first = runtime.listModels()
    release?.()
    await first

    const second = runtime.listModels()
    expect(constructed).toHaveLength(2)
    release?.()
    await second
    expect(constructed[1]?.disposed).toBe(true)
  })
})
