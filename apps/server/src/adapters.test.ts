import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpAdapter } from '@harness/adapter-acp'
import { AntigravityAdapter } from '@harness/adapter-antigravity'
import { GrokAdapter } from '@harness/adapter-grok'
import { ClaudeCodeAdapter } from '@harness/adapter-claude-code'
import { OpenCodeAdapter } from '@harness/adapter-opencode'
import type { Thread } from '@harness/contracts'
import { providerRuntime, type ProviderAdapterFactories } from './adapters.js'

/**
 * Listing OpenCode models spawns a real `opencode serve` process for the
 * duration of the call. These tests pin the property that made a renderer
 * refresh loop harmless again: concurrent listings share one adapter run
 * instead of forking one process each.
 */

type RecordedLaunch = {
  hasSpawn: boolean
  args?: string[] | undefined
  provider?: string | undefined
  mcpServers?: Array<{ name: string }> | undefined
}

type RecordedAdapter = GrokAdapter | AcpAdapter | AntigravityAdapter | ClaudeCodeAdapter

type TurnAdapterRecord = {
  adapter: RecordedAdapter
  provider: 'grok' | 'antigravity' | 'claude-code'
  startOptions?: object | undefined
  resume?: { threadId: string; providerSessionId: string; workspacePath: string } | undefined
  acpResume?: { threadId: string; workspacePath: string } | undefined
  turnOptions?: object | undefined
  launchOptions: RecordedLaunch
}

const constructed: FakeOpenCodeAdapter[] = []
let release: (() => void) | undefined
const turnAdapters: TurnAdapterRecord[] = []

function thread(provider: TurnAdapterRecord['provider'], workspacePath: string): Thread {
  return { id: `${provider}-thread`, provider, workspacePath, createdAt: 1 }
}

function recordAdapter(
  adapter: RecordedAdapter,
  provider: TurnAdapterRecord['provider'],
  launchOptions: RecordedLaunch,
): TurnAdapterRecord {
  const record = { adapter, provider, launchOptions }
  turnAdapters.push(record)
  return record
}

class FakeGrokAdapter extends GrokAdapter {
  readonly record: TurnAdapterRecord

  constructor(...args: ConstructorParameters<typeof GrokAdapter>) {
    super(...args)
    this.record = recordAdapter(this, 'grok', { hasSpawn: Boolean(args[0]?.spawn) })
  }

  override async startThread(...args: Parameters<GrokAdapter['startThread']>): Promise<Thread> {
    this.record.startOptions = args[1] ?? {}
    return thread('grok', args[0])
  }

  override async resumeThread(...args: Parameters<GrokAdapter['resumeThread']>): Promise<Thread> {
    this.record.resume = {
      threadId: args[0],
      providerSessionId: args[1],
      workspacePath: args[2],
    }
    this.record.startOptions = args[3] ?? {}
    return { ...thread('grok', args[2]), id: args[0] }
  }

  override async sendTurn(...args: Parameters<GrokAdapter['sendTurn']>): Promise<string> {
    this.record.turnOptions = args[3] ?? {}
    return 'grok-turn'
  }

  override async interrupt(): Promise<void> {}
  override dispose(): void {}
}

class FakeAcpAdapter extends AcpAdapter {
  readonly record: TurnAdapterRecord

  constructor(...args: ConstructorParameters<typeof AcpAdapter>) {
    super(...args)
    const options = args[1]
    this.record = recordAdapter(this, 'grok', {
      hasSpawn: Boolean(options?.spawn),
      args: options?.args,
      provider: options?.provider,
      mcpServers: options?.mcpServers?.map(({ name }) => ({ name })),
    })
  }

  override async startThread(...args: Parameters<AcpAdapter['startThread']>): Promise<Thread> {
    this.record.startOptions = args[1] ?? {}
    return thread('grok', args[0])
  }

  override async resumeThread(...args: Parameters<AcpAdapter['resumeThread']>): Promise<Thread> {
    this.record.acpResume = { threadId: args[0], workspacePath: args[1] }
    this.record.startOptions = args[2] ?? {}
    return { ...thread('grok', args[1]), id: args[0] }
  }

  override dispose(): void {}
}

class FakeAntigravityAdapter extends AntigravityAdapter {
  readonly record: TurnAdapterRecord

  constructor(...args: ConstructorParameters<typeof AntigravityAdapter>) {
    super(...args)
    this.record = recordAdapter(this, 'antigravity', { hasSpawn: Boolean(args[0]?.spawn) })
  }

  override async startThread(
    ...args: Parameters<AntigravityAdapter['startThread']>
  ): Promise<Thread> {
    this.record.startOptions = args[1] ?? {}
    return thread('antigravity', args[0])
  }

  override async sendTurn(...args: Parameters<AntigravityAdapter['sendTurn']>): Promise<string> {
    this.record.turnOptions = args[3] ?? {}
    return 'antigravity-turn'
  }

  override async interrupt(): Promise<void> {}
  override dispose(): void {}
}

class FakeClaudeCodeAdapter extends ClaudeCodeAdapter {
  readonly record: TurnAdapterRecord

  constructor(...args: ConstructorParameters<typeof ClaudeCodeAdapter>) {
    super(...args)
    this.record = recordAdapter(this, 'claude-code', { hasSpawn: Boolean(args[0]?.spawn) })
  }

  override async startThread(
    ...args: Parameters<ClaudeCodeAdapter['startThread']>
  ): Promise<Thread> {
    this.record.startOptions = args[1] ?? {}
    return thread('claude-code', args[0])
  }

  override async sendTurn(...args: Parameters<ClaudeCodeAdapter['sendTurn']>): Promise<string> {
    this.record.turnOptions = args[3] ?? {}
    return 'claude-code-turn'
  }

  override async interrupt(): Promise<void> {}
  override dispose(): void {}
}

class FakeOpenCodeAdapter extends OpenCodeAdapter {
  disposed = false
  constructor(...args: ConstructorParameters<typeof OpenCodeAdapter>) {
    super(...args)
    constructed.push(this)
  }
  override async listModels() {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return []
  }
  override dispose() {
    this.disposed = true
  }
}

const TEST_ADAPTER_FACTORIES = {
  grok: (...args) => new FakeGrokAdapter(...args),
  acp: (...args) => new FakeAcpAdapter(...args),
  antigravity: (...args) => new FakeAntigravityAdapter(...args),
  claude: (...args) => new FakeClaudeCodeAdapter(...args),
  openCode: (...args) => new FakeOpenCodeAdapter(...args),
} satisfies ProviderAdapterFactories

afterEach(() => {
  constructed.length = 0
  turnAdapters.length = 0
  release = undefined
})

describe('one-shot provider turn options', () => {
  it.each(['grok', 'antigravity', 'claude-code'] as const)(
    'forwards model and effort changes to %s on every turn',
    async (provider) => {
      const runtime = providerRuntime(
        provider,
        () => {},
        () => undefined,
        TEST_ADAPTER_FACTORIES,
      )
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
      TEST_ADAPTER_FACTORIES,
    )

    await runtime.start('/repo', { agent: 'my-grok' })

    expect(turnAdapters[0]?.launchOptions.hasSpawn).toBe(true)
  })

  it('starts Grok through ACP when the project has enabled MCP servers', async () => {
    const runtime = providerRuntime(
      'grok',
      () => {},
      () => undefined,
      TEST_ADAPTER_FACTORIES,
    )

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
    expect(turnAdapters[0]?.adapter).toBeInstanceOf(FakeAcpAdapter)
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
      TEST_ADAPTER_FACTORIES,
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
    if (!(record.adapter instanceof GrokAdapter)) throw new Error('expected Grok adapter')
    record.adapter.emit('providerSessionId', 'grok-native-session-rotated')

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
      TEST_ADAPTER_FACTORIES,
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
    expect(turnAdapters[0]?.adapter).toBeInstanceOf(FakeAcpAdapter)
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
      TEST_ADAPTER_FACTORIES,
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
      TEST_ADAPTER_FACTORIES,
    )
    await expect(runtime.start('/repo', { agent: 'removed-grok' })).rejects.toThrow(
      'custom harness "removed-grok" no longer exists',
    )
  })
})

describe('openCodeRuntime.listModels', () => {
  it('shares one adapter run between concurrent listings', async () => {
    const runtime = providerRuntime(
      'opencode',
      () => {},
      () => undefined,
      TEST_ADAPTER_FACTORIES,
    )
    const first = runtime.listModels()
    const second = runtime.listModels()
    // A second runtime instance must join the same run too — requests from
    // different clients do not know about each other.
    const third = providerRuntime(
      'opencode',
      () => {},
      () => undefined,
      TEST_ADAPTER_FACTORIES,
    ).listModels()

    expect(constructed).toHaveLength(1)
    release?.()
    await Promise.all([first, second, third])
    expect(constructed[0]?.disposed).toBe(true)
  })

  it('runs again after the previous listing finished', async () => {
    const runtime = providerRuntime(
      'opencode',
      () => {},
      () => undefined,
      TEST_ADAPTER_FACTORIES,
    )
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
