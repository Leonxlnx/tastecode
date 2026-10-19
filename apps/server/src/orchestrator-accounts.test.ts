import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AccountId,
  Model,
  ProviderId,
  ProviderLimit,
  ProviderLimitSource,
} from '@harness/contracts'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AccountNotFoundError, type AccountDirectory } from './account-directory.js'
import type { AgentSession, ProviderRuntime } from './adapters.js'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'

type LoginResult = { loginId: string; success: boolean; error: string | null }

/** What Claude's own sign-in calls were asked to run as, by folder. */
const claude = vi.hoisted(() => ({
  calls: [] as string[][],
  complete: undefined as ((result: LoginResult) => void) | undefined,
}))

vi.mock('@harness/adapter-claude-code', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-claude-code')>()
  return {
    ...original,
    claudeAccount: async (options?: { accountHome?: string }) => {
      claude.calls.push(['account', options?.accountHome ?? 'default'])
      return {
        signedIn: true,
        email: options?.accountHome ? 'work@example.test' : 'me@example.test',
      }
    },
    startClaudeLogin: (
      complete: (result: LoginResult) => void,
      options?: { accountHome?: string },
    ) => {
      claude.calls.push(['login', options?.accountHome ?? 'default'])
      claude.complete = complete
      return { loginId: 'login-1', cancel: async () => {} }
    },
    signOutClaude: async (options?: { accountHome?: string }) => {
      claude.calls.push(['signOut', options?.accountHome ?? 'default'])
    },
    claudeLimitSource: async (options?: { accountHome?: string }) => {
      claude.calls.push(['limits', options?.accountHome ?? 'default'])
      const usedPercent = options?.accountHome ? 70 : 10
      return { status: 'ready', limits: [{ id: 'seven_day', label: 'Weekly', usedPercent }] }
    },
  }
})

const root = mkdtempSync(path.join(os.tmpdir(), 'harness-orchestrator-accounts-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const workHome = path.join(root, 'codex-work')
mkdirSync(workHome)
const claudeHome = path.join(root, 'claude-work')
mkdirSync(claudeHome)

/** A registry with the given folders by `provider:id`; anything else is gone. */
function directory(
  homes: Record<string, string>,
  active: Partial<Record<ProviderId, AccountId>> = {},
): AccountDirectory {
  return {
    home: (provider, accountId) => {
      if (accountId === undefined || accountId === 'default') return undefined
      const home = homes[`${provider}:${accountId}`]
      if (home === undefined) throw new AccountNotFoundError()
      return home
    },
    active: (provider) => active[provider] ?? 'default',
  }
}

/** The newest session's live usage and limit listeners. */
type Live = { limits?: (limits: ProviderLimit[]) => void; usage?: () => void }

type FakeSession = AgentSession & { disposed: boolean }

function session(live: Live): FakeSession {
  const created: FakeSession = {
    disposed: false,
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
    dispose: () => {
      created.disposed = true
    },
    on: () => {},
    onLimitsUpdated: (listener) => {
      live.limits = listener
    },
    onUsageChanged: (listener) => {
      live.usage = listener
    },
  }
  return created
}

function model(id: string): Model {
  return { id, displayName: id, isDefault: true, reasoningEfforts: [] }
}

type Launch = { kind: 'start' | 'resume'; provider: ProviderId; accountHome: string | undefined }

function setup(accounts: AccountDirectory, store = new Store(':memory:')) {
  const launches: Launch[] = []
  const live: Live = {}
  const sessions: FakeSession[] = []
  /** Each model list read, by the folder it ran in. */
  const listed: Array<string | undefined> = []
  const opened = () => {
    const created = session(live)
    sessions.push(created)
    return created
  }
  const pushed = {
    logins: [] as unknown[][],
    usage: [] as unknown[][],
    limits: [] as ProviderLimitSource[],
  }
  let started = 0
  const runtimeFor = (
    provider: ProviderId,
    _onLog: (line: string) => void,
    accountHome?: string,
  ): ProviderRuntime => ({
    async start(workspacePath) {
      launches.push({ kind: 'start', provider, accountHome })
      started += 1
      return {
        thread: { id: `${provider}-${started}`, provider, workspacePath, createdAt: Date.now() },
        session: opened(),
      }
    },
    async resume(threadId, workspacePath) {
      launches.push({ kind: 'resume', provider, accountHome })
      return {
        thread: { id: threadId, provider, workspacePath, createdAt: Date.now() },
        session: opened(),
      }
    },
    async listModels() {
      listed.push(accountHome)
      return [model(accountHome ? 'work-model' : 'default-model')]
    },
  })
  const orchestrator = new Orchestrator(store, {
    onEvent: () => {},
    onLog: () => {},
    onLogin: (provider, result, accountId) =>
      pushed.logins.push([provider, result.success, accountId]),
    onUsageChanged: (provider, accountId) => pushed.usage.push([provider, accountId]),
    onLimitsChanged: (source) => pushed.limits.push(source),
    runtimeFor,
    accounts,
    mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
  })
  return { orchestrator, launches, store, live, pushed, sessions, listed }
}

describe('chats pinned to a provider account', () => {
  it("starts a chat in its account's folder and resumes it only there", async () => {
    const accounts = directory({ 'codex:work': workHome })
    const first = setup(accounts)
    const thread = await first.orchestrator.startThread('codex', root, { accountId: 'work' })

    expect(thread.accountId).toBe('work')
    expect(first.launches).toEqual([{ kind: 'start', provider: 'codex', accountHome: workHome }])
    expect(first.store.thread(thread.id)?.accountId).toBe('work')
    await first.orchestrator.disposeAll()

    // After a restart the chat comes back in the same folder, whatever is active now.
    const second = setup(directory({ 'codex:work': workHome }, { codex: 'default' }), first.store)
    // Changing a chat's access level reopens it without starting a turn.
    await second.orchestrator.setThreadApproval(thread.id, 'ask')
    expect(second.launches).toEqual([{ kind: 'resume', provider: 'codex', accountHome: workHome }])
    await second.orchestrator.disposeAll()
  })

  it("pins a chat without a chosen account to the provider's active one", async () => {
    const { orchestrator, launches, store } = setup(
      directory({ 'codex:work': workHome }, { codex: 'work' }),
    )
    const onWork = await orchestrator.startThread('codex', root)
    // The default account passes no folder and stores nothing.
    const onDefault = await orchestrator.startThread('claude-code', root)

    expect(store.thread(onWork.id)?.accountId).toBe('work')
    expect(store.thread(onDefault.id)?.accountId).toBeUndefined()
    expect(onDefault.accountId).toBeUndefined()
    expect(launches.map((launch) => launch.accountHome)).toEqual([workHome, undefined])
    await orchestrator.disposeAll()
  })

  it('runs Side chat as the main chat account', async () => {
    const { orchestrator, launches, store } = setup(directory({ 'codex:work': workHome }))
    const main = await orchestrator.startThread('codex', root, { accountId: 'work' })
    // Side chat opens on a conversation that has a question in it.
    store.append(main.id, {
      type: 'item.completed',
      item: {
        id: 'question',
        turnId: 'turn-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'Main question',
        createdAt: 1,
      },
    })
    const side = await orchestrator.startSideThread(main.id)

    expect(side.accountId).toBe('work')
    expect(store.thread(side.id)?.accountId).toBe('work')
    expect(launches.map((launch) => launch.accountHome)).toEqual([workHome, workHome])
    await orchestrator.disposeAll()
  })

  it('keeps a custom harness on its own sign-in', async () => {
    const { orchestrator, launches } = setup(
      directory({ 'codex:work': workHome }, { codex: 'work' }),
    )
    await expect(
      orchestrator.startThread('codex', root, { agent: 'wrapper', accountId: 'work' }),
    ).rejects.toThrow('A custom harness runs with its own sign-in, not as another account.')
    const thread = await orchestrator.startThread('codex', root, { agent: 'wrapper' })

    expect(thread.accountId).toBeUndefined()
    expect(launches).toEqual([{ kind: 'start', provider: 'codex', accountHome: undefined }])
    await orchestrator.disposeAll()
  })

  it('refuses an account that is gone or whose folder is missing', async () => {
    const missing = path.join(root, 'moved-away')
    const { orchestrator, launches } = setup(
      directory({ 'codex:work': workHome, 'codex:moved': missing }),
    )
    await expect(orchestrator.startThread('codex', root, { accountId: 'other' })).rejects.toThrow(
      'That account does not exist any more.',
    )
    await expect(orchestrator.startThread('codex', root, { accountId: 'moved' })).rejects.toThrow(
      `This account's folder is missing (${missing}). Put it back, or remove the account.`,
    )
    expect(launches).toEqual([])
    await orchestrator.disposeAll()
  })

  it('says why a chat on a removed account cannot continue', async () => {
    const first = setup(directory({ 'codex:work': workHome }))
    const thread = await first.orchestrator.startThread('codex', root, { accountId: 'work' })
    await first.orchestrator.disposeAll()

    const second = setup(directory({}), first.store)
    await expect(second.orchestrator.setThreadApproval(thread.id, 'ask')).rejects.toThrow(
      'The account this chat ran on was removed, so the chat cannot continue. Start a new chat.',
    )
    expect(second.launches).toEqual([])
    await second.orchestrator.disposeAll()
  })
})

describe('sign-in, model lists and limits per account', () => {
  it('signs each account in and out in its own folder', async () => {
    claude.calls.length = 0
    const { orchestrator, pushed } = setup(directory({ 'claude-code:work': claudeHome }))
    await expect(orchestrator.account('claude-code', undefined, 'work')).resolves.toMatchObject({
      email: 'work@example.test',
    })
    await expect(orchestrator.account('claude-code')).resolves.toMatchObject({
      email: 'me@example.test',
    })
    await orchestrator.startLogin('claude-code', 'work')
    claude.complete?.({ loginId: 'login-1', success: true, error: null })
    await vi.waitFor(() => expect(pushed.logins).toEqual([['claude-code', true, 'work']]))
    await orchestrator.signOut('claude-code', undefined, 'work')

    expect(claude.calls).toEqual([
      ['account', claudeHome],
      ['account', 'default'],
      ['login', claudeHome],
      ['signOut', claudeHome],
    ])
    await orchestrator.disposeAll()
  })

  it('keeps model lists apart per account', async () => {
    const { orchestrator } = setup(directory({ 'claude-code:work': claudeHome }))
    const ids = (models: Model[]) => models.map((each) => each.id)

    expect(ids(await orchestrator.listModels('claude-code', undefined, 'work'))).toEqual([
      'work-model',
    ])
    expect(ids(await orchestrator.listModels('claude-code'))).toEqual(['default-model'])
    await expect(orchestrator.listModels('claude-code', 'wrapper', 'work')).rejects.toThrow(
      'A custom harness runs with its own sign-in, not as another account.',
    )
    await orchestrator.disposeAll()
  })

  it("keeps a chat's live limits and usage on its account", async () => {
    const { orchestrator, pushed, live } = setup(directory({ 'claude-code:work': claudeHome }))
    await orchestrator.startThread('claude-code', root, { accountId: 'work' })
    const fiveHour = { id: 'five_hour', label: '5-hour', usedPercent: 40 }
    live.limits?.([fiveHour])
    live.usage?.()

    expect(pushed.limits).toEqual([
      expect.objectContaining({ provider: 'claude-code', accountId: 'work', limits: [fiveHour] }),
    ])
    expect(pushed.usage.length).toBeGreaterThan(0)
    expect(pushed.usage.every(([, accountId]) => accountId === 'work')).toBe(true)
    expect(orchestrator.heldLimitSource('claude-code', 'visible', 'work')).toMatchObject({
      accountId: 'work',
      limits: [fiveHour],
    })
    // The default account's figures are untouched.
    expect(orchestrator.heldLimitSource('claude-code', 'visible')).toBeUndefined()
    await orchestrator.disposeAll()
  })

  it('spends a reset credit only through the account asked for', async () => {
    const { orchestrator } = setup(directory({ 'claude-code:work': claudeHome }))
    const key = () => crypto.randomUUID()
    // Claude earns no reset credits; the request reached the Work account's own controls.
    await expect(
      orchestrator.consumeRateLimitReset('claude-code', key(), undefined, 'work'),
    ).rejects.toThrow('provider "claude-code" cannot consume a rate-limit reset')
    await expect(
      orchestrator.consumeRateLimitReset('codex', key(), undefined, 'gone'),
    ).rejects.toBeInstanceOf(AccountNotFoundError)
    await orchestrator.disposeAll()
  })
})

describe("an account's saved limits and model lists", () => {
  it('answer after a restart and stay apart from the default account', async () => {
    claude.calls.length = 0
    const store = new Store(':memory:')
    store.addProviderAccount({
      provider: 'claude-code',
      id: 'work',
      label: 'Work',
      managed: true,
      createdAt: 1,
    })
    const accounts = directory({ 'claude-code:work': claudeHome })
    const first = setup(accounts, store)
    await first.orchestrator.usageLimitSource('claude-code', 'visible', 'work')
    await first.orchestrator.listModels('claude-code', undefined, 'work')
    await first.orchestrator.disposeAll()

    const second = setup(accounts, store)
    expect(second.orchestrator.heldLimitSource('claude-code', 'visible', 'work')).toMatchObject({
      accountId: 'work',
      limits: [{ id: 'seven_day', usedPercent: 70 }],
    })
    // The default account has read nothing, so it shows nothing of the other one.
    expect(second.orchestrator.heldLimitSource('claude-code', 'visible')).toBeUndefined()
    expect(store.limitSnapshot()).toBeUndefined()
    const models = await second.orchestrator.listModels('claude-code', undefined, 'work')
    expect(models.map((each) => each.id)).toEqual(['work-model'])
    expect(second.listed).toEqual([])
    expect(claude.calls).toEqual([['limits', claudeHome]])
    await second.orchestrator.disposeAll()
  })
})

describe('removing an account', () => {
  it("stops the account's chats and controls, and its chats cannot go on after it", async () => {
    claude.calls.length = 0
    const accounts = directory({ 'claude-code:work': claudeHome })
    let removed = false
    const { orchestrator, sessions } = setup({
      ...accounts,
      home: (provider, accountId) => {
        if (removed && accountId === 'work') throw new AccountNotFoundError()
        return accounts.home(provider, accountId)
      },
    })
    const thread = await orchestrator.startThread('claude-code', root, { accountId: 'work' })
    await orchestrator.account('claude-code', undefined, 'work')

    await orchestrator.releaseAccount('claude-code', 'work')
    expect(sessions[0]?.disposed).toBe(true)
    // Nothing the account had read was kept.
    await orchestrator.account('claude-code', undefined, 'work')
    expect(claude.calls).toEqual([
      ['account', claudeHome],
      ['account', claudeHome],
    ])

    // Once the registry dropped it, the chat says why it cannot go on.
    removed = true
    await expect(orchestrator.setThreadApproval(thread.id, 'ask')).rejects.toThrow(
      'The account this chat ran on was removed, so the chat cannot continue. Start a new chat.',
    )
    await orchestrator.disposeAll()
  })

  it('keeps an account while a chat on it still has work waiting', async () => {
    const { orchestrator, store, sessions } = setup(directory({ 'claude-code:work': claudeHome }))
    const thread = await orchestrator.startThread('claude-code', root, { accountId: 'work' })
    store.enqueueQueuedTurn({
      id: 'queued',
      threadId: thread.id,
      text: 'next',
      attachments: [],
      options: {},
      createdAt: 1,
      channel: 'main',
    })

    await expect(orchestrator.releaseAccount('claude-code', 'work')).rejects.toThrow(
      'A chat on this account is still working. Stop it first, then remove the account.',
    )
    expect(sessions[0]?.disposed).toBe(false)
    await orchestrator.disposeAll()
  })
})
