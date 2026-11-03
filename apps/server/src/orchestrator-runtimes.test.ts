import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderId } from '@harness/contracts'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AccountNotFoundError, type AccountDirectory } from './account-directory.js'
import type { AgentSession, ProviderRuntime } from './adapters.js'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { runtimeForLaunch, validateRuntime } from './provider-runtimes.js'
import { Store } from './store.js'

/** What each Claude limit read was asked to start with. */
const limitReads = vi.hoisted(() => [] as unknown[])

vi.mock('@harness/adapter-claude-code', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-claude-code')>()
  return {
    ...original,
    claudeAccount: async () => ({ signedIn: true, email: 'me@example.test' }),
    claudeLimitSource: async (options?: unknown) => {
      limitReads.push(options ?? {})
      return { status: 'ready', limits: [{ id: 'seven_day', label: 'Weekly', usedPercent: 10 }] }
    },
  }
})

const root = mkdtempSync(path.join(os.tmpdir(), 'harness-orchestrator-runtimes-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function session(): AgentSession {
  return {
    capabilities: {
      steer: false,
      fork: false,
      interrupt: true,
      reasoningItems: false,
      approvals: false,
      images: false,
    },
    sendTurn: async () => 'turn-1',
    interrupt: async () => {},
    respondToApproval: () => {},
    dispose: () => {},
    on: () => {},
  }
}

const personalHome = path.join(root, 'claude-personal')
mkdirSync(personalHome)
const workHome = path.join(root, 'claude-work')
mkdirSync(workHome)
const accountHomes = new Map([
  ['personal', personalHome],
  ['work', workHome],
])

/** Two further Claude Code accounts; anything else is gone. */
const twoAccounts: AccountDirectory = {
  home(provider, accountId) {
    if (accountId === undefined || accountId === 'default') return undefined
    const home = provider === 'claude-code' ? accountHomes.get(accountId) : undefined
    if (home === undefined) throw new AccountNotFoundError()
    return home
  },
  active: () => 'default',
}

function setup(store = new Store(':memory:'), accounts?: AccountDirectory) {
  /** The runtime each launch and model list was given, in order. */
  const runtimes: Array<{ kind: 'start' | 'resume' | 'models'; runtime: string | undefined }> = []
  let started = 0
  const runtimeFor = (provider: ProviderId): ProviderRuntime => ({
    async start(workspacePath, options) {
      runtimes.push({ kind: 'start', runtime: options.runtime })
      started += 1
      return {
        thread: { id: `${provider}-${started}`, provider, workspacePath, createdAt: Date.now() },
        session: session(),
      }
    },
    async resume(threadId, workspacePath, options) {
      runtimes.push({ kind: 'resume', runtime: options.runtime })
      return {
        thread: { id: threadId, provider, workspacePath, createdAt: Date.now() },
        session: session(),
      }
    },
    async listModels(_agent, _read, launch) {
      runtimes.push({ kind: 'models', runtime: launch?.runtime })
      return [{ id: 'opus', displayName: 'Opus', isDefault: true, reasoningEfforts: [] }]
    },
  })
  const orchestrator = new Orchestrator(store, {
    onEvent: () => {},
    onLog: () => {},
    runtimeFor,
    mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
    worktreeRoot: path.join(root, 'trees'),
    ...(accounts ? { accounts } : {}),
  })
  return { orchestrator, runtimes, store }
}

describe('provider runtimes', () => {
  it('keeps the default out of launches and drops a runtime no longer declared', () => {
    expect(runtimeForLaunch('claude-code', undefined)).toBeUndefined()
    expect(runtimeForLaunch('claude-code', 'sdk')).toBeUndefined()
    expect(runtimeForLaunch('claude-code', 'cli')).toBe('cli')
    expect(runtimeForLaunch('claude-code', 'retired')).toBeUndefined()
    expect(runtimeForLaunch('codex', 'cli')).toBeUndefined()
  })

  it('refuses a runtime the provider never declared', () => {
    expect(() => validateRuntime('claude-code', 'cli')).not.toThrow()
    expect(() => validateRuntime('claude-code', null)).not.toThrow()
    expect(() => validateRuntime('claude-code', 'retired')).toThrow(
      'This provider cannot run through "retired".',
    )
    expect(() => validateRuntime('codex', 'cli')).toThrow('This provider cannot run through "cli".')
  })

  it('starts Claude chats, model lists and limit reads through the chosen runtime', async () => {
    const { orchestrator, runtimes } = setup()
    expect(orchestrator.runtimeSettings()).toEqual({})
    expect(orchestrator.updateRuntimeSettings('claude-code', 'cli')).toEqual({
      'claude-code': 'cli',
    })

    await orchestrator.listModels('claude-code')
    await orchestrator.startThread('claude-code', root)
    await orchestrator.usageLimitSource('claude-code', 'visible')
    expect(runtimes).toEqual([
      { kind: 'models', runtime: 'cli' },
      { kind: 'start', runtime: 'cli' },
    ])
    expect(limitReads.at(-1)).toEqual({ runtime: 'cli' })

    // Back on the default, launches carry no runtime at all.
    expect(orchestrator.updateRuntimeSettings('claude-code', null)).toEqual({})
    await orchestrator.startThread('claude-code', root)
    expect(runtimes.at(-1)).toEqual({ kind: 'start', runtime: undefined })
    await orchestrator.disposeAll()
  })

  it('leaves other providers and custom harnesses on their own engine', async () => {
    const { orchestrator, runtimes } = setup()
    orchestrator.updateRuntimeSettings('claude-code', 'cli')
    expect(() => orchestrator.updateRuntimeSettings('codex', 'cli')).toThrow(
      'This provider cannot run through "cli".',
    )
    await orchestrator.startThread('codex', root)
    await orchestrator.startThread('claude-code', root, { agent: 'wrapper' })
    expect(runtimes).toEqual([
      { kind: 'start', runtime: undefined },
      { kind: 'start', runtime: undefined },
    ])
    await orchestrator.disposeAll()
  })

  it("runs each account through its own runtime, not another account's", async () => {
    const { orchestrator, runtimes } = setup(new Store(':memory:'), twoAccounts)
    const started = async (accountId?: string) => {
      await orchestrator.startThread(
        'claude-code',
        root,
        accountId === undefined ? {} : { accountId },
      )
      return runtimes.at(-1)?.runtime
    }

    // The default account's choice reaches no further account.
    orchestrator.updateRuntimeSettings('claude-code', 'cli')
    expect(await started()).toBe('cli')
    expect(await started('personal')).toBeUndefined()
    expect(await started('work')).toBeUndefined()

    // A further account's choice reaches neither the default account nor another further one.
    orchestrator.updateRuntimeSettings('claude-code', null)
    expect(orchestrator.updateAccountRuntimeSetting('claude-code', 'personal', 'cli')).toEqual([
      { provider: 'claude-code', accountId: 'personal', runtime: 'cli' },
    ])
    expect(await started('personal')).toBe('cli')
    expect(await started('work')).toBeUndefined()
    expect(await started()).toBeUndefined()

    // Back on the default, it stores and launches nothing.
    expect(orchestrator.updateAccountRuntimeSetting('claude-code', 'personal', null)).toEqual([])
    expect(await started('personal')).toBeUndefined()
    await orchestrator.disposeAll()
  })

  it("reads an account's model lists and limits through that account's runtime", async () => {
    const { orchestrator, runtimes } = setup(new Store(':memory:'), twoAccounts)
    orchestrator.updateAccountRuntimeSetting('claude-code', 'personal', 'cli')

    await orchestrator.listModels('claude-code', undefined, 'personal')
    expect(runtimes.at(-1)).toEqual({ kind: 'models', runtime: 'cli' })
    await orchestrator.usageLimitSource('claude-code', 'visible', 'personal')
    expect(limitReads.at(-1)).toEqual({ runtime: 'cli', accountHome: personalHome })

    await orchestrator.listModels('claude-code', undefined, 'work')
    expect(runtimes.at(-1)).toEqual({ kind: 'models', runtime: undefined })
    await orchestrator.usageLimitSource('claude-code', 'visible', 'work')
    expect(limitReads.at(-1)).toEqual({ accountHome: workHome })
    await orchestrator.disposeAll()
  })

  it("resumes an account's chat through that account's runtime", async () => {
    const first = setup(new Store(':memory:'), twoAccounts)
    const thread = await first.orchestrator.startThread('claude-code', root, {
      accountId: 'personal',
    })
    await first.orchestrator.disposeAll()

    const second = setup(first.store, twoAccounts)
    second.orchestrator.updateRuntimeSettings('claude-code', 'cli')
    await second.orchestrator.setThreadApproval(thread.id, 'ask')
    expect(second.runtimes).toEqual([{ kind: 'resume', runtime: undefined }])
    await second.orchestrator.disposeAll()

    const third = setup(first.store, twoAccounts)
    third.orchestrator.updateAccountRuntimeSetting('claude-code', 'personal', 'cli')
    await third.orchestrator.setThreadApproval(thread.id, 'full')
    expect(third.runtimes).toEqual([{ kind: 'resume', runtime: 'cli' }])
    await third.orchestrator.disposeAll()
  })

  it('refuses a runtime for the default account, a gone account or an undeclared id', () => {
    const { orchestrator } = setup(new Store(':memory:'), twoAccounts)
    expect(() => orchestrator.updateAccountRuntimeSetting('claude-code', 'default', 'cli')).toThrow(
      "The default account uses its provider's runtime setting.",
    )
    expect(() => orchestrator.updateAccountRuntimeSetting('claude-code', 'gone', 'cli')).toThrow(
      AccountNotFoundError,
    )
    expect(() =>
      orchestrator.updateAccountRuntimeSetting('claude-code', 'personal', 'retired'),
    ).toThrow('This provider cannot run through "retired".')
    expect(orchestrator.accountRuntimeSettings()).toEqual([])
  })

  it('reopens a chat after a restart through the runtime chosen now', async () => {
    const first = setup()
    const thread = await first.orchestrator.startThread('claude-code', root)
    await first.orchestrator.disposeAll()

    const second = setup(first.store)
    second.orchestrator.updateRuntimeSettings('claude-code', 'cli')
    // Changing a chat's access level reopens it without starting a turn.
    await second.orchestrator.setThreadApproval(thread.id, 'ask')
    expect(second.runtimes).toEqual([{ kind: 'resume', runtime: 'cli' }])
    await second.orchestrator.disposeAll()
  })
})
