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

  constructor(provider: FakeTurnAdapter['provider'], options?: Record<string, unknown>) {
    this.provider = provider
    this.launchOptions = options
    turnAdapters.push(this)
  }

  on(): this {
    return this
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

vi.mock('@harness/adapter-grok', () => ({ GrokAdapter: FakeGrokAdapter }))
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
