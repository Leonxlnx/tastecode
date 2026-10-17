import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Account,
  BackgroundModelPreference,
  Capabilities,
  DomainEvent,
  Model,
  ProviderId,
} from '@harness/contracts'
import type { AgentSession, ProviderRuntime } from './adapters.js'
import { CustomHarnessStore } from './custom-harnesses.js'
import { Store } from './store.js'

/**
 * Every account and model read the background discovery makes, in call order.
 * The vendor processes behind each one: Claude Code's account runs
 * `claude auth status` and its model list one SDK `claude` process; Codex
 * answers both from one shared `codex app-server`; Grok's account runs
 * `grok models` plus `grok agent stdio` and its model list `grok models`.
 */
const vendor = vi.hoisted(() => ({
  calls: [] as string[],
  codexProcesses: 0,
  accounts: new Map<string, Account>(),
  models: new Map<string, Model[]>(),
  gates: new Map<string, Promise<void>>(),
}))

/** A read answers with the state at its start, even when a gate holds it open. */
async function read<T>(call: string, value: () => T): Promise<T> {
  vendor.calls.push(call)
  const answer = value()
  await vendor.gates.get(call)
  return answer
}

vi.mock('@harness/adapter-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-codex')>()
  return {
    ...original,
    CodexAdapter: class {
      constructor() {
        vendor.codexProcesses += 1
      }
      on(): void {}
      onUsageChanged(): void {}
      dispose(): void {}
      async start(): Promise<void> {}
      account(): Promise<Account> {
        return read('account:codex', () => vendor.accounts.get('codex') ?? { signedIn: false })
      }
      listModels(): Promise<Model[]> {
        return read('models:codex', () => vendor.models.get('codex') ?? [])
      }
      async signOut(): Promise<void> {
        vendor.accounts.set('codex', { signedIn: false })
      }
    },
  }
})

vi.mock('@harness/adapter-claude-code', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-claude-code')>()
  return {
    ...original,
    claudeAccount: () =>
      read('account:claude-code', () => vendor.accounts.get('claude-code') ?? { signedIn: false }),
  }
})

vi.mock('@harness/adapter-grok', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-grok')>()
  return {
    ...original,
    grokAccount: () =>
      read('account:grok', () => vendor.accounts.get('grok') ?? { signedIn: false }),
  }
})

const { Orchestrator } = await import('./orchestrator.js')

const model = (id: string, reasoningEfforts: string[] = ['low', 'high']): Model => ({
  id,
  displayName: id,
  isDefault: false,
  reasoningEfforts,
  serviceTiers: [],
})

const CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: false,
}

class TitleSession implements AgentSession {
  readonly capabilities = CAPABILITIES
  #events = new EventEmitter()
  readonly #failure: Error | 'turn' | undefined

  constructor(failure?: Error | 'turn') {
    this.#failure = failure
  }

  async sendTurn(): Promise<string> {
    const failure = this.#failure
    if (failure instanceof Error) throw failure
    queueMicrotask(() => {
      if (failure === 'turn') {
        this.#emit({ type: 'turn.completed', turnId: 'background-turn', status: 'failed' })
        return
      }
      this.#emit({
        type: 'item.completed',
        item: {
          id: 'answer',
          turnId: 'background-turn',
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          text: 'Generated title',
          createdAt: 0,
        },
      })
      this.#emit({ type: 'turn.completed', turnId: 'background-turn', status: 'completed' })
    })
    return 'background-turn'
  }

  async interrupt(): Promise<void> {}
  respondToApproval(): void {}
  dispose(): void {}
  on(event: 'event' | 'log', listener: (value: never) => void): void {
    this.#events.on(event, listener)
  }
  #emit(event: DomainEvent): void {
    this.#events.emit('event', event)
  }
}

const roots: string[] = []
const active: Array<{ orchestrator: InstanceType<typeof Orchestrator>; store: Store }> = []

function harness(
  preference: BackgroundModelPreference = { mode: 'automatic' },
  failure?: (provider: ProviderId, agent: string | undefined) => Error | 'turn' | undefined,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tastecode-background-sources-'))
  roots.push(root)
  const started: Array<{
    provider: ProviderId
    model: string | undefined
    agent?: string | undefined
  }> = []
  const runtimeFor = (provider: ProviderId): ProviderRuntime => ({
    async start(workspacePath, options) {
      started.push({ provider, model: options.model, agent: options.agent })
      return {
        thread: { id: 'background-thread', provider, workspacePath, createdAt: 0 },
        session: new TitleSession(failure?.(provider, options.agent)),
      }
    },
    listModels: (agent) => {
      const key = agent ? `${provider}:${agent}` : provider
      return read(`models:${key}`, () => vendor.models.get(key) ?? [])
    },
  })
  const store = new Store(':memory:')
  store.updateBackgroundModelPreference(preference)
  const customHarnesses = new CustomHarnessStore(path.join(root, 'harnesses.json'))
  const orchestrator = new Orchestrator(store, {
    onEvent: () => {},
    onLog: () => {},
    onLogin: () => {},
    runtimeFor,
    customHarnesses,
    worktreeRoot: path.join(root, 'worktrees'),
  })
  active.push({ orchestrator, store })
  let titles = 0
  const title = async () => {
    titles += 1
    const threadId = `thread-${titles}`
    store.addThread({ id: threadId, projectPath: root, provider: 'codex', title: 'New chat' })
    return orchestrator.generateBackgroundTitle(threadId, 'Fix the queue order', 'New chat')
  }
  return { orchestrator, store, customHarnesses, started, title }
}

function signIn(provider: ProviderId, models: Model[], account: Partial<Account> = {}): void {
  vendor.accounts.set(provider, { signedIn: true, ...account })
  vendor.models.set(provider, models)
}

function gate(call: string): () => void {
  let release!: () => void
  vendor.gates.set(
    call,
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  return () => {
    vendor.gates.delete(call)
    release()
  }
}

beforeEach(() => {
  vendor.calls = []
  vendor.codexProcesses = 0
  vendor.accounts.clear()
  vendor.models.clear()
  vendor.gates.clear()
})

afterEach(async () => {
  for (const entry of active.splice(0)) {
    await entry.orchestrator.disposeAll()
    entry.store.close()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('background title source discovery', () => {
  beforeEach(() => {
    signIn('claude-code', [model('claude-haiku-4-5')])
    signIn('codex', [model('gpt-5.6-luna')], { plan: 'Pro' })
    signIn('grok', [model('grok-4.6')])
  })

  it('reads only Codex when its subscription offers Luna', async () => {
    const { title, started } = harness()

    await expect(title()).resolves.toEqual({ title: 'Generated title', applied: true })

    expect(started).toEqual([{ provider: 'codex', model: 'gpt-5.6-luna' }])
    expect(vendor.calls).toEqual(['account:codex', 'models:codex'])
    expect(vendor.codexProcesses).toBe(1)
  })

  it('reads Grok next, and only then, when Codex has no subscription Luna', async () => {
    signIn('codex', [model('gpt-5.6-luna')], { plan: 'API key' })
    const { title, started } = harness()

    await title()

    expect(started).toEqual([{ provider: 'grok', model: 'grok-4.6' }])
    expect(vendor.calls).toEqual(['account:codex', 'models:codex', 'account:grok', 'models:grok'])
  })

  it('reads every source for the cheapest-model fallback and breaks ties by source order', async () => {
    signIn('codex', [model('gpt-5.6-pro')], { plan: 'API key' })
    signIn('grok', [model('grok-4.5')])
    const { title, started, customHarnesses } = harness()
    customHarnesses.upsert({
      id: 'fork',
      displayName: 'Claude fork',
      provider: 'claude-code',
      command: 'claude-fork',
      args: [],
    })
    vendor.models.set('claude-code:fork', [model('claude-haiku-4-5')])
    const release = gate('models:claude-code')

    const pending = title()
    await vi.waitFor(() => expect(vendor.calls).toContain('models:claude-code:fork'), {
      timeout: 5_000,
    })
    await vi.waitFor(() => expect(vendor.calls).toContain('models:claude-code'), { timeout: 5_000 })
    release()
    await pending

    // The fork answers first with the same model; the earlier source still wins.
    expect(started).toEqual([{ provider: 'claude-code', model: 'claude-haiku-4-5' }])
    expect([...vendor.calls].sort()).toEqual(
      [
        'account:codex',
        'models:codex',
        'account:grok',
        'models:grok',
        'account:claude-code',
        'models:claude-code',
        'models:claude-code:fork',
      ].sort(),
    )
  })

  it.each([
    [
      { provider: 'claude-code', model: 'claude-haiku-4-5' },
      ['account:claude-code', 'models:claude-code'],
    ],
    [{ provider: 'codex', model: 'gpt-5.6-luna' }, ['account:codex', 'models:codex']],
    [{ provider: 'grok', model: 'grok-4.6' }, ['account:grok', 'models:grok']],
  ] as const)('reads only the manual target %o', async (target, calls) => {
    const { title, started } = harness({ mode: 'manual', target })

    await title()

    expect(started).toEqual([{ provider: target.provider, model: target.model }])
    expect(vendor.calls).toEqual(calls)
  })

  it('reads only a manual custom harness target', async () => {
    const { title, started, customHarnesses } = harness({
      mode: 'manual',
      target: { provider: 'grok', agent: 'fork', model: 'grok-4.6' },
    })
    customHarnesses.upsert({
      id: 'fork',
      displayName: 'Grok fork',
      provider: 'grok',
      command: 'grok-fork',
      args: [],
    })
    vendor.models.set('grok:fork', [model('grok-4.6')])

    await title()

    expect(started).toEqual([{ provider: 'grok', model: 'grok-4.6', agent: 'fork' }])
    expect(vendor.calls).toEqual(['models:grok:fork'])
  })

  it('drafts a commit message from the same reduced reads', async () => {
    const { orchestrator, started } = harness({
      mode: 'manual',
      target: { provider: 'claude-code', model: 'claude-haiku-4-5' },
    })

    await expect(
      orchestrator.generateBackgroundCommitMessage({
        threadId: 'workspace',
        version: 'tree',
        files: [{ path: 'src/queue.ts', status: 'modified', binary: false, hunks: [] }],
      }),
    ).resolves.toBe('Generated title')

    expect(started).toEqual([{ provider: 'claude-code', model: 'claude-haiku-4-5' }])
    expect(vendor.calls).toEqual(['account:claude-code', 'models:claude-code'])
  })

  it('lists every source in Settings and shares each read with titles', async () => {
    const { orchestrator, title } = harness()

    await title()
    expect(vendor.calls).toEqual(['account:codex', 'models:codex'])
    const settings = await orchestrator.backgroundModelSettings()
    await title()

    expect(settings.sources.map((source) => source.id)).toEqual(['claude-code', 'codex', 'grok'])
    expect(settings.resolved).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna' })
    expect(vendor.calls.slice(2).sort()).toEqual(
      ['account:claude-code', 'models:claude-code', 'account:grok', 'models:grok'].sort(),
    )
  })

  it('reads again after the cached minute', async () => {
    const { title } = harness()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      await title()
      clock.mockReturnValue(now + 59_999)
      await title()
      clock.mockReturnValue(now + 60_000)
      await title()
    } finally {
      clock.mockRestore()
    }

    expect(vendor.calls).toEqual(['account:codex', 'models:codex', 'account:codex', 'models:codex'])
  })

  it('neither caches nor joins a read that an account change overtook', async () => {
    const { orchestrator, title, started } = harness()
    const releaseCodex = gate('account:codex')
    const releaseGrok = gate('account:grok')

    const first = title()
    await vi.waitFor(() => expect(vendor.calls).toEqual(['account:codex']), { timeout: 5_000 })
    await orchestrator.signOut('codex')
    const second = title()
    await vi.waitFor(() => expect(vendor.calls).toEqual(['account:codex', 'account:codex']), {
      timeout: 5_000,
    })
    releaseCodex()
    await first
    releaseGrok()
    await second
    await title()

    // The read that began before sign-out still answers its own request, but
    // nothing after the change sees it: Codex is read again and found signed out.
    // The two overlapped titles start in either order.
    expect(
      started.slice().sort((left, right) => left.provider.localeCompare(right.provider)),
    ).toEqual([
      { provider: 'codex', model: 'gpt-5.6-luna' },
      { provider: 'grok', model: 'grok-4.6' },
      { provider: 'grok', model: 'grok-4.6' },
    ])
    expect([...vendor.calls].sort()).toEqual(
      ['account:codex', 'account:codex', 'models:codex', 'account:grok', 'models:grok'].sort(),
    )
  })

  it('uses Grok when Codex Luna fails its background turn', async () => {
    const { title, started } = harness({ mode: 'automatic' }, (provider) =>
      provider === 'codex' ? 'turn' : undefined,
    )

    await expect(title()).resolves.toEqual({ title: 'Generated title', applied: true })

    expect(started).toEqual([
      { provider: 'codex', model: 'gpt-5.6-luna' },
      { provider: 'grok', model: 'grok-4.6' },
    ])
    expect(vendor.calls).toEqual(['account:codex', 'models:codex', 'account:grok', 'models:grok'])
  })

  it('rejects a manual target whose background turn fails', async () => {
    const { title, started } = harness(
      { mode: 'manual', target: { provider: 'codex', model: 'gpt-5.6-luna' } },
      (provider) => (provider === 'codex' ? 'turn' : undefined),
    )

    await expect(title()).rejects.toThrow('Background model turn failed.')
    expect(started).toEqual([{ provider: 'codex', model: 'gpt-5.6-luna' }])
    expect(vendor.calls).toEqual(['account:codex', 'models:codex'])
  })

  it('rejects with the last error after every automatic source fails once', async () => {
    const { title, started } = harness({ mode: 'automatic' }, (provider) => {
      return new Error(`${provider} background failed`)
    })

    await expect(title()).rejects.toThrow('claude-code background failed')
    expect(started).toEqual([
      { provider: 'codex', model: 'gpt-5.6-luna' },
      { provider: 'grok', model: 'grok-4.6' },
      { provider: 'claude-code', model: 'claude-haiku-4-5' },
    ])
    expect(vendor.calls).toEqual([
      'account:codex',
      'models:codex',
      'account:grok',
      'models:grok',
      'account:claude-code',
      'models:claude-code',
    ])
  })
})
