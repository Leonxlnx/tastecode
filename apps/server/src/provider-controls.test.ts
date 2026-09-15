import { EventEmitter } from 'node:events'
import { ProviderIdSchema, type Model, type ProviderLimit } from '@harness/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_CAPABILITIES } from './provider-capabilities.js'
import {
  ProviderControls,
  type ProviderControlsOptions,
  type ProviderLoginResult,
  type ProviderServices,
} from './provider-controls.js'

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
  listSkills = vi.fn(async () => ({ skills: [], errors: [] }))
  setSkillEnabled = vi.fn(async () => true)
  rateLimitSource = vi.fn(async (): Promise<{ status: 'ready'; limits: ProviderLimit[] }> => ({
    status: 'ready',
    limits: [],
  }))
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
    onMcpChanged: vi.fn(),
    onSkillsChanged: vi.fn(),
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
  it('validates Claude MCP changes without starting a control process', () => {
    const { registry, createCodex } = setup()
    const control = registry.forProvider('claude-code')
    expect(control.capabilities.managedMcp).toBe(true)
    expect(control.listMcpServers).toBeUndefined()
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
  it('keeps the full roster and creates no processes until a read needs one', async () => {
    const { registry, createCodex } = setup()
    expect(Object.keys(PROVIDER_CAPABILITIES).sort()).toEqual([...ProviderIdSchema.options].sort())
    expect(
      ProviderIdSchema.options.filter((provider) => PROVIDER_CAPABILITIES[provider].resume),
    ).toEqual(['codex', 'claude-code', 'grok', 'cursor', 'opencode', 'acp'])
    for (const provider of ProviderIdSchema.options) {
      const control = registry.forProvider(provider)
      const flags = control.capabilities
      expect(Boolean(control.listModels)).toBe(flags.nativeModels)
      expect(Boolean(control.listMcpServers)).toBe(flags.inheritedMcp)
      expect(Boolean(control.listSkills)).toBe(flags.nativeSkills)
      expect(Boolean(control.setSkillEnabled)).toBe(flags.nativeSkills)
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
      expect(listModels).toHaveBeenCalledWith(provider, 'custom-agent')
    }
    await codex.listModels?.('custom-codex')
    expect(listModels).toHaveBeenCalledWith('codex', 'custom-codex')
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
    })
    expect(createCodex).not.toHaveBeenCalled()
  })

  it('reuses active MCP inventory and returns adapter capabilities without a second process', async () => {
    const { codex, createCodex } = setup()
    const readActive = vi.fn(async () => [])
    const inventory = await codex.listMcpServers?.(readActive)
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
    })
    expect(readActive).toHaveBeenCalledOnce()
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
    await codex.listMcpServers!()
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
