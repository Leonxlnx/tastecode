import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { DESIGN_BRIEF_ATTACHMENT } from '@harness/design-agent/attachment'
import { AccountNotFoundError, type AccountDirectory } from './account-directory.js'
import type { AgentSession, ProviderRuntime } from './adapters.js'
import { titlePrompt } from './background-model.js'
import { CustomHarnessStore } from './custom-harnesses.js'
import { McpConfigStore } from './mcp-config.js'
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
  readonly #prompts: string[]

  constructor(prompts: string[], failure?: Error | 'turn') {
    this.#prompts = prompts
    this.#failure = failure
  }

  async sendTurn(_threadId: string, text: string): Promise<string> {
    this.#prompts.push(text)
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

/** A chat's own session: it takes prompts, Design ones included, and never answers. */
class ChatSession implements AgentSession {
  readonly capabilities = { ...CAPABILITIES, images: true }
  readonly sent: string[] = []
  /** Holds the next prompt on its way to the provider until released. */
  hold: Promise<void> | undefined

  async sendTurn(_threadId: string, text: string): Promise<string> {
    this.sent.push(text)
    await this.hold
    return `chat-turn-${this.sent.length}`
  }

  async interrupt(): Promise<void> {}
  respondToApproval(): void {}
  dispose(): void {}
  on(): void {}
}

const roots: string[] = []
const active: Array<{ orchestrator: InstanceType<typeof Orchestrator>; store: Store }> = []

function harness(
  preference: BackgroundModelPreference = { mode: 'automatic' },
  failure?: (provider: ProviderId, agent: string | undefined) => Error | 'turn' | undefined,
  accounts?: AccountDirectory,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tastecode-background-sources-'))
  roots.push(root)
  const started: Array<{
    provider: ProviderId
    model: string | undefined
    agent?: string | undefined
    accountHome?: string
  }> = []
  /** What each background run was asked. */
  const prompts: string[] = []
  const chats: ChatSession[] = []
  const runtimeFor = (
    provider: ProviderId,
    _onLog: (line: string) => void,
    accountHome?: string,
  ): ProviderRuntime => ({
    async start(workspacePath, options) {
      // Background writing starts ephemeral sessions; anything else is a chat.
      if (!options.ephemeral) {
        const session = new ChatSession()
        chats.push(session)
        return {
          thread: { id: `chat-${chats.length}`, provider, workspacePath, createdAt: 0 },
          session,
        }
      }
      started.push({
        provider,
        model: options.model,
        agent: options.agent,
        ...(accountHome ? { accountHome } : {}),
      })
      return {
        thread: { id: 'background-thread', provider, workspacePath, createdAt: 0 },
        session: new TitleSession(prompts, failure?.(provider, options.agent)),
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
    // A chat start reads MCP settings; never the user's own.
    mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
    worktreeRoot: path.join(root, 'worktrees'),
    ...(accounts ? { accounts } : {}),
  })
  active.push({ orchestrator, store })
  let titles = 0
  const title = async (chat: { provider?: ProviderId; accountId?: string } = {}) => {
    titles += 1
    const threadId = `thread-${titles}`
    store.addThread({
      id: threadId,
      projectPath: root,
      provider: chat.provider ?? 'codex',
      ...(chat.accountId ? { accountId: chat.accountId } : {}),
      title: 'New chat',
    })
    return orchestrator.generateBackgroundTitle(threadId, 'Fix the queue order', 'New chat')
  }
  return { orchestrator, store, customHarnesses, started, prompts, chats, root, title }
}

function signIn(provider: ProviderId, models: Model[], account: Partial<Account> = {}): void {
  vendor.accounts.set(provider, { signedIn: true, ...account })
  vendor.models.set(provider, models)
}

function signedOut(provider: ProviderId): void {
  vendor.accounts.set(provider, { signedIn: false })
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
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('background title source discovery', () => {
  beforeEach(() => {
    signIn('claude-code', [model('claude-haiku-5-5', ['low', 'medium', 'high'])])
    signIn('codex', [model('gpt-5.6-luna')], { plan: 'Pro' })
    signIn('grok', [model('grok-4.6')])
  })

  it('reads only Claude Code when it offers Haiku', async () => {
    const { title, started } = harness()

    await expect(title()).resolves.toEqual({ title: 'Generated title', applied: true })

    expect(started).toEqual([{ provider: 'claude-code', model: 'claude-haiku-5-5' }])
    expect(vendor.calls).toEqual(['account:claude-code', 'models:claude-code'])
  })

  it.each(['claude-code', 'grok'] as const)(
    'leaves naming a %s chat to its provider and reads no source',
    async (provider) => {
      const { title, started, store } = harness()

      await expect(title({ provider })).resolves.toEqual({ title: 'New chat', applied: false })

      expect(started).toEqual([])
      expect(vendor.calls).toEqual([])
      expect(store.provisionalTitle('thread-1')).toBe('New chat')
    },
  )

  it('writes the title itself when the provider never named the chat', async () => {
    const { title, started, store, orchestrator } = harness()
    await title({ provider: 'claude-code' })
    expect(orchestrator.awaitsProviderTitle('thread-1')).toBe(true)

    await expect(orchestrator.nameUnnamedChat('thread-1')).resolves.toBe(true)

    expect(store.thread('thread-1')?.title).toBe('Generated title')
    expect(store.provisionalTitle('thread-1')).toBeUndefined()
    expect(started).toEqual([{ provider: 'claude-code', model: 'claude-haiku-5-5' }])
    expect(orchestrator.awaitsProviderTitle('thread-1')).toBe(false)
  })

  it("keeps the provider's name when it arrived first", async () => {
    const { title, started, store, orchestrator } = harness()
    await title({ provider: 'claude-code' })
    store.renameThread('thread-1', 'Queue order fix')

    expect(orchestrator.awaitsProviderTitle('thread-1')).toBe(false)
    await expect(orchestrator.nameUnnamedChat('thread-1')).resolves.toBe(false)

    expect(store.thread('thread-1')?.title).toBe('Queue order fix')
    expect(started).toEqual([])
  })

  it('reads Codex next, and only then, when Claude Code is signed out', async () => {
    signedOut('claude-code')
    const { title, started } = harness()

    await expect(title()).resolves.toEqual({ title: 'Generated title', applied: true })

    expect(started).toEqual([{ provider: 'codex', model: 'gpt-5.6-luna' }])
    expect(vendor.calls).toEqual(['account:claude-code', 'account:codex', 'models:codex'])
    expect(vendor.codexProcesses).toBe(1)
  })

  it('reads Grok next, and only then, when Codex has no subscription Luna', async () => {
    signedOut('claude-code')
    signIn('codex', [model('gpt-5.6-luna')], { plan: 'API key' })
    const { title, started } = harness()

    await title()

    expect(started).toEqual([{ provider: 'grok', model: 'grok-4.6' }])
    expect(vendor.calls).toEqual([
      'account:claude-code',
      'account:codex',
      'models:codex',
      'account:grok',
      'models:grok',
    ])
  })

  it('reads every source for the cheapest-model fallback and breaks ties by source order', async () => {
    signIn('claude-code', [model('claude-sonnet-5-5')])
    signIn('codex', [model('gpt-5.6-pro')], { plan: 'API key' })
    signIn('grok', [model('grok-4.5')])
    const { title, started, customHarnesses } = harness()
    for (const id of ['first', 'second']) {
      customHarnesses.upsert({
        id,
        displayName: `Claude ${id}`,
        provider: 'claude-code',
        command: `claude-${id}`,
        args: [],
      })
      vendor.models.set(`claude-code:${id}`, [model('claude-haiku-4-5')])
    }
    const release = gate('models:claude-code:first')

    const pending = title()
    await vi.waitFor(() => expect(vendor.calls).toContain('models:claude-code:second'), {
      timeout: 5_000,
    })
    await vi.waitFor(() => expect(vendor.calls).toContain('models:claude-code:first'), {
      timeout: 5_000,
    })
    release()
    await pending

    // The second harness answers first with the same model; the earlier one still wins.
    expect(started).toEqual([
      { provider: 'claude-code', model: 'claude-haiku-4-5', agent: 'first' },
    ])
    expect([...vendor.calls].sort()).toEqual(
      [
        'account:claude-code',
        'models:claude-code',
        'account:codex',
        'models:codex',
        'account:grok',
        'models:grok',
        'models:claude-code:first',
        'models:claude-code:second',
      ].sort(),
    )
  })

  it.each([
    [
      { provider: 'claude-code', model: 'claude-haiku-5-5' },
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
      target: { provider: 'claude-code', model: 'claude-haiku-5-5' },
    })

    await expect(
      orchestrator.generateBackgroundCommitMessage({
        threadId: 'workspace',
        version: 'tree',
        files: [{ path: 'src/queue.ts', status: 'modified', binary: false, hunks: [] }],
      }),
    ).resolves.toBe('Generated title')

    expect(started).toEqual([{ provider: 'claude-code', model: 'claude-haiku-5-5' }])
    expect(vendor.calls).toEqual(['account:claude-code', 'models:claude-code'])
  })

  it('lists every source in Settings and shares each read with titles', async () => {
    const { orchestrator, title } = harness()

    await title()
    expect(vendor.calls).toEqual(['account:claude-code', 'models:claude-code'])
    const settings = await orchestrator.backgroundModelSettings()
    await title()

    expect(settings.sources.map((source) => source.id)).toEqual(['claude-code', 'codex', 'grok'])
    expect(settings.resolved).toMatchObject({
      provider: 'claude-code',
      model: 'claude-haiku-5-5',
      effort: 'medium',
    })
    expect(vendor.calls.slice(2).sort()).toEqual(
      ['account:codex', 'models:codex', 'account:grok', 'models:grok'].sort(),
    )
  })

  it('reads the account again after the cached minute and the shared model list once it ages', async () => {
    signedOut('claude-code')
    const { title } = harness()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      await title()
      clock.mockReturnValue(now + 59_999)
      await title()
      clock.mockReturnValue(now + 60_000)
      await title()
      expect(vendor.calls).toEqual([
        'account:claude-code',
        'account:codex',
        'models:codex',
        'account:claude-code',
        'account:codex',
      ])
      // An older shared list still answers at once and is read again behind it.
      clock.mockReturnValue(now + 10 * 60_000)
      await title()
      await vi.waitFor(() => expect(vendor.calls).toHaveLength(8))
    } finally {
      clock.mockRestore()
    }

    expect(vendor.calls).toEqual([
      'account:claude-code',
      'account:codex',
      'models:codex',
      'account:claude-code',
      'account:codex',
      'account:claude-code',
      'account:codex',
      'models:codex',
    ])
  })

  it('neither caches nor joins a read that an account change overtook', async () => {
    signedOut('claude-code')
    const { orchestrator, title, started } = harness()
    const releaseCodex = gate('account:codex')
    const releaseGrok = gate('account:grok')

    const first = title()
    await vi.waitFor(() => expect(vendor.calls).toEqual(['account:claude-code', 'account:codex']), {
      timeout: 5_000,
    })
    await orchestrator.signOut('codex')
    const second = title()
    await vi.waitFor(
      () =>
        expect(vendor.calls).toEqual([
          'account:claude-code',
          'account:codex',
          'account:claude-code',
          'account:codex',
        ]),
      { timeout: 5_000 },
    )
    releaseCodex()
    await first
    releaseGrok()
    await second
    await title()

    // The read that began before sign-out still answers its own request, but
    // nothing after the change sees it: Codex is read again and found signed out.
    // The first two titles run at the same time, so either may start first.
    expect(started).toHaveLength(3)
    expect(started.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'codex', model: 'gpt-5.6-luna' }),
        expect.objectContaining({ provider: 'grok', model: 'grok-4.6' }),
      ]),
    )
    expect(started[2]).toMatchObject({ provider: 'grok', model: 'grok-4.6' })
    expect([...vendor.calls].sort()).toEqual(
      [
        'account:claude-code',
        'account:claude-code',
        'account:codex',
        'account:codex',
        'models:codex',
        'account:grok',
        'models:grok',
      ].sort(),
    )
  })

  it('uses Codex Luna when Claude Code Haiku fails its background turn', async () => {
    const { title, started } = harness({ mode: 'automatic' }, (provider) =>
      provider === 'claude-code' ? 'turn' : undefined,
    )

    await expect(title()).resolves.toEqual({ title: 'Generated title', applied: true })

    expect(started).toEqual([
      { provider: 'claude-code', model: 'claude-haiku-5-5' },
      { provider: 'codex', model: 'gpt-5.6-luna' },
    ])
    expect(vendor.calls).toEqual([
      'account:claude-code',
      'models:claude-code',
      'account:codex',
      'models:codex',
    ])
  })

  it('uses Grok when Codex Luna fails its background turn', async () => {
    signedOut('claude-code')
    const { title, started } = harness({ mode: 'automatic' }, (provider) =>
      provider === 'codex' ? 'turn' : undefined,
    )

    await expect(title()).resolves.toEqual({ title: 'Generated title', applied: true })

    expect(started).toEqual([
      { provider: 'codex', model: 'gpt-5.6-luna' },
      { provider: 'grok', model: 'grok-4.6' },
    ])
    expect(vendor.calls).toEqual([
      'account:claude-code',
      'account:codex',
      'models:codex',
      'account:grok',
      'models:grok',
    ])
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

    await expect(title()).rejects.toThrow('grok background failed')
    expect(started).toEqual([
      { provider: 'claude-code', model: 'claude-haiku-5-5' },
      { provider: 'codex', model: 'gpt-5.6-luna' },
      { provider: 'grok', model: 'grok-4.6' },
    ])
    expect(vendor.calls).toEqual([
      'account:claude-code',
      'models:claude-code',
      'account:codex',
      'models:codex',
      'account:grok',
      'models:grok',
    ])
  })
})

describe('a new chat whose provider would name it', () => {
  const request = 'A one-page website for "Seilbahn Kaffee", a coffee bar above Grindelwald'
  /** What the app titles the chat with at once: the start of the first prompt. */
  const standIn = 'A one-page website for "Seilbahn Kaffee"'

  beforeEach(() => {
    signIn('claude-code', [model('claude-haiku-5-5', ['low', 'medium', 'high'])])
    signIn('codex', [model('gpt-5.6-luna')], { plan: 'Pro' })
    signIn('grok', [model('grok-4.6')])
  })

  /** A chat started the way the app starts one, already showing its stand-in title. */
  async function newChat(provider: ProviderId) {
    const setup = harness()
    const { id } = await setup.orchestrator.startThread(provider, setup.root)
    setup.store.renameThread(id, standIn)
    return { ...setup, threadId: id, chat: setup.chats.at(-1)! }
  }

  /**
   * Sends the first prompt and asks for the title the way the app does: the
   * title request either follows the prompt or arrives while it is on its way.
   */
  async function sendAndTitle(
    { orchestrator, threadId, chat }: Awaited<ReturnType<typeof newChat>>,
    attachments: string[],
    onItsWay: boolean,
  ) {
    if (!onItsWay) {
      await orchestrator.submitTurn(threadId, request, attachments)
      return orchestrator.generateBackgroundTitle(threadId, request, standIn)
    }
    let release!: () => void
    chat.hold = new Promise<void>((resolve) => (release = resolve))
    const sending = orchestrator.submitTurn(threadId, request, attachments)
    const titling = orchestrator.generateBackgroundTitle(threadId, request, standIn)
    await vi.waitFor(() => expect(chat.sent).toHaveLength(1))
    release()
    await sending
    return titling
  }

  it.each([false, true])(
    'titles a Grok Design chat from the request, not its briefing (title asked on the way: %s)',
    async (onItsWay) => {
      const setup = await newChat('grok')
      const { orchestrator, store, threadId, chat, started, prompts } = setup

      await expect(sendAndTitle(setup, [DESIGN_BRIEF_ATTACHMENT], onItsWay)).resolves.toEqual({
        title: 'Generated title',
        applied: true,
      })

      // Grok got TasteCode's briefing, so its own name would describe that.
      expect(chat.sent).toHaveLength(1)
      expect(chat.sent[0]).not.toBe(request)
      expect(prompts).toEqual([titlePrompt(request)])
      expect(started).toEqual([{ provider: 'claude-code', model: 'claude-haiku-5-5' }])
      expect(store.thread(threadId)?.title).toBe('Generated title')
      // History puts the provider's name in place only of a stand-in.
      expect(store.provisionalTitle(threadId)).toBeUndefined()
      expect(orchestrator.awaitsProviderTitle(threadId)).toBe(false)
    },
  )

  it("titles a Grok chat from the request when a Design brief's preamble wraps its first prompt", async () => {
    const setup = await newChat('grok')
    mkdirSync(path.join(setup.root, '.taste'))
    writeFileSync(path.join(setup.root, '.taste', 'brief.json'), '{}')

    await expect(sendAndTitle(setup, [], false)).resolves.toEqual({
      title: 'Generated title',
      applied: true,
    })

    expect(setup.chat.sent[0]).toMatch(/^This is an ordinary user turn/)
    expect(setup.prompts).toEqual([titlePrompt(request)])
    expect(setup.store.provisionalTitle(setup.threadId)).toBeUndefined()
  })

  it.each([false, true])(
    "leaves a Grok chat that got the user's own words to its provider (title asked on the way: %s)",
    async (onItsWay) => {
      const setup = await newChat('grok')
      const { orchestrator, store, threadId, chat, started, prompts } = setup

      await expect(sendAndTitle(setup, [], onItsWay)).resolves.toEqual({
        title: standIn,
        applied: false,
      })

      expect(chat.sent).toEqual([request])
      expect(started).toEqual([])
      expect(prompts).toEqual([])
      expect(store.provisionalTitle(threadId)).toBe(standIn)
      expect(orchestrator.awaitsProviderTitle(threadId)).toBe(true)
    },
  )

  it('keeps the stand-in when the Design briefing goes out after the provider was left to name the chat', async () => {
    const { orchestrator, store, threadId, chat, started } = await newChat('grok')
    await expect(orchestrator.generateBackgroundTitle(threadId, request, standIn)).resolves.toEqual(
      { title: standIn, applied: false },
    )
    expect(store.provisionalTitle(threadId)).toBe(standIn)

    await orchestrator.submitTurn(threadId, request, [DESIGN_BRIEF_ATTACHMENT])

    expect(chat.sent).toHaveLength(1)
    expect(store.thread(threadId)?.title).toBe(standIn)
    expect(store.provisionalTitle(threadId)).toBeUndefined()
    expect(orchestrator.awaitsProviderTitle(threadId)).toBe(false)
    expect(started).toEqual([])
  })

  it.each([false, true])(
    'titles a Codex chat from the request as before (Design: %s)',
    async (design) => {
      const setup = await newChat('codex')

      await expect(
        sendAndTitle(setup, design ? [DESIGN_BRIEF_ATTACHMENT] : [], false),
      ).resolves.toEqual({
        title: 'Generated title',
        applied: true,
      })

      expect(setup.chat.sent).toHaveLength(1)
      expect(setup.prompts).toEqual([titlePrompt(request)])
      expect(setup.store.provisionalTitle(setup.threadId)).toBeUndefined()
    },
  )
})

describe('background writing for a chat on another account', () => {
  let workHome = ''
  const accounts: AccountDirectory = {
    home: (provider, accountId) => {
      if (accountId === undefined || accountId === 'default') return undefined
      if ((provider === 'codex' || provider === 'claude-code') && accountId === 'work')
        return workHome
      throw new AccountNotFoundError()
    },
    active: () => 'default',
  }

  beforeEach(() => {
    // Automatic writing tries Claude Code first; signed out, it reaches the Codex chats' own provider.
    signedOut('claude-code')
    signIn('codex', [model('gpt-5.6-luna')], { plan: 'Pro' })
    signIn('grok', [model('grok-4.6')])
    workHome = mkdtempSync(path.join(os.tmpdir(), 'tastecode-background-work-'))
    roots.push(workHome)
  })

  it("writes a Work chat's title through the Work account", async () => {
    const { title, started } = harness({ mode: 'automatic' }, undefined, accounts)

    await expect(title({ accountId: 'work' })).resolves.toEqual({
      title: 'Generated title',
      applied: true,
    })
    await title()

    expect(started).toEqual([
      { provider: 'codex', model: 'gpt-5.6-luna', accountHome: workHome },
      { provider: 'codex', model: 'gpt-5.6-luna' },
    ])
  })

  it('still writes a title for a Work Claude chat, whose own name history cannot read', async () => {
    signIn('claude-code', [model('claude-haiku-4-5')])
    const { title, started, store } = harness({ mode: 'automatic' }, undefined, accounts)

    await expect(title({ provider: 'claude-code', accountId: 'work' })).resolves.toEqual({
      title: 'Generated title',
      applied: true,
    })

    expect(started).toEqual([
      { provider: 'claude-code', model: 'claude-haiku-4-5', accountHome: workHome },
    ])
    expect(store.provisionalTitle('thread-1')).toBeUndefined()
  })

  it("drafts a Work chat's commit message through the Work account", async () => {
    const { orchestrator, store, started } = harness({ mode: 'automatic' }, undefined, accounts)
    store.addThread({
      id: 'work-chat',
      projectPath: os.tmpdir(),
      provider: 'codex',
      accountId: 'work',
      title: 'Queue',
    })
    const diff = {
      threadId: 'workspace',
      version: 'tree',
      files: [{ path: 'src/queue.ts', status: 'modified' as const, binary: false, hunks: [] }],
    }

    await orchestrator.generateBackgroundCommitMessage(diff, 'work-chat')
    // The project's own checkout names no chat, so it stays on the default account.
    await orchestrator.generateBackgroundCommitMessage(diff)

    expect(started).toEqual([
      { provider: 'codex', model: 'gpt-5.6-luna', accountHome: workHome },
      { provider: 'codex', model: 'gpt-5.6-luna' },
    ])
  })

  it("keeps another provider's source on that provider's own sign-in", async () => {
    signIn('codex', [model('gpt-5.6-luna')], { plan: 'API key' })
    const { title, started } = harness({ mode: 'automatic' }, undefined, accounts)

    await title({ accountId: 'work' })

    expect(started).toEqual([{ provider: 'grok', model: 'grok-4.6' }])
  })

  it("writes a Work Codex chat's title through Claude Code's own sign-in when it comes first", async () => {
    signIn('claude-code', [model('claude-haiku-4-5')])
    const { title, started } = harness({ mode: 'automatic' }, undefined, accounts)

    await title({ accountId: 'work' })

    expect(started).toEqual([{ provider: 'claude-code', model: 'claude-haiku-4-5' }])
  })

  it('refuses rather than writing through the default account once the account is removed', async () => {
    const { title, started } = harness({ mode: 'automatic' }, undefined, accounts)

    await expect(title({ accountId: 'gone' })).rejects.toThrow('The account this chat ran on')
    expect(started).toEqual([])
  })
})
