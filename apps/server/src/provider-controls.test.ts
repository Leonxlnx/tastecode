import { EventEmitter } from 'node:events'
import {
  ProviderIdSchema,
  type McpServer,
  type Model,
  type ProviderCommand,
  type ProviderLimit,
  type Skill,
} from '@harness/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseLimitFailures,
  parseLimitSnapshot,
  serializeLimitSnapshot,
  type SavedLimitFailure,
} from './limit-snapshot.js'
import { PROVIDER_CAPABILITIES } from './provider-capabilities.js'
import {
  ProviderControls,
  type InventoryRead,
  type ProviderControlsOptions,
  type ProviderLoginResult,
  type ProviderServices,
} from './provider-controls.js'
import { usageSummaryWithLimits } from './usage-summary.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

class FakeCodex extends EventEmitter {
  start = vi.fn(async () => {})
  dispose = vi.fn(async () => {})
  account = vi.fn(async () => ({ signedIn: true }))
  listModels = vi.fn(async (): Promise<Model[]> => [])
  listMcpServers = vi.fn(async () => [])
  isMcpLoading = vi.fn(() => false)
  whenMcpServersListed = vi.fn(async () => true)
  listSkills = vi.fn(async () => ({ skills: [], errors: [] }))
  setSkillEnabled = vi.fn(async () => true)
  rateLimitSource = vi.fn(
    async (_options?: {
      background?: boolean
    }): Promise<{ status: 'ready'; limits: ProviderLimit[]; detailsOmitted?: true }> => ({
      status: 'ready',
      limits: [],
    }),
  )
  consumeRateLimitReset = vi.fn(
    async (): Promise<'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'> => 'reset',
  )
  startLogin = vi.fn(async () => ({ loginId: 'login-1', authUrl: 'https://example.test/login' }))
  cancelLogin = vi.fn(async (_loginId: string) => {})
  useApiKey = vi.fn(async (_key: string) => ({ signedIn: true }))
  signOut = vi.fn(async () => {})
  onUsageChanged(listener: () => void) {
    this.on('usageChanged', listener)
  }
}

const registries: ProviderControls[] = []
function setup(options: Partial<ProviderControlsOptions> = {}) {
  const adapters: FakeCodex[] = []
  const createCodex = vi.fn(() => {
    const adapter = new FakeCodex()
    adapters.push(adapter)
    return adapter
  })
  const hooks = {
    onLog: vi.fn(),
    onLogin: vi.fn(),
    onUsageChanged: vi.fn(),
    onLimitsChanged: vi.fn(),
    onMcpChanged: vi.fn(),
    onSkillsChanged: vi.fn(),
    onCommandsChanged: vi.fn(),
    onAuthChanged: vi.fn(),
  }
  const listModels = vi.fn(async (): Promise<Model[]> => [])
  const registry = new ProviderControls({
    createCodex,
    listModels,
    ...hooks,
    controlIdleMs: 10,
    watchTtlMs: 100,
    loginTtlMs: 200,
    // Tests of the declared read intervals pass `limitReadIntervalMs: undefined`,
    // tests of the default cache `limitCacheMs: undefined`.
    limitReadIntervalMs: 0,
    limitCacheMs: 60_000,
    ...options,
  })
  registries.push(registry)
  return {
    registry,
    codex: registry.forProvider('codex'),
    adapters,
    createCodex,
    listModels,
    hooks,
  }
}

async function flush() {
  // Advance promise continuations without advancing any lease or idle deadline.
  for (let tick = 0; tick < 30; tick += 1) await Promise.resolve()
}

function externalLogin() {
  const callbacks: Array<(result: ProviderLoginResult) => void> = []
  const cancels: Array<ReturnType<typeof vi.fn<() => Promise<void>>>> = []
  const startLogin: NonNullable<ProviderServices['startLogin']> = vi.fn((callback) => {
    callbacks.push(callback)
    const cancel = vi.fn(async () => {})
    cancels.push(cancel)
    return { loginId: `external-${callbacks.length}`, cancel }
  })
  return { startLogin, callbacks, cancels }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(async () => {
  try {
    for (const registry of registries.splice(0)) await registry.disposeAll()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

describe('declared provider controls', () => {
  it('validates Grok MCP changes against its ACP launch', () => {
    const { registry, createCodex } = setup()
    const control = registry.forProvider('grok')
    expect(control.capabilities.managedMcp).toBe(true)
    expect(() => control.validateMcpServer!({ id: 'inherited', enabled: false })).toThrow(
      'cannot be hidden through ACP',
    )
    expect(() =>
      control.validateMcpServer!({
        id: 'local',
        enabled: true,
        transport: { type: 'stdio', command: 'node', cwd: '/work/tools' },
      }),
    ).toThrow('custom working directory')
    expect(createCodex).not.toHaveBeenCalled()
  })

  it('validates Claude MCP changes without starting a control process', () => {
    const { registry, createCodex } = setup()
    const control = registry.forProvider('claude-code')
    expect(control.capabilities.managedMcp).toBe(true)
    expect(() => control.validateMcpServer!({ id: 'inherited', enabled: false })).toThrow(
      'cannot hide an inherited MCP server',
    )
    expect(() =>
      control.validateMcpServer!({
        id: 'local',
        enabled: true,
        transport: { type: 'stdio', command: 'node', cwd: 'C:\\other' },
      }),
    ).toThrow('custom working directory')
    expect(() =>
      control.validateMcpServer!({
        id: 'local',
        enabled: true,
        transport: { type: 'stdio', command: 'node', args: ['mcp.mjs'] },
      }),
    ).not.toThrow()
    expect(createCodex).not.toHaveBeenCalled()
  })

  it("answers Claude's inventory from a live chat, else from a cached project probe", async () => {
    const readOnly = {
      add: true,
      update: true,
      remove: true,
      reload: false,
      startOAuth: false,
      cancelOAuth: false,
      hideInherited: false,
    }
    const server: McpServer = {
      id: 'claude.ai Gmail',
      displayName: 'Gmail',
      scope: 'global',
      enabled: true,
      auth: { status: 'sign_in_required', method: 'oauth' },
      startup: { state: 'stopped' },
      tools: [],
      resources: [],
      resourceTemplates: [],
    }
    const commands: ProviderCommand[] = [{ name: 'context', description: 'Show context' }]
    const probe = deferred<{ commands: ProviderCommand[]; servers: McpServer[] }>()
    const discover = vi.fn(() => probe.promise)
    const { registry, hooks, createCodex } = setup({
      services: {
        'claude-code': {
          projectInventory: { mcpCapabilities: { inventory: true, ...readOnly }, discover },
        },
      },
    })
    const claude = registry.forProvider('claude-code')

    await expect(claude.listMcpServers!('/project')).resolves.toEqual({
      capabilities: { inventory: true, ...readOnly },
      servers: [],
      loading: true,
    })
    await expect(claude.listCommands!('/project')).resolves.toEqual({ commands: [], loading: true })
    await flush()
    expect(discover).toHaveBeenCalledOnce()
    expect(discover).toHaveBeenCalledWith('/project', expect.anything())
    probe.resolve({ commands, servers: [server] })
    await flush()
    expect(hooks.onMcpChanged.mock.calls).toEqual([['claude-code', '/project']])
    expect(hooks.onCommandsChanged.mock.calls).toEqual([['claude-code', '/project']])
    await expect(claude.listMcpServers!('/project')).resolves.toEqual({
      capabilities: { inventory: true, ...readOnly },
      servers: [server],
    })
    await expect(claude.listCommands!('/project')).resolves.toEqual({ commands, loading: false })

    // A live chat answers instead, and one that closes during the read leaves the cache.
    await expect(
      claude.listMcpServers!('/project', async () => ({ servers: [], loading: true })),
    ).resolves.toEqual({
      capabilities: { inventory: true, ...readOnly },
      servers: [],
      loading: true,
    })
    await expect(
      claude.listMcpServers!('/project', async () => {
        throw new Error('Claude Agent SDK session is not running')
      }),
    ).resolves.toEqual({ capabilities: { inventory: true, ...readOnly }, servers: [server] })
    expect(discover).toHaveBeenCalledOnce()
    expect(createCodex).not.toHaveBeenCalled()
  })

  it('offers Claude, Grok and OpenCode project inventories by default without starting anything', () => {
    const { registry, createCodex } = setup()
    const claude = registry.forProvider('claude-code')
    expect(claude.listMcpServers).toBeDefined()
    expect(claude.listCommands).toBeDefined()
    // Claude's skills arrive only as commands; Grok's probe also names them as skills.
    expect(claude.listSkills).toBeUndefined()
    const grok = registry.forProvider('grok')
    expect(grok.listMcpServers).toBeDefined()
    expect(grok.listCommands).toBeDefined()
    expect(grok.listSkills).toBeDefined()
    const opencode = registry.forProvider('opencode')
    expect(opencode.listMcpServers).toBeDefined()
    expect(opencode.listCommands).toBeDefined()
    expect(opencode.listSkills).toBeDefined()
    expect(registry.forProvider('cursor').listCommands).toBeUndefined()
    expect(createCodex).not.toHaveBeenCalled()
  })

  it("answers Grok's commands, skills and MCP servers from one cached project probe", async () => {
    const capabilities = {
      inventory: true,
      add: true,
      update: true,
      remove: true,
      reload: false,
      startOAuth: false,
      cancelOAuth: false,
      hideInherited: false,
    }
    const skillCapabilities = { inventory: true, configure: false, install: false }
    const skill: Skill = {
      id: '/home/dev/.grok/skills/help/SKILL.md',
      name: 'user:help',
      displayName: 'help',
      description: 'Help',
      source: { type: 'folder', path: '/home/dev/.grok/skills/help' },
      scope: 'user',
      enabled: true,
      dependencyErrors: [],
    }
    const commands: ProviderCommand[] = [
      { name: 'compact', description: 'Compact' },
      { name: 'user:help', description: 'Help', kind: 'skill' },
    ]
    const probe = deferred<{ commands: ProviderCommand[]; servers: McpServer[]; skills: Skill[] }>()
    const discover = vi.fn(() => probe.promise)
    const watchPaths = vi.fn(() => [])
    const { registry, hooks, createCodex } = setup({
      services: {
        grok: {
          projectInventory: {
            mcpCapabilities: capabilities,
            skillCapabilities,
            discover,
            watchPaths,
          },
        },
      },
    })
    const grok = registry.forProvider('grok')

    await expect(grok.listSkills!('/project')).resolves.toEqual({
      capabilities: skillCapabilities,
      skills: [],
      errors: [],
    })
    await expect(grok.listCommands!('/project')).resolves.toEqual({ commands: [], loading: true })
    await flush()
    expect(discover).toHaveBeenCalledOnce()
    probe.resolve({ commands, servers: [], skills: [skill] })
    await flush()
    expect(hooks.onSkillsChanged.mock.calls).toEqual([['grok', '/project']])
    expect(hooks.onCommandsChanged.mock.calls).toEqual([['grok', '/project']])
    await expect(grok.listSkills!('/project')).resolves.toEqual({
      capabilities: skillCapabilities,
      skills: [skill],
      errors: [],
    })
    await expect(grok.listCommands!('/project')).resolves.toEqual({ commands, loading: false })
    await expect(grok.listMcpServers!('/project')).resolves.toEqual({ capabilities, servers: [] })
    // Watching the skills alone watches the folders they come from.
    grok.watch('/project', ['skills'])
    await flush()
    expect(watchPaths.mock.calls).toEqual([['/project']])
    expect(discover).toHaveBeenCalledOnce()
    expect(createCodex).not.toHaveBeenCalled()
  })

  it("watches a project's configuration while its commands or MCP servers are watched", async () => {
    const watchPaths = vi.fn(() => [])
    const { registry, createCodex } = setup({
      services: {
        'claude-code': {
          projectInventory: {
            mcpCapabilities: {
              inventory: true,
              add: true,
              update: true,
              remove: true,
              reload: false,
              startOAuth: false,
              cancelOAuth: false,
            },
            discover: async () => ({ commands: [], servers: [] }),
            watchPaths,
          },
        },
      },
    })
    const claude = registry.forProvider('claude-code')
    expect(claude.watch('/skills-only', ['skills'])).toEqual({ expiresInMs: 100 })
    expect(claude.watch('/project', ['commands'])).toEqual({ expiresInMs: 100 })
    claude.watch('/project', ['mcp'])
    await flush()
    expect(watchPaths.mock.calls).toEqual([['/project']])
    expect(createCodex).not.toHaveBeenCalled()
  })
  it('stops a running project probe when the controls reset', async () => {
    const signals: AbortSignal[] = []
    const discover = vi.fn(
      (_projectPath: string, { signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signals.push(signal)
          signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
        }),
    )
    const { registry, hooks } = setup({
      services: {
        'claude-code': {
          projectInventory: {
            mcpCapabilities: {
              inventory: true,
              add: true,
              update: true,
              remove: true,
              reload: false,
              startOAuth: false,
              cancelOAuth: false,
            },
            discover,
          },
        },
      },
    })
    await registry.forProvider('claude-code').listCommands!('/project')
    await flush()
    await registry.disposeAll()
    expect(signals[0]!.aborted).toBe(true)
    await flush()
    expect(hooks.onCommandsChanged).not.toHaveBeenCalled()
    expect(hooks.onLog).not.toHaveBeenCalled()
  })
  it('keeps the full roster and creates no processes until a read needs one', async () => {
    const { registry, createCodex } = setup()
    expect(Object.keys(PROVIDER_CAPABILITIES).sort()).toEqual([...ProviderIdSchema.options].sort())
    expect(
      ProviderIdSchema.options.filter((provider) => PROVIDER_CAPABILITIES[provider].resume),
    ).toEqual(['codex', 'claude-code', 'grok', 'cursor', 'opencode', 'acp', 'api'])
    for (const provider of ProviderIdSchema.options) {
      const control = registry.forProvider(provider)
      const flags = control.capabilities
      expect(Boolean(control.listModels)).toBe(flags.nativeModels)
      expect(Boolean(control.listMcpServers)).toBe(flags.mcpInventory)
      expect(Boolean(control.listSkills)).toBe(flags.nativeSkills)
      // Listing skills is not configuring them: only Codex can turn one off.
      expect(Boolean(control.setSkillEnabled)).toBe(flags.nativeSkills && flags.skillsInstall)
      expect(Boolean(control.startLogin)).toBe(flags.login)
      expect(Boolean(control.cancelLogin)).toBe(flags.login)
      expect(Boolean(control.useApiKey)).toBe(flags.apiKey)
      expect(Boolean(control.consumeRateLimitReset)).toBe(flags.rateLimitReset)
    }
    registry.forProvider('api').watch('/project', ['mcp', 'skills'])
    await expect(registry.forProvider('api').account()).resolves.toEqual({ signedIn: false })
    await expect(registry.forProvider('pi').usageLimitSource()).resolves.toEqual({
      provider: 'pi',
      status: 'unavailable',
    })
    expect(createCodex).not.toHaveBeenCalled()
  })

  it('uses runtime model discovery for every non-Codex provider and custom harness', async () => {
    const { registry, codex, createCodex, listModels } = setup()
    for (const provider of ProviderIdSchema.options.filter(
      (id) => id !== 'api' && id !== 'codex',
    )) {
      await registry.forProvider(provider).listModels?.('custom-agent')
      expect(listModels).toHaveBeenCalledWith(provider, 'custom-agent', undefined)
    }
    await codex.listModels?.('custom-codex')
    expect(listModels).toHaveBeenCalledWith('codex', 'custom-codex', undefined)
    expect(createCodex).not.toHaveBeenCalled()
  })

  it('routes account, auth and usage readers lazily with provider identity', async () => {
    const account = vi.fn(async () => ({ signedIn: true, email: 'fixture@example.test' }))
    const signOut = vi.fn(async () => {})
    const usageLimitSource = vi.fn(async () => ({ status: 'ready' as const, limits: [] }))
    const { registry, hooks, createCodex } = setup({
      services: { acp: { account, signOut }, 'claude-code': { usageLimitSource } },
    })
    expect(account).not.toHaveBeenCalled()
    await expect(registry.forProvider('acp').account('agent')).resolves.toMatchObject({
      signedIn: true,
    })
    expect(account).toHaveBeenCalledWith('agent')
    await registry.forProvider('acp').signOut('agent')
    expect(signOut).toHaveBeenCalledWith('agent')
    expect(hooks.onAuthChanged).toHaveBeenCalledWith('acp')
    await expect(registry.forProvider('claude-code').usageLimitSource()).resolves.toEqual({
      provider: 'claude-code',
      status: 'ready',
      limits: [],
      checkedAt: 0,
      origin: 'read',
    })
    expect(createCodex).not.toHaveBeenCalled()
  })

  it('holds an uncached limit read until the server allows it, never a cached answer', async () => {
    let release!: () => void
    const beforeLimitRead = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const usageLimitSource = vi.fn(async () => ({ status: 'ready' as const, limits: [] }))
    const { registry } = setup({
      beforeLimitRead,
      services: { 'claude-code': { usageLimitSource } },
    })
    const claude = registry.forProvider('claude-code')
    const first = claude.usageLimitSource()
    const joined = claude.usageLimitSource()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(usageLimitSource).not.toHaveBeenCalled()

    release()
    // A read is dated when it ran, after the wait.
    const read = {
      provider: 'claude-code',
      status: 'ready',
      limits: [],
      checkedAt: 10_000,
      origin: 'read',
    }
    await expect(Promise.all([first, joined])).resolves.toEqual([read, read])
    expect(usageLimitSource).toHaveBeenCalledTimes(1)
    await claude.usageLimitSource()
    expect(beforeLimitRead).toHaveBeenCalledTimes(1)
  })

  it('reuses active MCP inventory and returns adapter capabilities without a second process', async () => {
    const { codex, createCodex } = setup()
    const readActive = vi.fn(async () => ({ servers: [], loading: true }))
    const inventory = await codex.listMcpServers?.('/project', readActive)
    expect(inventory).toEqual({
      capabilities: {
        inventory: true,
        add: true,
        update: true,
        remove: true,
        reload: true,
        startOAuth: true,
        cancelOAuth: false,
      },
      servers: [],
      loading: true,
    })
    expect(readActive).toHaveBeenCalledOnce()
    expect(createCodex).not.toHaveBeenCalled()
  })

  it('exposes service inventories for any provider and routes their later changes', async () => {
    const reads: Array<InventoryRead<unknown>> = []
    const capabilities = {
      inventory: true,
      add: true,
      update: false,
      remove: false,
      reload: false,
      startOAuth: false,
      cancelOAuth: false,
      hideInherited: false,
    }
    const services: ProviderServices = {
      listMcpServers: vi.fn(async (_projectPath: string, read: InventoryRead<unknown>) => {
        reads.push(read)
        return { capabilities, servers: [], loading: true }
      }),
      listCommands: vi.fn(async (_projectPath: string, read: InventoryRead<ProviderCommand[]>) => {
        reads.push(read)
        return { commands: (await read.readActive?.()) ?? [], loading: false }
      }),
      listSkills: vi.fn(async (_projectPath: string, read: InventoryRead<never>) => {
        reads.push(read)
        return {
          capabilities: { inventory: true, configure: false, install: false },
          skills: [],
          errors: [],
        }
      }),
    }
    const { registry, hooks, createCodex } = setup({ services: { grok: services } })
    const grok = registry.forProvider('grok')
    const live: ProviderCommand[] = [{ name: 'context', description: 'Show context' }]

    await expect(grok.listMcpServers!('/project')).resolves.toEqual({
      capabilities,
      servers: [],
      loading: true,
    })
    await expect(grok.listCommands!('/project', async () => live)).resolves.toEqual({
      commands: live,
      loading: false,
    })
    await expect(grok.listSkills!('/project')).resolves.toMatchObject({ skills: [] })
    expect(services.listMcpServers).toHaveBeenCalledWith('/project', expect.anything())
    expect(reads[0]!.readActive).toBeUndefined()

    reads[0]!.changed()
    reads[1]!.changed()
    reads[2]!.changed()
    expect(hooks.onMcpChanged.mock.calls).toEqual([['grok', '/project']])
    expect(hooks.onCommandsChanged.mock.calls).toEqual([['grok', '/project']])
    expect(hooks.onSkillsChanged.mock.calls).toEqual([['grok', '/project']])

    // A probe that lands after a reset reports nothing.
    await registry.disposeAll()
    reads[1]!.changed()
    expect(hooks.onCommandsChanged).toHaveBeenCalledOnce()
    expect(createCodex).not.toHaveBeenCalled()
  })
})

describe('shared control lifetime', () => {
  it('shares startup and keeps the process until the last reader finishes', async () => {
    const adapter = new FakeCodex()
    const start = deferred<void>()
    const account = deferred<{ signedIn: boolean }>()
    adapter.start.mockReturnValueOnce(start.promise)
    adapter.account.mockReturnValueOnce(account.promise)
    const createCodex = vi.fn(() => adapter)
    const { codex } = setup({ createCodex })
    const models = codex.listModels!()
    const readingAccount = codex.account()
    await flush()
    expect(createCodex).toHaveBeenCalledOnce()
    expect(adapter.start).toHaveBeenCalledOnce()
    start.resolve()
    await models
    await vi.advanceTimersByTimeAsync(1_000)
    expect(adapter.dispose).not.toHaveBeenCalled()
    account.resolve({ signedIn: true })
    await readingAccount
    await vi.advanceTimersByTimeAsync(10)
    expect(adapter.dispose).toHaveBeenCalledOnce()
  })

  it('reopens after idle cleanup and does not retain one-shot skills or MCP reads', async () => {
    const { codex, adapters, createCodex } = setup()
    await expect(codex.listSkills!('/project')).resolves.toEqual({
      capabilities: { inventory: true, configure: true, install: true },
      skills: [],
      errors: [],
    })
    await codex.setSkillEnabled!('/project', 'skill', false)
    expect(adapters[0]!.setSkillEnabled).toHaveBeenCalledWith('skill', false)
    await vi.advanceTimersByTimeAsync(10)
    expect(adapters[0]!.dispose).toHaveBeenCalledOnce()
    await codex.listMcpServers!('/project')
    expect(createCodex).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(adapters[1]!.dispose).toHaveBeenCalledOnce()
  })

  it('renews watch leases, routes only live project notifications, then releases the process', async () => {
    const { codex, adapters, hooks } = setup()
    codex.watch('/first', ['skills', 'mcp'])
    await codex.listModels!()
    await vi.advanceTimersByTimeAsync(50)
    codex.watch('/second', ['skills'])
    codex.watch('/first', ['mcp'])
    await vi.advanceTimersByTimeAsync(50)
    adapters[0]!.emit('skillsChanged')
    adapters[0]!.emit('mcpChanged', {})
    expect(hooks.onSkillsChanged.mock.calls).toEqual([['codex', '/second']])
    expect(hooks.onMcpChanged.mock.calls).toEqual([['codex', '/first']])
    expect(adapters[0]!.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(59)
    expect(adapters[0]!.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(adapters[0]!.dispose).toHaveBeenCalledOnce()
    adapters[0]!.emit('skillsChanged')
    expect(hooks.onSkillsChanged).toHaveBeenCalledOnce()
  })

  it('keeps the process through a slow MCP status load and tells an unleased requester once', async () => {
    const adapter = new FakeCodex()
    const listed = deferred<boolean>()
    adapter.isMcpLoading.mockReturnValue(true)
    adapter.whenMcpServersListed.mockReturnValue(listed.promise)
    const { codex, hooks } = setup({ createCodex: () => adapter })
    codex.watch('/project', ['mcp'])
    await expect(codex.listMcpServers!('/project')).resolves.toMatchObject({
      servers: [],
      loading: true,
    })
    // The lease and the idle delay both lapse long before Codex answers.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(adapter.dispose).not.toHaveBeenCalled()
    adapter.emit('mcpChanged', {})
    expect(hooks.onMcpChanged).not.toHaveBeenCalled()

    listed.resolve(true)
    await flush()
    expect(hooks.onMcpChanged.mock.calls).toEqual([['codex', '/project']])
    await vi.advanceTimersByTimeAsync(10)
    expect(adapter.dispose).toHaveBeenCalledOnce()
  })

  it('lets a leased requester hear only the adapter event and bounds a stalled load', async () => {
    const adapter = new FakeCodex()
    adapter.isMcpLoading.mockReturnValue(true)
    adapter.whenMcpServersListed.mockReturnValueOnce(Promise.resolve(true))
    adapter.whenMcpServersListed.mockReturnValueOnce(new Promise<boolean>(() => {}))
    const { codex, hooks } = setup({ createCodex: () => adapter, mcpLoadHoldMs: 500 })
    codex.watch('/project', ['mcp'])
    await codex.listMcpServers!('/project')
    adapter.emit('mcpChanged', {})
    await flush()
    expect(hooks.onMcpChanged.mock.calls).toEqual([['codex', '/project']])

    await codex.listMcpServers!('/other')
    await vi.advanceTimersByTimeAsync(499)
    expect(adapter.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(11)
    expect(adapter.dispose).toHaveBeenCalledOnce()
    expect(hooks.onMcpChanged).toHaveBeenCalledOnce()
  })

  it('releases removed projects and ignores watches from providers without notifications', async () => {
    const { registry, codex, adapters } = setup()
    registry.forProvider('api').watch('/other', ['mcp'])
    codex.watch('/project', ['skills', 'mcp'])
    await codex.listModels!()
    registry.forgetProject('/project')
    await vi.advanceTimersByTimeAsync(10)
    expect(adapters[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('waits for confirmed disposal before a concurrent read can start a replacement', async () => {
    const { codex, adapters, createCodex } = setup()
    await codex.listModels!()
    const stopped = deferred<void>()
    adapters[0]!.dispose.mockReturnValueOnce(stopped.promise)
    await vi.advanceTimersByTimeAsync(10)
    const next = codex.account()
    await flush()
    expect(createCodex).toHaveBeenCalledOnce()
    expect(adapters[0]!.account).not.toHaveBeenCalled()
    stopped.resolve()
    await next
    expect(createCodex).toHaveBeenCalledTimes(2)
  })

  it('retains failed cleanup and does not create a replacement until cleanup succeeds', async () => {
    const { codex, adapters, createCodex, hooks } = setup()
    await codex.listModels!()
    adapters[0]!.dispose.mockRejectedValue(new Error('fixture-stop-failed'))
    await vi.advanceTimersByTimeAsync(10)
    expect(hooks.onLog).toHaveBeenCalledWith('codex', expect.stringContaining('could not stop'))
    await expect(codex.account()).rejects.toThrow('fixture-stop-failed')
    expect(createCodex).toHaveBeenCalledOnce()
    adapters[0]!.dispose.mockResolvedValue()
    await codex.account()
    expect(createCodex).toHaveBeenCalledTimes(2)
  })

  it('awaits cleanup after failed startup and permits a later retry', async () => {
    const failed = new FakeCodex()
    const stopped = deferred<void>()
    failed.start.mockRejectedValue(new Error('fixture-start-failed'))
    failed.dispose.mockReturnValueOnce(stopped.promise)
    const replacement = new FakeCodex()
    const createCodex = vi.fn().mockReturnValueOnce(failed).mockReturnValue(replacement)
    const { codex } = setup({ createCodex })
    let settled = false
    const reading = codex.account().finally(() => {
      settled = true
    })
    const checked = expect(reading).rejects.toThrow('fixture-start-failed')
    await flush()
    expect(failed.dispose).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    stopped.resolve()
    await checked
    await expect(codex.account()).resolves.toEqual({ signedIn: true })
    expect(replacement.start).toHaveBeenCalledOnce()
  })

  it('retries a failed factory without disposing a nonexistent process', async () => {
    const adapter = new FakeCodex()
    const createCodex = vi
      .fn()
      .mockRejectedValueOnce(new Error('fixture-load-failed'))
      .mockResolvedValue(adapter)
    const { codex } = setup({ createCodex })
    await expect(codex.account()).rejects.toThrow('fixture-load-failed')
    await codex.account()
    expect(adapter.start).toHaveBeenCalledOnce()
  })

  it('retains ownership when both startup and cleanup fail', async () => {
    const failed = new FakeCodex()
    failed.start.mockRejectedValue(new Error('fixture-start-failed'))
    failed.dispose.mockRejectedValue(new Error('fixture-stop-failed'))
    const replacement = new FakeCodex()
    const createCodex = vi.fn().mockReturnValueOnce(failed).mockReturnValue(replacement)
    const { codex } = setup({ createCodex })
    await expect(codex.account()).rejects.toThrow('startup and cleanup failed')
    await expect(codex.account()).rejects.toThrow('fixture-stop-failed')
    expect(createCodex).toHaveBeenCalledOnce()
    failed.dispose.mockResolvedValue()
    await codex.account()
    expect(replacement.start).toHaveBeenCalledOnce()
  })
})

describe('reset and late operations', () => {
  it('disposes a late factory result without starting it, then allows fresh work', async () => {
    const loading = deferred<FakeCodex>()
    const late = new FakeCodex()
    const replacement = new FakeCodex()
    const createCodex = vi.fn().mockReturnValueOnce(loading.promise).mockReturnValue(replacement)
    const { registry, codex } = setup({ createCodex })
    const oldRead = codex.listModels!()
    const checked = expect(oldRead).rejects.toThrow('reset')
    await flush()
    const resetting = registry.disposeAll()
    loading.resolve(late)
    await resetting
    await checked
    expect(late.start).not.toHaveBeenCalled()
    expect(late.dispose).toHaveBeenCalledOnce()
    await codex.account()
    expect(replacement.start).toHaveBeenCalledOnce()
  })

  it('invalidates pending startup even if it resolves after the reset has finished', async () => {
    const starting = deferred<void>()
    const late = new FakeCodex()
    late.start.mockReturnValueOnce(starting.promise)
    const replacement = new FakeCodex()
    const { registry, codex } = setup({
      createCodex: vi.fn().mockReturnValueOnce(late).mockReturnValue(replacement),
    })
    const oldRead = codex.account()
    const checked = expect(oldRead).rejects.toThrow('reset')
    await flush()
    await registry.disposeAll()
    await codex.account()
    starting.resolve()
    await checked
    expect(late.account).not.toHaveBeenCalled()
    expect(late.dispose).toHaveBeenCalledOnce()
    expect(replacement.account).toHaveBeenCalledOnce()
  })

  it('rejects a stale result and ignores retired process notifications after reopening', async () => {
    const { registry, codex, adapters, hooks } = setup()
    await codex.listModels!()
    const old = adapters[0]!
    const account = deferred<{ signedIn: boolean }>()
    old.account.mockReturnValueOnce(account.promise)
    const oldRead = codex.account()
    const checked = expect(oldRead).rejects.toThrow('reset')
    await flush()
    await registry.disposeAll()
    await codex.account()
    old.emit('usageChanged')
    old.emit('login', { loginId: null, success: true, error: null })
    old.emit('skillsChanged')
    account.resolve({ signedIn: true })
    await checked
    expect(hooks.onUsageChanged).not.toHaveBeenCalled()
    expect(hooks.onLogin).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(adapters[1]!.dispose).toHaveBeenCalledOnce()
  })

  it('coalesces resets, awaits process exit, and retries disposal failure', async () => {
    const { registry, codex, adapters } = setup()
    await codex.account()
    const stopped = deferred<void>()
    adapters[0]!.dispose.mockReturnValueOnce(stopped.promise)
    const first = registry.disposeAll()
    expect(registry.disposeAll()).toBe(first)
    let settled = false
    void first.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    stopped.resolve()
    await first
    await codex.account()
    adapters[1]!.dispose.mockRejectedValueOnce(new Error('fixture-stop-failed'))
    await expect(registry.disposeAll()).rejects.toThrow('could not stop')
    await registry.disposeAll()
    expect(adapters[1]!.dispose).toHaveBeenCalledTimes(2)
  })

  it('invalidates slow external reads across a reset', async () => {
    const account = deferred<{ signedIn: boolean }>()
    const { registry } = setup({ services: { grok: { account: () => account.promise } } })
    const reading = registry.forProvider('grok').account()
    const checked = expect(reading).rejects.toThrow('reset')
    await registry.disposeAll()
    account.resolve({ signedIn: true })
    await checked
  })
})

describe('cached account reads', () => {
  const signedIn = { signedIn: true, email: 'person@example.test', plan: 'Pro' }

  it('shares one read between concurrent callers and reuses a sign-in for a minute', async () => {
    const answer = deferred<typeof signedIn>()
    const account = vi.fn().mockReturnValueOnce(answer.promise).mockResolvedValue(signedIn)
    const { registry } = setup({ services: { grok: { account } } })
    const grok = registry.forProvider('grok')
    const reads = Promise.all([grok.account(), grok.account()])
    await flush()
    answer.resolve(signedIn)
    await expect(reads).resolves.toEqual([signedIn, signedIn])
    await vi.advanceTimersByTimeAsync(59_999)
    await expect(grok.account()).resolves.toEqual(signedIn)
    expect(account).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await grok.account()
    expect(account).toHaveBeenCalledTimes(2)
  })

  it('reads a signed-out account again so a CLI sign-in shows at once', async () => {
    const account = vi.fn().mockResolvedValueOnce({ signedIn: false }).mockResolvedValue(signedIn)
    const { registry } = setup({ services: { 'claude-code': { account } } })
    const claude = registry.forProvider('claude-code')
    await expect(claude.account()).resolves.toEqual({ signedIn: false })
    await expect(claude.account()).resolves.toEqual(signedIn)
    expect(account).toHaveBeenCalledTimes(2)
  })

  it('keeps the last sign-in when a later read fails, for a bounded time', async () => {
    const account = vi
      .fn()
      .mockResolvedValueOnce(signedIn)
      .mockRejectedValue(new Error('CLI did not respond within the time limit'))
    const { registry, hooks } = setup({
      accountFallbackMs: 120_000,
      services: { cursor: { account } },
    })
    const cursor = registry.forProvider('cursor')
    await cursor.account()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(cursor.account()).resolves.toEqual(signedIn)
    expect(hooks.onLog).toHaveBeenCalledWith(
      'cursor',
      expect.stringContaining('using the last known sign-in'),
    )
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(cursor.account()).rejects.toThrow('did not respond')
    expect(account).toHaveBeenCalledTimes(3)
  })

  it('rejects a failed read when no sign-in was ever confirmed', async () => {
    const account = vi
      .fn()
      .mockResolvedValueOnce({ signedIn: false })
      .mockRejectedValue(new Error('fixture-account-failed'))
    const { registry } = setup({ services: { grok: { account } } })
    const grok = registry.forProvider('grok')
    await expect(grok.account()).resolves.toEqual({ signedIn: false })
    await expect(grok.account()).rejects.toThrow('fixture-account-failed')
    await expect(grok.account()).rejects.toThrow('fixture-account-failed')
    expect(account).toHaveBeenCalledTimes(3)
  })

  it('forgets the account on sign-out, and a read from before it cannot answer later', async () => {
    const stale = deferred<typeof signedIn>()
    const account = vi
      .fn()
      .mockResolvedValueOnce(signedIn)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ signedIn: false })
    const signOut = vi.fn(async () => {})
    const { registry } = setup({ accountCacheMs: 0, services: { grok: { account, signOut } } })
    const grok = registry.forProvider('grok')
    await grok.account()
    const before = grok.account()
    await flush()
    await grok.signOut()
    // A new caller does not join the read that began before the sign-out.
    await expect(grok.account()).resolves.toEqual({ signedIn: false })
    stale.resolve(signedIn)
    await expect(before).resolves.toEqual(signedIn)
    account.mockRejectedValue(new Error('fixture-account-failed'))
    // Neither the old sign-in nor the stale read survives as a fallback.
    await expect(grok.account()).rejects.toThrow('fixture-account-failed')
  })

  it('forgets the account after a sign-in completes and after a reset', async () => {
    const { startLogin, callbacks } = externalLogin()
    const account = vi.fn(async () => signedIn)
    const { registry } = setup({ services: { 'claude-code': { account, startLogin } } })
    let claude = registry.forProvider('claude-code')
    await claude.account()
    await claude.startLogin!()
    callbacks[0]!({ loginId: 'external-1', success: true, error: null })
    await flush()
    await claude.account()
    expect(account).toHaveBeenCalledTimes(2)
    await registry.disposeAll()
    claude = registry.forProvider('claude-code')
    await claude.account()
    expect(account).toHaveBeenCalledTimes(3)
  })

  it('caches each agent separately and the Codex control process read too', async () => {
    const account = vi.fn(async (agent?: string) => ({ signedIn: true, email: `${agent}@x.test` }))
    const { registry, codex, adapters } = setup({ services: { acp: { account } } })
    const acp = registry.forProvider('acp')
    await acp.account('gemini')
    await acp.account('kimi')
    await acp.account('gemini')
    expect(account.mock.calls).toEqual([['gemini'], ['kimi']])
    await Promise.all([codex.account(), codex.account()])
    await codex.account()
    expect(adapters[0]!.account).toHaveBeenCalledOnce()
  })
})

describe('fresh usage controls', () => {
  it.each(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'] as const)(
    'preserves the %s outcome and the supplied idempotency key, then closes its process',
    async (outcome) => {
      const adapter = new FakeCodex()
      adapter.consumeRateLimitReset.mockResolvedValue(outcome)
      const { codex, hooks } = setup({ createCodex: () => adapter })
      await expect(codex.consumeRateLimitReset!('fixture-idempotency-key')).resolves.toEqual({
        outcome,
      })
      expect(adapter.consumeRateLimitReset).toHaveBeenCalledExactlyOnceWith(
        'fixture-idempotency-key',
        undefined,
      )
      expect(adapter.dispose).toHaveBeenCalledOnce()
      expect(hooks.onUsageChanged).toHaveBeenCalledExactlyOnceWith('codex')
    },
  )

  it('uses a separate fresh usage process while a watch holds the shared control', async () => {
    const { codex, adapters } = setup()
    codex.watch('/project', ['mcp'])
    await codex.listModels!()
    await expect(codex.usageLimitSource()).resolves.toEqual({
      provider: 'codex',
      status: 'ready',
      limits: [],
      checkedAt: 0,
      origin: 'read',
    })
    expect(adapters).toHaveLength(2)
    expect(adapters[0]!.dispose).not.toHaveBeenCalled()
    expect(adapters[1]!.dispose).toHaveBeenCalledOnce()
  })

  it('waits for fresh-process cleanup after a failed query', async () => {
    const adapter = new FakeCodex()
    const stopped = deferred<void>()
    adapter.rateLimitSource.mockRejectedValueOnce(new Error('fixture-usage-failed'))
    adapter.dispose.mockReturnValueOnce(stopped.promise)
    const { codex } = setup({ createCodex: () => adapter })
    let settled = false
    const query = codex.usageLimitSource().finally(() => {
      settled = true
    })
    const checked = expect(query).rejects.toThrow('fixture-usage-failed')
    await flush()
    expect(settled).toBe(false)
    expect(adapter.dispose).toHaveBeenCalledOnce()
    stopped.resolve()
    await checked
  })

  it('does not accumulate fresh processes when a previous query process cannot stop', async () => {
    const failed = new FakeCodex()
    failed.dispose.mockRejectedValue(new Error('fixture-stop-failed'))
    const replacement = new FakeCodex()
    const createCodex = vi.fn().mockReturnValueOnce(failed).mockReturnValue(replacement)
    const { codex } = setup({ createCodex })
    await expect(codex.usageLimitSource()).rejects.toThrow('fixture-stop-failed')
    await expect(codex.account()).rejects.toThrow('fixture-stop-failed')
    await expect(codex.usageLimitSource()).rejects.toThrow('fixture-stop-failed')
    expect(createCodex).toHaveBeenCalledOnce()
    failed.dispose.mockResolvedValue()
    // The failed limit read waits out its retry time before the next attempt.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await codex.usageLimitSource()
    expect(replacement.start).toHaveBeenCalledOnce()
    expect(replacement.dispose).toHaveBeenCalledOnce()
  })

  it('does not publish a late usage-reset result after controls were reset', async () => {
    const result = deferred<'reset'>()
    const adapter = new FakeCodex()
    adapter.consumeRateLimitReset.mockReturnValueOnce(result.promise)
    const { registry, codex, hooks } = setup({ createCodex: () => adapter })
    const consuming = codex.consumeRateLimitReset!('fixture-idempotency-key')
    const checked = expect(consuming).rejects.toThrow('reset')
    await flush()
    await registry.disposeAll()
    result.resolve('reset')
    await checked
    expect(hooks.onUsageChanged).not.toHaveBeenCalled()
    expect(adapter.dispose).toHaveBeenCalledOnce()
  })
})

describe('cached usage limits', () => {
  it('answers repeated and concurrent reads from one fresh process until the cache expires', async () => {
    const { codex, createCodex } = setup({ limitCacheMs: 1_000 })
    await Promise.all([codex.usageLimitSource(), codex.usageLimitSource()])
    await codex.usageLimitSource()
    expect(createCodex).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    await codex.usageLimitSource()
    expect(createCodex).toHaveBeenCalledTimes(2)
  })

  it('keeps a read in flight through a change signal, then rereads once', async () => {
    const limits = deferred<{ status: 'ready'; limits: ProviderLimit[] }>()
    const first = new FakeCodex()
    first.rateLimitSource.mockReturnValueOnce(limits.promise)
    const second = new FakeCodex()
    second.rateLimitSource.mockResolvedValue({
      status: 'ready',
      limits: [{ label: 'Weekly', usedPercent: 40 }],
    })
    const createCodex = vi.fn().mockReturnValueOnce(first).mockReturnValue(second)
    const { registry, codex } = setup({ createCodex })
    const stale = codex.usageLimitSource()
    await flush()
    registry.usageChanged('codex')
    // A caller after the change joins the read instead of starting a second process.
    const joined = codex.usageLimitSource()
    expect(createCodex).toHaveBeenCalledOnce()
    limits.resolve({ status: 'ready', limits: [{ label: 'Weekly', usedPercent: 10 }] })
    await expect(stale).resolves.toMatchObject({ limits: [{ usedPercent: 10 }] })
    await expect(joined).resolves.toMatchObject({ limits: [{ usedPercent: 10 }] })
    await expect(codex.usageLimitSource()).resolves.toMatchObject({
      limits: [{ usedPercent: 40 }],
    })
    await codex.usageLimitSource()
    expect(createCodex).toHaveBeenCalledTimes(2)
  })

  it('rereads after sign-out', async () => {
    const usageLimitSource = vi.fn(async () => ({ status: 'ready' as const, limits: [] }))
    const signOut = vi.fn(async () => {})
    const { registry, hooks } = setup({
      services: { grok: { account: async () => ({ signedIn: true }), usageLimitSource, signOut } },
    })
    const grok = registry.forProvider('grok')
    await grok.usageLimitSource()
    await grok.signOut()
    await grok.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
    expect(signOut).toHaveBeenCalledOnce()
    expect(hooks.onAuthChanged).toHaveBeenCalledWith('grok')
  })

  it('rereads when an account read reports another account', async () => {
    const usageLimitSource = vi.fn(async () => ({ status: 'ready' as const, limits: [] }))
    const account = vi
      .fn()
      .mockResolvedValueOnce({ signedIn: true, email: 'first@example.test', plan: 'pro' })
      .mockResolvedValueOnce({ signedIn: true, email: 'first@example.test', plan: 'pro' })
      .mockResolvedValue({ signedIn: true, email: 'second@example.test', plan: 'pro' })
    const { registry } = setup({
      accountCacheMs: 0,
      services: { grok: { account, usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    await grok.account()
    await grok.usageLimitSource()
    // The same account again changes nothing.
    await grok.account()
    await grok.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledOnce()
    // Switched in the provider's own CLI.
    await grok.account()
    await grok.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
  })

  it('keeps an unavailable answer through usage changes until its longer cache expires', async () => {
    const usageLimitSource = vi.fn(async () => ({ status: 'unavailable' as const }))
    const { registry, hooks } = setup({
      limitCacheMs: 1_000,
      unavailableLimitCacheMs: 10_000,
      services: { 'claude-code': { usageLimitSource } },
    })
    const claude = registry.forProvider('claude-code')
    await expect(claude.usageLimitSource()).resolves.toEqual({
      provider: 'claude-code',
      status: 'unavailable',
    })
    registry.usageChanged('claude-code')
    registry.usageChanged('claude-code', true)
    await vi.advanceTimersByTimeAsync(9_999)
    await expect(claude.usageLimitSource()).resolves.toMatchObject({ status: 'unavailable' })
    expect(usageLimitSource).toHaveBeenCalledOnce()
    // The signal still reaches clients: their session totals changed.
    expect(hooks.onUsageChanged).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await claude.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
  })

  it('caches an unavailable answer that a usage change interrupted', async () => {
    const answer = deferred<{ status: 'unavailable' }>()
    const usageLimitSource = vi
      .fn()
      .mockReturnValueOnce(answer.promise)
      .mockResolvedValue({ status: 'ready', limits: [] })
    const { registry } = setup({ services: { 'claude-code': { usageLimitSource } } })
    const claude = registry.forProvider('claude-code')
    const reading = claude.usageLimitSource()
    await flush()
    registry.usageChanged('claude-code')
    answer.resolve({ status: 'unavailable' })
    await expect(reading).resolves.toMatchObject({ status: 'unavailable' })
    await expect(claude.usageLimitSource()).resolves.toMatchObject({ status: 'unavailable' })
    expect(usageLimitSource).toHaveBeenCalledOnce()
  })

  it('lets an interrupted unavailable answer replace nothing newer', async () => {
    const stale = deferred<{ status: 'unavailable' }>()
    const usageLimitSource = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ status: 'ready', limits: [{ label: 'Weekly', usedPercent: 40 }] })
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    const first = grok.usageLimitSource()
    await flush()
    // Only a forced change starts a read beside the one in flight.
    registry.usageChanged('grok', true)
    await expect(grok.usageLimitSource()).resolves.toMatchObject({ status: 'ready' })
    stale.resolve({ status: 'unavailable' })
    await first
    await expect(grok.usageLimitSource()).resolves.toMatchObject({ status: 'ready' })
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
  })

  it('discards an unavailable answer on sign-in, sign-out and reset', async () => {
    const { startLogin, callbacks } = externalLogin()
    const usageLimitSource = vi.fn(async () => ({ status: 'unavailable' as const }))
    const signOut = vi.fn(async () => {})
    const { registry } = setup({
      services: { 'claude-code': { usageLimitSource, startLogin, signOut } },
    })
    let claude = registry.forProvider('claude-code')
    await claude.usageLimitSource()
    await claude.signOut()
    await claude.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledTimes(2)

    await claude.startLogin!()
    callbacks[0]!({ loginId: 'external-1', success: true, error: null })
    await flush()
    await claude.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledTimes(3)

    await registry.disposeAll()
    claude = registry.forProvider('claude-code')
    await claude.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledTimes(4)
  })

  it('discards an unavailable answer when an account read reports a sign-in', async () => {
    const usageLimitSource = vi.fn(async () => ({ status: 'unavailable' as const }))
    const account = vi
      .fn()
      .mockResolvedValueOnce({ signedIn: false })
      .mockResolvedValue({ signedIn: true, email: 'person@example.test' })
    const { registry } = setup({ services: { grok: { account, usageLimitSource } } })
    const grok = registry.forProvider('grok')
    await grok.account()
    await grok.usageLimitSource()
    registry.usageChanged('grok')
    await grok.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledOnce()
    // Signed in through the provider's own CLI.
    await grok.account()
    await grok.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
  })

  it('forwards the first change at once and collapses a burst into one trailing signal', async () => {
    const { registry, hooks } = setup({ limitChangeIntervalMs: 1_000 })
    registry.usageChanged('codex')
    expect(hooks.onUsageChanged).toHaveBeenCalledExactlyOnceWith('codex')
    registry.usageChanged('codex')
    registry.usageChanged('codex')
    registry.usageChanged('claude-code')
    expect(hooks.onUsageChanged).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(hooks.onUsageChanged).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(hooks.onUsageChanged).toHaveBeenCalledTimes(3)
    expect(hooks.onUsageChanged).toHaveBeenLastCalledWith('codex')
  })

  it('forwards a redeemed reset at once and drops a pending trailing signal on reset', async () => {
    const { registry, codex, hooks } = setup({ limitChangeIntervalMs: 1_000 })
    registry.usageChanged('codex')
    registry.usageChanged('codex')
    await codex.consumeRateLimitReset!('fixture-idempotency-key')
    expect(hooks.onUsageChanged).toHaveBeenCalledTimes(2)
    registry.usageChanged('codex')
    await registry.disposeAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hooks.onUsageChanged).toHaveBeenCalledTimes(2)
  })
})

describe('limit read backoff and intervals', () => {
  type ReadyLimits = { status: 'ready'; limits: ProviderLimit[] }
  const timeout = () => Object.assign(new Error('fixture-timed-out'), { name: 'TimeoutError' })
  const failing = (error: () => Error = () => new Error('fixture-limits-failed')) =>
    vi.fn(async (): Promise<ReadyLimits> => {
      throw error()
    })

  it('stops reading after the declared number of timeouts until the account changes', async () => {
    expect(PROVIDER_CAPABILITIES['claude-code'].limitReadTimeoutLimit).toBe(2)
    const usageLimitSource = failing(timeout)
    const signOut = vi.fn(async () => {})
    const { registry } = setup({ services: { 'claude-code': { usageLimitSource, signOut } } })
    const claude = registry.forProvider('claude-code')
    const attempt = () => expect(claude.usageLimitSource()).rejects.toThrow('fixture-timed-out')
    await attempt()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await attempt()
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    registry.usageChanged('claude-code', true)
    await attempt()
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
    await claude.signOut()
    await attempt()
    expect(usageLimitSource).toHaveBeenCalledTimes(3)
  })

  it('counts only timeouts toward the limit, and a success starts the count again', async () => {
    const usageLimitSource = vi
      .fn()
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(new Error('fixture-limits-failed'))
      .mockResolvedValueOnce({ status: 'ready', limits: [] })
      .mockRejectedValueOnce(timeout())
      .mockResolvedValue({ status: 'ready', limits: [] })
    const { registry } = setup({ services: { 'claude-code': { usageLimitSource } } })
    const claude = registry.forProvider('claude-code')
    await expect(claude.usageLimitSource()).rejects.toThrow('fixture-timed-out')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await expect(claude.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await expect(claude.usageLimitSource()).resolves.toMatchObject({ status: 'ready' })
    registry.usageChanged('claude-code')
    await expect(claude.usageLimitSource()).resolves.toMatchObject({
      stale: true,
      refreshError: 'fixture-timed-out',
    })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const recovered = await claude.usageLimitSource()
    expect(recovered).toMatchObject({ status: 'ready' })
    expect(recovered).not.toHaveProperty('stale')
    expect(usageLimitSource).toHaveBeenCalledTimes(5)
  })

  it('keeps retrying timeouts with backoff where no timeout limit is declared', async () => {
    expect(PROVIDER_CAPABILITIES.grok).not.toHaveProperty('limitReadTimeoutLimit')
    const usageLimitSource = failing(timeout)
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    await expect(grok.usageLimitSource()).rejects.toThrow('fixture-timed-out')
    for (const minutes of [5, 10, 20]) {
      await vi.advanceTimersByTimeAsync(minutes * 60_000)
      await expect(grok.usageLimitSource()).rejects.toThrow('fixture-timed-out')
    }
    expect(usageLimitSource).toHaveBeenCalledTimes(4)
  })

  it('answers a failed read with its error until a retry time that doubles to 30 minutes', async () => {
    const usageLimitSource = failing()
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    const attempt = () => expect(grok.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
    await attempt()
    await attempt()
    // Spending usage during a turn does not repair a failing source.
    registry.usageChanged('grok')
    registry.usageChanged('grok', true)
    await attempt()
    expect(usageLimitSource).toHaveBeenCalledOnce()
    for (const [index, minutes] of [5, 10, 20, 30, 30].entries()) {
      await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1)
      await attempt()
      expect(usageLimitSource).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      await attempt()
      expect(usageLimitSource).toHaveBeenCalledTimes(index + 2)
    }
  })

  it('forgets earlier failures after a successful read', async () => {
    const usageLimitSource = vi
      .fn()
      .mockRejectedValueOnce(new Error('fixture-limits-failed'))
      .mockRejectedValueOnce(new Error('fixture-limits-failed'))
      .mockResolvedValueOnce({ status: 'ready', limits: [] })
      .mockRejectedValueOnce(new Error('fixture-limits-failed'))
      .mockResolvedValue({ status: 'ready', limits: [] })
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    await expect(grok.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await expect(grok.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await expect(grok.usageLimitSource()).resolves.toMatchObject({ status: 'ready' })
    registry.usageChanged('grok')
    // The next wait starts at 5 minutes again, not 20.
    await expect(grok.usageLimitSource()).resolves.toMatchObject({
      stale: true,
      retryAt: 15 * 60_000 + 5 * 60_000,
    })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await expect(grok.usageLimitSource()).resolves.not.toHaveProperty('stale')
    expect(usageLimitSource).toHaveBeenCalledTimes(5)
  })

  it('retries at once when an account read reports another account or after sign-out', async () => {
    const usageLimitSource = failing()
    const account = vi
      .fn()
      .mockResolvedValueOnce({ signedIn: true, email: 'first@example.test' })
      .mockResolvedValue({ signedIn: true, email: 'second@example.test' })
    const { registry } = setup({
      // Every account read reaches the CLI, so the switch below is seen at once.
      accountCacheMs: 0,
      services: { grok: { account, usageLimitSource, signOut: async () => {} } },
    })
    const grok = registry.forProvider('grok')
    await grok.account()
    await expect(grok.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
    // Switched in the provider's own CLI.
    await grok.account()
    await expect(grok.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
    await grok.signOut()
    await expect(grok.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
    expect(usageLimitSource).toHaveBeenCalledTimes(3)
  })

  it('reads Claude limits at most every 15 minutes, through usage changes', async () => {
    expect(PROVIDER_CAPABILITIES['claude-code'].limitReadIntervalMs).toBe(15 * 60_000)
    const usageLimitSource = vi.fn(async (): Promise<ReadyLimits> => ({
      status: 'ready',
      limits: [],
    }))
    const { registry } = setup({
      limitReadIntervalMs: undefined,
      services: { 'claude-code': { usageLimitSource } },
    })
    const claude = registry.forProvider('claude-code')
    await claude.usageLimitSource()
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1)
    registry.usageChanged('claude-code')
    await claude.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await claude.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
  })

  it('spaces Codex reads by 5 minutes, and a redeemed reset reaches the next read', async () => {
    expect(PROVIDER_CAPABILITIES.codex.limitReadIntervalMs).toBe(5 * 60_000)
    expect(PROVIDER_CAPABILITIES.grok.limitReadIntervalMs).toBe(5 * 60_000)
    const { registry, codex, createCodex } = setup({
      limitReadIntervalMs: undefined,
      limitCacheMs: undefined,
    })
    await codex.usageLimitSource()
    // Live windows and usage changes during turns are no reason for another process.
    for (let minute = 1; minute < 5; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      registry.usageChanged('codex')
      await codex.usageLimitSource()
    }
    expect(createCodex).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    await codex.usageLimitSource()
    expect(createCodex).toHaveBeenCalledTimes(2)
    // The reset runs in its own process; the read after it does not wait.
    await codex.consumeRateLimitReset!('fixture-idempotency-key')
    await codex.usageLimitSource()
    expect(createCodex).toHaveBeenCalledTimes(4)
  })

  it('stamps a read with the time its values arrived and marks them as read', async () => {
    const limits = deferred<ReadyLimits>()
    const usageLimitSource = vi.fn().mockReturnValueOnce(limits.promise)
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    const reading = registry.forProvider('grok').usageLimitSource()
    await vi.advanceTimersByTimeAsync(4_000)
    limits.resolve({ status: 'ready', limits: [{ label: 'Weekly', usedPercent: 10 }] })
    await expect(reading).resolves.toEqual({
      provider: 'grok',
      status: 'ready',
      limits: [{ label: 'Weekly', usedPercent: 10 }],
      checkedAt: 4_000,
      origin: 'read',
    })
  })

  it('stores a read that a usage change interrupted until the interval has passed', async () => {
    const limits = deferred<ReadyLimits>()
    const usageLimitSource = vi
      .fn()
      .mockReturnValueOnce(limits.promise)
      .mockResolvedValue({ status: 'ready', limits: [{ label: 'Weekly', usedPercent: 40 }] })
    const { registry } = setup({
      limitReadIntervalMs: 30_000,
      services: { grok: { usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    const reading = grok.usageLimitSource()
    await vi.advanceTimersByTimeAsync(5_000)
    registry.usageChanged('grok')
    limits.resolve({ status: 'ready', limits: [{ label: 'Weekly', usedPercent: 10 }] })
    await reading
    await vi.advanceTimersByTimeAsync(24_999)
    await expect(grok.usageLimitSource()).resolves.toMatchObject({
      limits: [{ usedPercent: 10 }],
    })
    await vi.advanceTimersByTimeAsync(1)
    await expect(grok.usageLimitSource()).resolves.toMatchObject({
      limits: [{ usedPercent: 40 }],
    })
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
  })
})

describe('read intent', () => {
  const weekly = (usedPercent: number) => ({
    status: 'ready' as const,
    limits: [{ id: 'seven_day', label: 'Weekly', usedPercent }],
  })
  const notReadYet = {
    provider: 'claude-code',
    status: 'unavailable',
    reason: 'failed',
    error: 'Plan limits are read when you open them.',
  }

  it('reads Claude limits only while they are shown, at most every 15 minutes', async () => {
    expect(PROVIDER_CAPABILITIES['claude-code'].limitReadsWhenShown).toBe(true)
    const usageLimitSource = vi.fn(async () => weekly(10))
    const { registry } = setup({
      limitReadIntervalMs: undefined,
      services: { 'claude-code': { usageLimitSource } },
    })
    const claude = registry.forProvider('claude-code')
    // A passive figure starts no read; nothing known is not "no plan limits".
    await expect(claude.usageLimitSource('background')).resolves.toEqual(notReadYet)
    expect(claude.heldLimitSource()).toBeUndefined()
    expect(usageLimitSource).not.toHaveBeenCalled()
    await expect(claude.usageLimitSource('visible')).resolves.toMatchObject({ origin: 'read' })
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    // Older than the interval, but nobody is looking.
    await expect(claude.usageLimitSource('background')).resolves.toMatchObject({
      limits: [{ usedPercent: 10 }],
    })
    expect(usageLimitSource).toHaveBeenCalledOnce()
    await claude.usageLimitSource('visible')
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
    // Without an intent a request counts as shown, as for older clients.
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await claude.usageLimitSource()
    expect(usageLimitSource).toHaveBeenCalledTimes(3)
  })

  it('shows live Claude windows to a passive figure without a read', async () => {
    const session = { id: 'five_hour', label: 'Session', usedPercent: 76, windowMinutes: 300 }
    const usageLimitSource = vi.fn(async () => ({
      status: 'ready' as const,
      limits: [{ ...session, usedPercent: 80 }, ...weekly(10).limits],
    }))
    const { registry } = setup({ services: { 'claude-code': { usageLimitSource } } })
    const claude = registry.forProvider('claude-code')
    registry.applyLimitRows('claude-code', [session])
    await expect(claude.usageLimitSource('background')).resolves.toMatchObject({
      origin: 'live',
      limits: [session],
    })
    expect(usageLimitSource).not.toHaveBeenCalled()
    // Once shown, a full read answers with every window, including the weekly ones.
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(claude.usageLimitSource('visible')).resolves.toMatchObject({
      origin: 'read',
      limits: [
        { id: 'five_hour', usedPercent: 80 },
        { id: 'seven_day', usedPercent: 10 },
      ],
    })
  })

  it('gives a passive figure the reason of a failed Claude read without reading again', async () => {
    const usageLimitSource = vi.fn(async (): Promise<ReturnType<typeof weekly>> => {
      throw Object.assign(new Error('fixture-timed-out'), { name: 'TimeoutError' })
    })
    const { registry } = setup({ services: { 'claude-code': { usageLimitSource } } })
    const claude = registry.forProvider('claude-code')
    await expect(claude.usageLimitSource('visible')).rejects.toThrow('fixture-timed-out')
    await expect(claude.usageLimitSource('background')).resolves.toEqual({
      ...notReadYet,
      error: 'fixture-timed-out',
    })
    expect(usageLimitSource).toHaveBeenCalledOnce()
  })

  it('reads at once for a retry, inside the backoff and after the timeout limit', async () => {
    const timeout = () => Object.assign(new Error('fixture-timed-out'), { name: 'TimeoutError' })
    const usageLimitSource = vi
      .fn()
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(timeout())
      .mockResolvedValue(weekly(30))
    const { registry } = setup({ services: { 'claude-code': { usageLimitSource } } })
    const claude = registry.forProvider('claude-code')
    await expect(claude.usageLimitSource('visible')).rejects.toThrow('fixture-timed-out')
    // Inside the 5-minute backoff only a retry reads.
    await expect(claude.usageLimitSource('visible')).rejects.toThrow('fixture-timed-out')
    expect(usageLimitSource).toHaveBeenCalledOnce()
    await expect(claude.usageLimitSource('retry')).rejects.toThrow('fixture-timed-out')
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
    // Two timeouts stop automatic reads for this account; a retry still tries once more.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    await expect(claude.usageLimitSource('visible')).rejects.toThrow('fixture-timed-out')
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
    await expect(claude.usageLimitSource('retry')).rejects.toThrow('fixture-timed-out')
    await expect(claude.usageLimitSource('retry')).resolves.toMatchObject({
      limits: [{ usedPercent: 30 }],
    })
    expect(usageLimitSource).toHaveBeenCalledTimes(4)
  })

  it('reads Codex without reset details for a passive figure, in full once they are shown', async () => {
    const resets = { id: 'resets', label: 'Rate limit resets', usedPercent: 0, valueLabel: '2' }
    const adapter = new FakeCodex()
    adapter.rateLimitSource.mockImplementation(async (options?: { background?: boolean }) =>
      options?.background
        ? { status: 'ready', limits: [resets], detailsOmitted: true }
        : { status: 'ready', limits: [{ ...resets, resetCredits: [{ expiresAt: null }] }] },
    )
    const createCodex = vi.fn(() => adapter)
    const { codex } = setup({ createCodex })
    const passive = await codex.usageLimitSource('background')
    expect(passive).toMatchObject({ limits: [resets] })
    expect(passive).not.toHaveProperty('detailsOmitted')
    await codex.usageLimitSource('background')
    expect(adapter.rateLimitSource.mock.calls).toEqual([[{ background: true }]])
    // A shown view lists the expiries the background read left out.
    await expect(codex.usageLimitSource('visible')).resolves.toMatchObject({
      limits: [{ resetCredits: [{ expiresAt: null }] }],
    })
    await codex.usageLimitSource('visible')
    expect(adapter.rateLimitSource.mock.calls).toEqual([
      [{ background: true }],
      [{ background: false }],
    ])
    expect(createCodex).toHaveBeenCalledTimes(2)
  })

  it('keeps a passive Codex figure on live windows without a read until they stop', async () => {
    const { registry, codex, createCodex } = setup({
      limitReadIntervalMs: undefined,
      limitCacheMs: undefined,
    })
    await codex.usageLimitSource('visible')
    expect(createCodex).toHaveBeenCalledOnce()
    // A 20-minute session: Codex reports its window beside every model request,
    // and the sidebar figure re-pulls after each spaced usage change.
    for (let second = 30; second <= 20 * 60; second += 30) {
      await vi.advanceTimersByTimeAsync(30_000)
      registry.applyLimitRows('codex', [
        { id: 'codex:primary', label: 'Weekly', usedPercent: second / 60 },
      ])
      await codex.usageLimitSource('background')
    }
    expect(createCodex).toHaveBeenCalledOnce()
    expect(codex.heldLimitSource()).toMatchObject({
      origin: 'live',
      limits: [{ id: 'codex:primary', usedPercent: 20 }],
    })
    // A shown view still gets a full read once the last one is 5 minutes old.
    await codex.usageLimitSource('visible')
    expect(createCodex).toHaveBeenCalledTimes(2)
    // Once the windows stop, a passive figure reads at most every 5 minutes again.
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    await codex.usageLimitSource('background')
    expect(createCodex).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await codex.usageLimitSource('background')
    expect(createCodex).toHaveBeenCalledTimes(3)
  })

  it('reads for a passive figure after a redeemed reset, even while live windows arrive', async () => {
    const { registry, codex, createCodex } = setup({
      limitReadIntervalMs: undefined,
      limitCacheMs: undefined,
    })
    await codex.usageLimitSource('visible')
    registry.applyLimitRows('codex', [{ id: 'codex:primary', label: 'Weekly', usedPercent: 90 }])
    await codex.consumeRateLimitReset!('fixture-idempotency-key')
    await codex.usageLimitSource('background')
    // The first read, the reset's own process, and the read after it.
    expect(createCodex).toHaveBeenCalledTimes(3)
  })

  it('still reads other providers for a passive figure', async () => {
    expect(PROVIDER_CAPABILITIES.grok).not.toHaveProperty('limitReadsWhenShown')
    const usageLimitSource = vi.fn(async () => weekly(20))
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    await expect(
      registry.forProvider('grok').usageLimitSource('background'),
    ).resolves.toMatchObject({ status: 'ready', origin: 'read' })
    expect(usageLimitSource).toHaveBeenCalledOnce()
  })
})

describe('last-known limits', () => {
  const weekly = (usedPercent: number) => ({
    status: 'ready' as const,
    limits: [{ label: 'Weekly', usedPercent }],
  })
  const timeout = () => Object.assign(new Error('fixture-timed-out'), { name: 'TimeoutError' })

  it('answers a failed refresh with the last known values until a read succeeds', async () => {
    const usageLimitSource = vi
      .fn()
      .mockResolvedValueOnce(weekly(10))
      .mockRejectedValueOnce(new Error('fixture-limits-failed'))
      .mockResolvedValue(weekly(40))
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    await grok.usageLimitSource()
    await vi.advanceTimersByTimeAsync(60_000)
    const lastKnown = await grok.usageLimitSource()
    expect(lastKnown).toEqual({
      provider: 'grok',
      status: 'ready',
      limits: [{ label: 'Weekly', usedPercent: 10 }],
      checkedAt: 0,
      origin: 'read',
      stale: true,
      refreshError: 'fixture-limits-failed',
      retryAt: 60_000 + 5 * 60_000,
    })
    // The backoff answers with the same values and starts no read.
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    await expect(grok.usageLimitSource()).resolves.toBe(lastKnown)
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(grok.usageLimitSource()).resolves.toEqual({
      provider: 'grok',
      status: 'ready',
      limits: [{ label: 'Weekly', usedPercent: 40 }],
      checkedAt: 6 * 60_000,
      origin: 'read',
    })
    expect(usageLimitSource).toHaveBeenCalledTimes(3)
  })

  it('keeps the last known values without a retry time once timeouts run out', async () => {
    const usageLimitSource = vi.fn().mockResolvedValueOnce(weekly(10)).mockRejectedValue(timeout())
    const { registry } = setup({ services: { 'claude-code': { usageLimitSource } } })
    const claude = registry.forProvider('claude-code')
    await claude.usageLimitSource()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(claude.usageLimitSource()).resolves.toMatchObject({ retryAt: 6 * 60_000 })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const lastKnown = await claude.usageLimitSource()
    expect(lastKnown).toMatchObject({
      limits: [{ usedPercent: 10 }],
      stale: true,
      refreshError: 'fixture-timed-out',
    })
    expect(lastKnown).not.toHaveProperty('retryAt')
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    await expect(claude.usageLimitSource()).resolves.toBe(lastKnown)
    expect(usageLimitSource).toHaveBeenCalledTimes(3)
  })

  it('falls back to a stable message when a failure has none', async () => {
    const usageLimitSource = vi.fn().mockResolvedValueOnce(weekly(10)).mockRejectedValue('')
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    await grok.usageLimitSource()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(grok.usageLimitSource()).resolves.toMatchObject({
      refreshError: 'Plan limits could not be refreshed.',
    })
  })

  it('never answers for another account with the previous account values', async () => {
    const usageLimitSource = vi
      .fn()
      .mockResolvedValueOnce(weekly(10))
      .mockRejectedValue(new Error('fixture-limits-failed'))
    const account = vi
      .fn()
      .mockResolvedValueOnce({ signedIn: true, email: 'first@example.test' })
      .mockResolvedValue({ signedIn: true, email: 'second@example.test' })
    const { registry } = setup({
      // Every account read reaches the CLI, so the switch below is seen at once.
      accountCacheMs: 0,
      services: { grok: { account, usageLimitSource, signOut: async () => {} } },
    })
    const grok = registry.forProvider('grok')
    await grok.account()
    await grok.usageLimitSource()
    // Switched in the provider's own CLI.
    await grok.account()
    await expect(grok.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
    usageLimitSource.mockResolvedValueOnce(weekly(20))
    await grok.signOut()
    await grok.usageLimitSource()
    await grok.signOut()
    await expect(grok.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
  })

  it('keeps answering with an error when nothing was known before the failure', async () => {
    const usageLimitSource = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockRejectedValue(new Error('fixture-limits-failed'))
    const { registry } = setup({
      unavailableLimitCacheMs: 1_000,
      services: { grok: { usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    await grok.usageLimitSource()
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(grok.usageLimitSource()).rejects.toThrow('fixture-limits-failed')
  })
})

describe('live limit windows', () => {
  const session = { id: 'five_hour', label: '5-hour', usedPercent: 10, resetsAt: 9_000_000 }
  const week = { id: 'seven_day', label: 'Weekly', usedPercent: 20, windowMinutes: 10_080 }
  const credits = { label: 'Credits', usedPercent: 0, valueLabel: '5 left' }
  const read = (limits: ProviderLimit[] = [session, week, credits]) =>
    vi.fn(async () => ({ status: 'ready' as const, limits }))

  it('merges reported windows by id, keeps the others and publishes the snapshot', async () => {
    const { registry, hooks } = setup({ services: { grok: { usageLimitSource: read() } } })
    const grok = registry.forProvider('grok')
    await grok.usageLimitSource()
    await vi.advanceTimersByTimeAsync(2_000)
    registry.applyLimitRows('grok', [
      { id: 'five_hour', label: '5-hour', usedPercent: 15 },
      { label: 'Without id', usedPercent: 99 },
    ])
    const expected = {
      provider: 'grok',
      status: 'ready',
      // The live row has no reset time, so the read's stays.
      limits: [{ ...session, usedPercent: 15 }, week, credits],
      checkedAt: 2_000,
      origin: 'live',
    }
    // The read published its own snapshot first.
    expect(hooks.onLimitsChanged).toHaveBeenCalledTimes(2)
    expect(hooks.onLimitsChanged).toHaveBeenLastCalledWith('grok', expected)
    // A live merge is no reason for a new read.
    await expect(grok.usageLimitSource()).resolves.toEqual(expected)
  })

  it('keeps the same snapshot and publishes nothing when every window matches', async () => {
    const usageLimitSource = read()
    const { registry, hooks } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    const held = await grok.usageLimitSource()
    hooks.onLimitsChanged.mockClear()
    registry.applyLimitRows('grok', [
      { id: 'five_hour', label: '5-hour', usedPercent: 10 },
      { id: 'seven_day', label: 'Weekly', usedPercent: 20 },
    ])
    registry.applyLimitRows('grok', [])
    expect(hooks.onLimitsChanged).not.toHaveBeenCalled()
    await expect(grok.usageLimitSource()).resolves.toBe(held)
    expect(usageLimitSource).toHaveBeenCalledOnce()
  })

  it('collapses a burst into one leading and one trailing snapshot', async () => {
    const { registry, hooks } = setup({ services: { grok: { usageLimitSource: read() } } })
    await registry.forProvider('grok').usageLimitSource()
    await vi.advanceTimersByTimeAsync(1_000)
    hooks.onLimitsChanged.mockClear()
    for (let tick = 1; tick <= 20; tick += 1) {
      registry.applyLimitRows('grok', [{ id: 'five_hour', label: '5-hour', usedPercent: tick }])
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(hooks.onLimitsChanged).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hooks.onLimitsChanged).toHaveBeenCalledTimes(2)
    expect(hooks.onLimitsChanged.mock.lastCall?.[1]).toMatchObject({
      limits: [{ id: 'five_hour', usedPercent: 20 }, week, credits],
    })
  })

  it('tells re-pulling clients about a live change at a spaced rate, without a new read', async () => {
    const usageLimitSource = read()
    const { registry, hooks } = setup({
      limitChangeIntervalMs: 30_000,
      services: { grok: { usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    await grok.usageLimitSource()
    registry.applyLimitRows('grok', [{ id: 'five_hour', label: '5-hour', usedPercent: 11 }])
    expect(hooks.onUsageChanged).toHaveBeenCalledExactlyOnceWith('grok')
    // Equal windows are no change; a burst of changes waits for one trailing signal.
    registry.applyLimitRows('grok', [{ id: 'five_hour', label: '5-hour', usedPercent: 11 }])
    for (const usedPercent of [12, 13, 14]) {
      registry.applyLimitRows('grok', [{ id: 'five_hour', label: '5-hour', usedPercent }])
    }
    expect(hooks.onUsageChanged).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(hooks.onUsageChanged).toHaveBeenCalledTimes(2)
    // The re-pull is answered from the merged snapshot.
    await expect(grok.usageLimitSource()).resolves.toMatchObject({
      origin: 'live',
      limits: [{ id: 'five_hour', usedPercent: 14 }, week, credits],
    })
    expect(usageLimitSource).toHaveBeenCalledOnce()
  })

  it('makes last known values current again', async () => {
    const usageLimitSource = read()
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    await grok.usageLimitSource()
    usageLimitSource.mockRejectedValueOnce(new Error('fixture-limits-failed'))
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(grok.usageLimitSource()).resolves.toMatchObject({ stale: true })
    registry.applyLimitRows('grok', [{ id: 'seven_day', label: 'Weekly', usedPercent: 30 }])
    const current = await grok.usageLimitSource()
    expect(current).toMatchObject({ origin: 'live', checkedAt: 60_000 })
    for (const key of ['stale', 'refreshError', 'retryAt']) expect(current).not.toHaveProperty(key)
  })

  it('starts a snapshot from live windows and leaves an account without plan limits alone', async () => {
    const { registry, hooks } = setup({
      services: { 'claude-code': { usageLimitSource: async () => ({ status: 'unavailable' }) } },
    })
    registry.applyLimitRows('grok', [session])
    expect(hooks.onLimitsChanged).toHaveBeenCalledExactlyOnceWith('grok', {
      provider: 'grok',
      status: 'ready',
      limits: [session],
      checkedAt: 0,
      origin: 'live',
    })
    const claude = registry.forProvider('claude-code')
    await claude.usageLimitSource()
    hooks.onLimitsChanged.mockClear()
    registry.applyLimitRows('claude-code', [session])
    await expect(claude.usageLimitSource()).resolves.toEqual({
      provider: 'claude-code',
      status: 'unavailable',
    })
    expect(hooks.onLimitsChanged).not.toHaveBeenCalled()
  })

  it('does not let a read that started earlier revert a newer live window', async () => {
    const answer = deferred<{ status: 'ready'; limits: ProviderLimit[] }>()
    const usageLimitSource = vi.fn().mockReturnValueOnce(answer.promise)
    const { registry } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    const reading = grok.usageLimitSource()
    await vi.advanceTimersByTimeAsync(1_000)
    registry.applyLimitRows('grok', [{ id: 'five_hour', label: '5-hour', usedPercent: 30 }])
    answer.resolve({ status: 'ready', limits: [session, week] })
    await expect(reading).resolves.toMatchObject({
      origin: 'read',
      limits: [{ ...session, usedPercent: 30 }, week],
    })
    // A later read is newer than that window.
    usageLimitSource.mockResolvedValue({ status: 'ready', limits: [session, week] })
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(grok.usageLimitSource()).resolves.toMatchObject({ limits: [session, week] })
  })

  it('forgets live windows when the account changes', async () => {
    const usageLimitSource = read([session, week])
    const { registry } = setup({
      services: { grok: { usageLimitSource, signOut: async () => {} } },
    })
    const grok = registry.forProvider('grok')
    await grok.usageLimitSource()
    registry.applyLimitRows('grok', [{ id: 'five_hour', label: '5-hour', usedPercent: 30 }])
    await grok.signOut()
    await expect(grok.usageLimitSource()).resolves.toMatchObject({
      origin: 'read',
      limits: [session, week],
    })
  })

  it('publishes each read and tells older clients only when the shown limits change', async () => {
    const usageLimitSource = vi
      .fn()
      .mockResolvedValueOnce({ status: 'ready', limits: [week] })
      .mockResolvedValueOnce({ status: 'ready', limits: [week] })
      .mockResolvedValueOnce({ status: 'ready', limits: [{ ...week, usedPercent: 40 }] })
      .mockRejectedValue(new Error('fixture-limits-failed'))
    const { registry, hooks } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    const pushed = () => hooks.onLimitsChanged.mock.calls.length
    // The first read answers its own caller.
    await grok.usageLimitSource()
    expect([pushed(), hooks.onUsageChanged.mock.calls.length]).toEqual([1, 0])
    // A newer check of the same values changes nothing a client shows.
    await vi.advanceTimersByTimeAsync(60_000)
    await grok.usageLimitSource()
    expect([pushed(), hooks.onUsageChanged.mock.calls.length]).toEqual([2, 0])
    expect(hooks.onLimitsChanged.mock.lastCall?.[1]).toMatchObject({ checkedAt: 60_000 })
    await vi.advanceTimersByTimeAsync(60_000)
    await grok.usageLimitSource()
    expect([pushed(), hooks.onUsageChanged.mock.calls.length]).toEqual([3, 1])
    // Values that became last known are shown differently.
    await vi.advanceTimersByTimeAsync(60_000)
    await grok.usageLimitSource()
    expect([pushed(), hooks.onUsageChanged.mock.calls.length]).toEqual([4, 2])
    expect(hooks.onLimitsChanged.mock.lastCall?.[1]).toMatchObject({ stale: true })
    // The backoff answers without anything new to send.
    await grok.usageLimitSource()
    expect([pushed(), hooks.onUsageChanged.mock.calls.length]).toEqual([4, 2])
    expect(hooks.onUsageChanged).toHaveBeenCalledWith('grok')
  })

  it('drops a pending trailing snapshot on reset', async () => {
    const { registry, hooks } = setup({ services: { grok: { usageLimitSource: read() } } })
    await registry.forProvider('grok').usageLimitSource()
    await vi.advanceTimersByTimeAsync(1_000)
    hooks.onLimitsChanged.mockClear()
    registry.applyLimitRows('grok', [{ id: 'five_hour', label: '5-hour', usedPercent: 11 }])
    registry.applyLimitRows('grok', [{ id: 'five_hour', label: '5-hour', usedPercent: 12 }])
    await registry.disposeAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hooks.onLimitsChanged).toHaveBeenCalledOnce()
  })
})

describe('held limits first', () => {
  const totals = {
    session: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    today: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  }
  const weekly = (usedPercent: number) => ({
    status: 'ready' as const,
    limits: [{ id: 'seven_day', label: 'Weekly', usedPercent }],
  })

  it('holds nothing before the first read and nothing for a new account', async () => {
    const { registry } = setup({
      services: {
        grok: { usageLimitSource: async () => weekly(10), signOut: async () => {} },
      },
    })
    const grok = registry.forProvider('grok')
    expect(grok.heldLimitSource()).toBeUndefined()
    const read = await grok.usageLimitSource()
    expect(grok.heldLimitSource()).toBe(read)
    await grok.signOut()
    expect(grok.heldLimitSource()).toBeUndefined()
  })

  it('answers an expired value at once, refreshes it once and signals only a change', async () => {
    const second = deferred<ReturnType<typeof weekly>>()
    const usageLimitSource = vi
      .fn()
      .mockResolvedValueOnce(weekly(10))
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(weekly(40))
    const { registry, hooks } = setup({ services: { grok: { usageLimitSource } } })
    const grok = registry.forProvider('grok')
    const summary = () =>
      usageSummaryWithLimits(
        totals,
        'grok',
        () => grok.usageLimitSource(),
        () => grok.heldLimitSource(),
      )
    // Only the first read is awaited.
    await expect(summary()).resolves.toMatchObject({ limits: [{ usedPercent: 10 }] })
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(summary()).resolves.toMatchObject({ limits: [{ usedPercent: 10 }] })
    await expect(summary()).resolves.toMatchObject({ limits: [{ usedPercent: 10 }] })
    await flush()
    // Both callers share the one background read.
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
    expect(hooks.onUsageChanged).not.toHaveBeenCalled()
    second.resolve(weekly(10))
    await flush()
    // Equal numbers change nothing a client shows.
    expect(hooks.onUsageChanged).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(summary()).resolves.toMatchObject({ limits: [{ usedPercent: 10 }] })
    await flush()
    expect(hooks.onUsageChanged).toHaveBeenCalledExactlyOnceWith('grok')
    await expect(summary()).resolves.toMatchObject({ limits: [{ usedPercent: 40 }] })
    expect(usageLimitSource).toHaveBeenCalledTimes(3)
  })
})

describe('limits from the last session', () => {
  const totals = {
    session: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    today: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  }
  const weekly = (usedPercent: number) => ({
    status: 'ready' as const,
    limits: [{ id: 'seven_day', label: 'Weekly', usedPercent }],
  })
  const lastSession = (provider: 'grok' | 'claude-code') => ({
    read: () =>
      serializeLimitSnapshot(
        new Map([[provider, { provider, ...weekly(10), checkedAt: 0, origin: 'read' as const }]]),
      ),
    write: vi.fn<(value: string) => void>(),
  })

  it('answers a shown view from the last session at once and refreshes it', async () => {
    const read = deferred<ReturnType<typeof weekly>>()
    const usageLimitSource = vi.fn(() => read.promise)
    const snapshot = lastSession('grok')
    const { registry, hooks } = setup({
      limitSnapshot: snapshot,
      services: { grok: { usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    // The first view after a launch does not wait for the vendor read.
    await expect(
      usageSummaryWithLimits(
        totals,
        'grok',
        () => grok.usageLimitSource('visible'),
        () => grok.heldLimitSource('visible'),
      ),
    ).resolves.toMatchObject({ limits: [{ usedPercent: 10 }], limitSource: { checkedAt: 0 } })
    await flush()
    expect(usageLimitSource).toHaveBeenCalledOnce()
    read.resolve(weekly(40))
    await flush()
    expect(hooks.onLimitsChanged).toHaveBeenLastCalledWith(
      'grok',
      expect.objectContaining({ limits: weekly(40).limits, origin: 'read' }),
    )
    // The new read is what the next launch shows first.
    expect(parseLimitSnapshot(snapshot.write.mock.lastCall?.[0]).get('grok')).toMatchObject({
      limits: weekly(40).limits,
    })
  })

  it('keeps the last session read as last known when the first read fails', async () => {
    const usageLimitSource = vi.fn(async () => {
      throw new Error('Grok billing request failed.')
    })
    const { registry, hooks } = setup({
      limitSnapshot: lastSession('grok'),
      services: { grok: { usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    const lastKnown = {
      limits: weekly(10).limits,
      checkedAt: 0,
      stale: true,
      refreshError: 'Grok billing request failed.',
    }
    await expect(grok.usageLimitSource('visible')).resolves.toMatchObject(lastKnown)
    expect(hooks.onLimitsChanged).toHaveBeenLastCalledWith(
      'grok',
      expect.objectContaining(lastKnown),
    )
  })

  it('never shows the last session read to a passive figure', async () => {
    const usageLimitSource = vi.fn(async () => {
      throw new Error('Grok billing request failed.')
    })
    const { registry } = setup({
      limitSnapshot: lastSession('grok'),
      services: { grok: { usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    expect(grok.heldLimitSource('background')).toBeUndefined()
    await expect(grok.usageLimitSource('background')).rejects.toThrow('billing request failed')
    expect(grok.heldLimitSource('background')).toBeUndefined()
    // A shown view inside the backoff learns that the newest read failed.
    expect(grok.heldLimitSource('visible')).toMatchObject({ stale: true, checkedAt: 0 })
    expect(usageLimitSource).toHaveBeenCalledOnce()
  })

  it('reads Claude for a passive figure only from this session', async () => {
    const usageLimitSource = vi.fn(async () => weekly(40))
    const { registry } = setup({
      limitSnapshot: lastSession('claude-code'),
      services: { 'claude-code': { usageLimitSource } },
    })
    const claude = registry.forProvider('claude-code')
    await expect(claude.usageLimitSource('background')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'failed',
    })
    expect(usageLimitSource).not.toHaveBeenCalled()
  })

  it('forgets the last session read when the account changes', async () => {
    const snapshot = lastSession('grok')
    const { registry } = setup({
      limitSnapshot: snapshot,
      services: { grok: { usageLimitSource: async () => weekly(40), signOut: async () => {} } },
    })
    const grok = registry.forProvider('grok')
    await grok.signOut()
    expect(grok.heldLimitSource('visible')).toBeUndefined()
    expect(parseLimitSnapshot(snapshot.write.mock.lastCall?.[0]).has('grok')).toBe(false)
  })

  it('keeps the held and saved limits through an account read that names no email or plan', async () => {
    const named = { signedIn: true, email: 'dev@example.test', plan: 'X Premium' }
    const account = vi
      .fn()
      .mockResolvedValueOnce(named)
      // The provider could not look up who is signed in, only that someone is.
      .mockResolvedValueOnce({ signedIn: true })
      .mockResolvedValue(named)
    const usageLimitSource = vi.fn(async () => weekly(40))
    const snapshot = lastSession('grok')
    const { registry } = setup({
      accountCacheMs: 0,
      limitSnapshot: snapshot,
      services: { grok: { account, usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    await grok.account()
    await grok.usageLimitSource('visible')
    await grok.account()
    expect(grok.heldLimitSource('visible')).toMatchObject({ limits: weekly(40).limits })
    expect(parseLimitSnapshot(snapshot.write.mock.lastCall?.[0]).get('grok')).toMatchObject({
      limits: weekly(40).limits,
    })
    await grok.account()
    await expect(grok.usageLimitSource('visible')).resolves.toMatchObject({
      limits: weekly(40).limits,
    })
    expect(usageLimitSource).toHaveBeenCalledOnce()
  })

  it('still forgets them when a read after one without detail names another account', async () => {
    const account = vi
      .fn()
      .mockResolvedValueOnce({ signedIn: true, email: 'first@example.test', plan: 'X Premium' })
      .mockResolvedValueOnce({ signedIn: true })
      .mockResolvedValue({ signedIn: true, email: 'second@example.test', plan: 'X Premium' })
    const usageLimitSource = vi.fn(async () => weekly(40))
    const snapshot = lastSession('grok')
    const { registry } = setup({
      accountCacheMs: 0,
      limitSnapshot: snapshot,
      services: { grok: { account, usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    await grok.account()
    await grok.usageLimitSource('visible')
    await grok.account()
    // Switched in the provider's own CLI.
    await grok.account()
    expect(grok.heldLimitSource('visible')).toBeUndefined()
    expect(parseLimitSnapshot(snapshot.write.mock.lastCall?.[0]).has('grok')).toBe(false)
    await grok.usageLimitSource('visible')
    expect(usageLimitSource).toHaveBeenCalledTimes(2)
  })
})

describe('a failed limit read from the last session', () => {
  const totals = {
    session: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    today: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  }
  const NOT_REPORTED = 'Claude did not report plan limits this time.'
  const weekly = (usedPercent: number) => ({
    status: 'ready' as const,
    limits: [{ id: 'seven_day', label: 'Weekly', usedPercent }],
  })
  const failing = (message = NOT_REPORTED) =>
    vi.fn(async (): Promise<ReturnType<typeof weekly>> => {
      throw new Error(message)
    })
  /** What the last session saved: its newest read failed, optionally after an earlier full read. */
  const lastSession = (
    provider: 'grok' | 'claude-code',
    options: { failure?: Partial<SavedLimitFailure>; values?: boolean } = {},
  ) => {
    let saved = serializeLimitSnapshot(
      new Map(
        options.values
          ? [[provider, { provider, ...weekly(10), checkedAt: 0, origin: 'read' as const }]]
          : [],
      ),
      new Map([
        [
          provider,
          { error: NOT_REPORTED, count: 1, timeouts: 0, retryAt: 5 * 60_000, ...options.failure },
        ],
      ]),
    )
    const write = vi.fn((value: string) => {
      saved = value
    })
    return { read: () => saved, write }
  }
  const failed = {
    provider: 'claude-code',
    status: 'unavailable',
    reason: 'failed',
    error: NOT_REPORTED,
  } as const

  it('answers the first shown view at once and reads only after the saved retry time', async () => {
    const usageLimitSource = failing()
    const snapshot = lastSession('claude-code')
    const { registry } = setup({
      limitSnapshot: snapshot,
      services: { 'claude-code': { usageLimitSource } },
    })
    const claude = registry.forProvider('claude-code')
    const summary = () =>
      usageSummaryWithLimits(
        totals,
        'claude-code',
        () => claude.usageLimitSource('visible'),
        () => claude.heldLimitSource('visible'),
      )
    await expect(summary()).resolves.toEqual({
      ...totals,
      limits: [],
      limitSource: { ...failed, retryAt: 5 * 60_000 },
    })
    await flush()
    expect(usageLimitSource).not.toHaveBeenCalled()
    // A passive figure gets the same reason without a read.
    await expect(claude.usageLimitSource('background')).resolves.toEqual(failed)
    expect(usageLimitSource).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    // Past the retry time the view still does not wait; the read runs behind it.
    await expect(summary()).resolves.toMatchObject({ limitSource: failed })
    await flush()
    expect(usageLimitSource).toHaveBeenCalledOnce()
    // It failed again, so the wait doubles as it would within one session.
    expect(parseLimitFailures(snapshot.write.mock.lastCall?.[0])).toEqual(
      new Map([
        [
          'claude-code',
          { error: NOT_REPORTED, count: 2, timeouts: 0, retryAt: 5 * 60_000 + 10 * 60_000 },
        ],
      ]),
    )
  })

  it('reads at once for a retry, and the answer ends the saved failure', async () => {
    const usageLimitSource = vi.fn(async () => weekly(40))
    const snapshot = lastSession('claude-code')
    const { registry, hooks } = setup({
      limitSnapshot: snapshot,
      services: { 'claude-code': { usageLimitSource } },
    })
    const claude = registry.forProvider('claude-code')
    expect(claude.heldLimitSource('retry')).toBeUndefined()
    await expect(
      usageSummaryWithLimits(
        totals,
        'claude-code',
        () => claude.usageLimitSource('retry'),
        () => claude.heldLimitSource('retry'),
      ),
    ).resolves.toMatchObject({ limits: weekly(40).limits })
    expect(usageLimitSource).toHaveBeenCalledOnce()
    expect(hooks.onLimitsChanged).toHaveBeenLastCalledWith(
      'claude-code',
      expect.objectContaining({ limits: weekly(40).limits }),
    )
    const written = snapshot.write.mock.lastCall?.[0]
    expect(parseLimitFailures(written).size).toBe(0)
    expect(parseLimitSnapshot(written).get('claude-code')).toMatchObject({
      limits: weekly(40).limits,
    })
  })

  it('saves a failed read with its backoff, which the next launch keeps', async () => {
    const usageLimitSource = failing()
    let saved: string | undefined
    const snapshot = {
      read: () => saved,
      write: vi.fn((value: string) => {
        saved = value
      }),
    }
    const first = setup({
      limitSnapshot: snapshot,
      services: { 'claude-code': { usageLimitSource } },
    }).registry.forProvider('claude-code')
    await expect(first.usageLimitSource('visible')).rejects.toThrow(NOT_REPORTED)
    expect(parseLimitFailures(saved).get('claude-code')).toEqual({
      error: NOT_REPORTED,
      count: 1,
      timeouts: 0,
      retryAt: 5 * 60_000,
    })

    await vi.advanceTimersByTimeAsync(60_000)
    const next = setup({
      limitSnapshot: snapshot,
      services: { 'claude-code': { usageLimitSource } },
    }).registry.forProvider('claude-code')
    expect(next.heldLimitSource('visible')).toEqual({ ...failed, retryAt: 5 * 60_000 })
    await expect(next.usageLimitSource('visible')).rejects.toThrow(NOT_REPORTED)
    expect(usageLimitSource).toHaveBeenCalledOnce()
  })

  it('gives a source out of timeouts one more read on a later launch after the longest wait', async () => {
    const timedOut = 'Claude usage request timed out.'
    const usageLimitSource = vi.fn(async (): Promise<ReturnType<typeof weekly>> => {
      throw Object.assign(new Error(timedOut), { name: 'TimeoutError' })
    })
    const snapshot = { read: () => undefined, write: vi.fn<(value: string) => void>() }
    const { registry } = setup({
      limitSnapshot: snapshot,
      services: { 'claude-code': { usageLimitSource } },
    })
    const claude = registry.forProvider('claude-code')
    await expect(claude.usageLimitSource('visible')).rejects.toThrow(timedOut)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await expect(claude.usageLimitSource('visible')).rejects.toThrow(timedOut)
    // This session waits for an account change, so it names no retry time.
    expect(claude.heldLimitSource('visible')).toEqual({ ...failed, error: timedOut })
    expect(parseLimitFailures(snapshot.write.mock.lastCall?.[0]).get('claude-code')).toEqual({
      error: timedOut,
      count: 2,
      timeouts: 2,
      retryAt: 5 * 60_000 + 30 * 60_000,
    })
  })

  it('marks the values saved before it as last known and keeps its backoff', async () => {
    const usageLimitSource = vi.fn(async () => weekly(40))
    const { registry } = setup({
      limitSnapshot: lastSession('grok', {
        values: true,
        failure: { error: 'Grok billing request failed.' },
      }),
      services: { grok: { usageLimitSource } },
    })
    const grok = registry.forProvider('grok')
    const lastKnown = {
      limits: weekly(10).limits,
      checkedAt: 0,
      stale: true,
      refreshError: 'Grok billing request failed.',
      retryAt: 5 * 60_000,
    }
    expect(grok.heldLimitSource('visible')).toMatchObject(lastKnown)
    await expect(grok.usageLimitSource('visible')).resolves.toMatchObject(lastKnown)
    expect(grok.heldLimitSource('background')).toMatchObject(lastKnown)
    expect(usageLimitSource).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await expect(grok.usageLimitSource('visible')).resolves.toMatchObject({
      limits: weekly(40).limits,
    })
    expect(grok.heldLimitSource('visible')).not.toHaveProperty('stale')
  })

  it('forgets the saved failure when the account changes', async () => {
    const snapshot = lastSession('grok')
    const usageLimitSource = vi.fn(async () => weekly(40))
    const { registry } = setup({
      limitSnapshot: snapshot,
      services: { grok: { usageLimitSource, signOut: async () => {} } },
    })
    const grok = registry.forProvider('grok')
    await grok.signOut()
    expect(grok.heldLimitSource('visible')).toBeUndefined()
    expect(parseLimitFailures(snapshot.write.mock.lastCall?.[0]).has('grok')).toBe(false)
    await expect(grok.usageLimitSource('visible')).resolves.toMatchObject({
      limits: weekly(40).limits,
    })
  })
})

describe('login ownership', () => {
  it('pins the process until the matching login completes and ignores stale completion IDs', async () => {
    const { codex, adapters, hooks } = setup()
    await codex.startLogin!()
    await vi.advanceTimersByTimeAsync(20)
    expect(adapters[0]!.dispose).not.toHaveBeenCalled()
    adapters[0]!.emit('login', { loginId: 'old-login', success: true, error: null })
    await vi.advanceTimersByTimeAsync(20)
    expect(adapters[0]!.dispose).not.toHaveBeenCalled()
    expect(hooks.onLogin).not.toHaveBeenCalled()
    adapters[0]!.emit('login', { loginId: 'login-1', success: true, error: null })
    expect(hooks.onAuthChanged).toHaveBeenCalledExactlyOnceWith('codex')
    await vi.advanceTimersByTimeAsync(10)
    expect(adapters[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('fails a browser sign-in at once when its helper process exits', async () => {
    const { codex, adapters, hooks } = setup()
    await codex.startLogin!()
    adapters[0]!.emit('disconnected')
    expect(hooks.onLogin).toHaveBeenCalledExactlyOnceWith('codex', {
      loginId: 'login-1',
      success: false,
      error: 'Codex sign-in stopped because its helper process exited.',
    })
    expect(adapters[0]!.cancelLogin).not.toHaveBeenCalled()
    // The released login no longer pins the helper or blocks a retry.
    await vi.advanceTimersByTimeAsync(10)
    expect(adapters[0]!.dispose).toHaveBeenCalledOnce()
    adapters[0]!.emit('disconnected')
    expect(hooks.onLogin).toHaveBeenCalledOnce()
    await expect(codex.startLogin!()).resolves.toMatchObject({ loginId: 'login-1' })
    expect(adapters).toHaveLength(2)
  })

  it('handles completion that arrives before the start response', async () => {
    const adapter = new FakeCodex()
    adapter.startLogin.mockImplementationOnce(async () => {
      adapter.emit('login', { loginId: 'login-1', success: true, error: null })
      return { loginId: 'login-1', authUrl: 'https://example.test/login' }
    })
    const { codex, hooks } = setup({ createCodex: () => adapter })
    await codex.startLogin!()
    expect(hooks.onLogin).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10)
    expect(adapter.dispose).toHaveBeenCalledOnce()
  })

  it('serializes replacement logins and awaits cancellation of the captured old ID', async () => {
    const adapter = new FakeCodex()
    adapter.startLogin.mockResolvedValueOnce({
      loginId: 'first',
      authUrl: 'https://example.test/first',
    })
    adapter.startLogin.mockResolvedValueOnce({
      loginId: 'second',
      authUrl: 'https://example.test/second',
    })
    const canceled = deferred<void>()
    adapter.cancelLogin.mockReturnValueOnce(canceled.promise)
    const { codex } = setup({ createCodex: () => adapter })
    await codex.startLogin!()
    const second = codex.startLogin!()
    await flush()
    expect(adapter.cancelLogin).toHaveBeenCalledExactlyOnceWith('first')
    expect(adapter.startLogin).toHaveBeenCalledOnce()
    canceled.resolve()
    await expect(second).resolves.toMatchObject({ loginId: 'second' })
    await codex.cancelLogin!('first')
    expect(adapter.cancelLogin).toHaveBeenCalledOnce()
    await codex.cancelLogin!('second')
    expect(adapter.cancelLogin).toHaveBeenLastCalledWith('second')
  })

  it('releases a failed login start and bounds an abandoned browser login', async () => {
    const adapter = new FakeCodex()
    adapter.startLogin.mockRejectedValueOnce(new Error('fixture-login-failed'))
    const { codex, hooks } = setup({ createCodex: () => adapter })
    await expect(codex.startLogin!()).rejects.toThrow('fixture-login-failed')
    await codex.startLogin!()
    await vi.advanceTimersByTimeAsync(200)
    expect(adapter.cancelLogin).toHaveBeenCalledExactlyOnceWith('login-1')
    expect(hooks.onLogin).toHaveBeenCalledWith('codex', {
      loginId: 'login-1',
      success: false,
      error: 'Provider sign-in timed out.',
    })
    adapter.emit('login', { loginId: 'login-1', success: true, error: null })
    expect(hooks.onAuthChanged).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(adapter.dispose).toHaveBeenCalledOnce()
  })

  it('keeps ownership when cancellation fails and prevents replacement until retry', async () => {
    const { codex, adapters } = setup()
    await codex.startLogin!()
    adapters[0]!.cancelLogin.mockRejectedValueOnce(new Error('fixture-cancel-failed'))
    await expect(codex.startLogin!()).rejects.toThrow('fixture-cancel-failed')
    expect(adapters[0]!.startLogin).toHaveBeenCalledOnce()
    await codex.cancelLogin!('login-1')
    await vi.advanceTimersByTimeAsync(10)
    expect(adapters[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('reports an expired login even when cleanup fails and retains ownership for retry', async () => {
    const { codex, adapters, hooks } = setup()
    await codex.startLogin!()
    const adapter = adapters[0]!
    adapter.cancelLogin.mockRejectedValue(new Error('fixture-cancel-failed'))
    await vi.advanceTimersByTimeAsync(200)
    expect(hooks.onLogin).toHaveBeenCalledExactlyOnceWith('codex', {
      loginId: 'login-1',
      success: false,
      error: 'Provider sign-in timed out.',
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(adapter.cancelLogin).toHaveBeenCalledOnce()
    expect(adapter.dispose).not.toHaveBeenCalled()
    await expect(codex.startLogin!()).rejects.toThrow('fixture-cancel-failed')
    expect(adapter.startLogin).toHaveBeenCalledOnce()
    adapter.cancelLogin.mockResolvedValue()
    await codex.cancelLogin!('login-1')
    await vi.advanceTimersByTimeAsync(10)
    expect(adapter.dispose).toHaveBeenCalledOnce()
    expect(hooks.onLogin).toHaveBeenCalledOnce()
  })

  it('cancels a login before an API-key sign-in or sign-out', async () => {
    const { codex, adapters, hooks } = setup()
    await codex.startLogin!()
    await expect(codex.useApiKey!('fixture-credential')).resolves.toEqual({ signedIn: true })
    expect(adapters[0]!.cancelLogin).toHaveBeenCalledWith('login-1')
    expect(adapters[0]!.useApiKey).toHaveBeenCalledExactlyOnceWith('fixture-credential')
    await codex.startLogin!()
    await codex.signOut()
    expect(adapters[0]!.cancelLogin).toHaveBeenCalledTimes(2)
    expect(adapters[0]!.signOut).toHaveBeenCalledOnce()
    expect(hooks.onAuthChanged).toHaveBeenCalledTimes(2)
  })

  it('stops an active login through process disposal during reset without racing cancellation RPCs', async () => {
    const { registry, codex, adapters, hooks } = setup()
    await codex.startLogin!()
    await registry.disposeAll()
    expect(adapters[0]!.dispose).toHaveBeenCalledOnce()
    expect(adapters[0]!.cancelLogin).not.toHaveBeenCalled()
    adapters[0]!.emit('login', { loginId: 'login-1', success: true, error: null })
    expect(hooks.onAuthChanged).not.toHaveBeenCalled()
    await codex.startLogin!()
    expect(adapters).toHaveLength(2)
  })

  it.each(['claude-code', 'cursor'] as const)(
    'bounds %s login and ignores old callbacks after replacement',
    async (provider) => {
      const login = externalLogin()
      const { registry, hooks, createCodex } = setup({
        services: { [provider]: { startLogin: login.startLogin } },
      })
      const control = registry.forProvider(provider)
      await control.startLogin!()
      await control.startLogin!()
      expect(login.cancels[0]).toHaveBeenCalledOnce()
      login.callbacks[0]!({ loginId: 'external-1', success: true, error: null })
      expect(hooks.onLogin).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      expect(login.cancels[1]).toHaveBeenCalledOnce()
      expect(hooks.onLogin).toHaveBeenCalledExactlyOnceWith(provider, {
        loginId: 'external-2',
        success: false,
        error: 'Provider sign-in timed out.',
      })
      expect(createCodex).not.toHaveBeenCalled()
    },
  )

  it('releases sign-in work behind a start that never answers and cancels its late handle', async () => {
    const pending = deferred<{ loginId: string; cancel: () => Promise<void> }>()
    const lateCancel = vi.fn(async () => {})
    const signOut = vi.fn(async () => {})
    const { registry } = setup({
      loginStartTimeoutMs: 50,
      services: { 'claude-code': { startLogin: () => pending.promise, signOut } },
    })
    const control = registry.forProvider('claude-code')
    const starting = expect(control.startLogin!()).rejects.toThrow('did not start in time')
    await vi.advanceTimersByTimeAsync(50)
    await starting
    await control.signOut()
    expect(signOut).toHaveBeenCalledOnce()

    pending.resolve({ loginId: 'late', cancel: lateCancel })
    await flush()
    expect(lateCancel).toHaveBeenCalledOnce()
  })

  it('awaits external login cancellation during reset and can retry a failed cancellation', async () => {
    const login = externalLogin()
    const { registry } = setup({ services: { cursor: { startLogin: login.startLogin } } })
    await registry.forProvider('cursor').startLogin!()
    login.cancels[0]!.mockRejectedValue(new Error('fixture-cancel-failed'))
    await expect(registry.disposeAll()).rejects.toThrow('could not stop')
    login.cancels[0]!.mockResolvedValue()
    const canceled = deferred<void>()
    login.cancels[0]!.mockReturnValueOnce(canceled.promise)
    let settled = false
    const reset = registry.disposeAll().then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    canceled.resolve()
    await reset
    await registry.forProvider('cursor').startLogin!()
    expect(login.startLogin).toHaveBeenCalledTimes(2)
  })

  it('confirms external process-tree cleanup before publishing login success', async () => {
    const login = externalLogin()
    const stopped = deferred<void>()
    const { registry, hooks } = setup({
      services: { 'claude-code': { startLogin: login.startLogin } },
    })
    await registry.forProvider('claude-code').startLogin!()
    login.cancels[0]!.mockReturnValueOnce(stopped.promise)
    login.callbacks[0]!({ loginId: 'external-1', success: true, error: null })
    await flush()
    expect(login.cancels[0]).toHaveBeenCalledOnce()
    expect(hooks.onLogin).not.toHaveBeenCalled()
    expect(hooks.onAuthChanged).not.toHaveBeenCalled()
    stopped.resolve()
    await flush()
    expect(hooks.onAuthChanged).toHaveBeenCalledExactlyOnceWith('claude-code')
    expect(hooks.onLogin).toHaveBeenCalledExactlyOnceWith('claude-code', {
      loginId: 'external-1',
      success: true,
      error: null,
    })
  })

  it('reports failed completion cleanup and retains the login for a later retry', async () => {
    const login = externalLogin()
    const { registry, hooks } = setup({ services: { cursor: { startLogin: login.startLogin } } })
    const cursor = registry.forProvider('cursor')
    await cursor.startLogin!()
    login.cancels[0]!.mockRejectedValueOnce(new Error('fixture-stop-failed'))
    login.callbacks[0]!({ loginId: 'external-1', success: true, error: null })
    await flush()
    expect(hooks.onAuthChanged).not.toHaveBeenCalled()
    expect(hooks.onLogin).toHaveBeenCalledExactlyOnceWith('cursor', {
      loginId: 'external-1',
      success: false,
      error: 'Provider sign-in process could not stop.',
    })
    await cursor.cancelLogin!('external-1')
    expect(login.cancels[0]).toHaveBeenCalledTimes(2)
  })

  it('cancels a handle that arrives after reset and suppresses its completion callback', async () => {
    const loading = deferred<{ loginId: string; cancel: () => Promise<void> }>()
    let complete!: (result: ProviderLoginResult) => void
    const cancel = vi.fn(async () => {})
    const { registry, hooks } = setup({
      services: {
        cursor: {
          startLogin: (callback) => {
            complete = callback
            return loading.promise
          },
        },
      },
    })
    const started = registry.forProvider('cursor').startLogin!()
    const checked = expect(started).rejects.toThrow('canceled')
    await flush()
    const resetting = registry.disposeAll()
    loading.resolve({ loginId: 'late-login', cancel })
    await resetting
    await checked
    expect(cancel).toHaveBeenCalledOnce()
    complete({ loginId: 'late-login', success: true, error: null })
    expect(hooks.onAuthChanged).not.toHaveBeenCalled()
    expect(hooks.onLogin).not.toHaveBeenCalled()
  })

  it('coalesces timeout, explicit cancellation and reset, without a late timeout event', async () => {
    const login = externalLogin()
    const stopped = deferred<void>()
    const { registry, hooks } = setup({ services: { cursor: { startLogin: login.startLogin } } })
    const cursor = registry.forProvider('cursor')
    await cursor.startLogin!()
    login.cancels[0]!.mockReturnValueOnce(stopped.promise)
    await vi.advanceTimersByTimeAsync(200)
    const canceled = cursor.cancelLogin!('external-1')
    await flush()
    const resetting = registry.disposeAll()
    await flush()
    expect(login.cancels[0]).toHaveBeenCalledOnce()
    stopped.resolve()
    await resetting
    await canceled
    expect(hooks.onLogin).not.toHaveBeenCalled()
  })

  it('cancels an expired start as soon as its late handle arrives', async () => {
    const loading = deferred<{ loginId: string; cancel: () => Promise<void> }>()
    const cancel = vi.fn(async () => {})
    const { registry } = setup({ services: { cursor: { startLogin: () => loading.promise } } })
    const started = registry.forProvider('cursor').startLogin!()
    const checked = expect(started).rejects.toThrow('canceled')
    await vi.advanceTimersByTimeAsync(200)
    loading.resolve({ loginId: 'expired-login', cancel })
    await checked
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not block one provider login behind another provider startup', async () => {
    const starting = deferred<void>()
    const adapter = new FakeCodex()
    adapter.start.mockReturnValueOnce(starting.promise)
    const login = externalLogin()
    const { registry, codex } = setup({
      createCodex: () => adapter,
      services: { cursor: { startLogin: login.startLogin } },
    })
    const started = codex.startLogin!()
    await expect(registry.forProvider('cursor').startLogin!()).resolves.toEqual({
      loginId: 'external-1',
    })
    expect(adapter.startLogin).not.toHaveBeenCalled()
    starting.resolve()
    await started
  })

  it('does not report an auth change when a sign-out finishes during reset', async () => {
    const signedOut = deferred<void>()
    const { registry, hooks } = setup({ services: { grok: { signOut: () => signedOut.promise } } })
    const signingOut = registry.forProvider('grok').signOut()
    const checked = expect(signingOut).rejects.toThrow('reset')
    await flush()
    const resetting = registry.disposeAll()
    signedOut.resolve()
    await checked
    await resetting
    expect(hooks.onAuthChanged).not.toHaveBeenCalled()
  })
})
