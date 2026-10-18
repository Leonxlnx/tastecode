import { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { runCli, spawnCli } from '@harness/proc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_ACCOUNT_HOME, claudeAccountEnvironment, withClaudeAccount } from './account-home.js'
import { ClaudeCodeAdapter } from './adapter.js'
import { claudeAccount, signOutClaude, startClaudeLogin } from './auth.js'
import { CLAUDE_CAPABILITIES } from './capabilities.js'
import { discoverClaudeProject } from './discovery.js'
import { claudeLimitSource } from './limits.js'

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(),
  killTree: vi.fn(async () => undefined),
}))

class FakeChild extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
}

/** Answers what a chat, a model list, a limit read and a discovery ask; records their options. */
function recordingQuery() {
  const inputs: Options[] = []
  const createQuery = (input: { options: Options }): never => {
    inputs.push(input.options)
    let closed = false
    const waiting: Array<(result: IteratorResult<never>) => void> = []
    const done = { value: undefined as never, done: true as const }
    return {
      supportedModels: async () => [],
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: false,
        rate_limits: null,
      }),
      initializationResult: async () => ({ commands: [] }),
      mcpServerStatus: async () => [],
      supportedCommands: async () => [],
      setPermissionMode: async () => undefined,
      close: () => {
        closed = true
        for (const resolve of waiting.splice(0)) resolve(done)
      },
      [Symbol.asyncIterator]: () => ({
        next: () =>
          closed ? Promise.resolve(done) : new Promise((resolve) => waiting.push(resolve)),
      }),
    } as never
  }
  return { inputs, createQuery }
}

const home = path.join(os.tmpdir(), 'tastecode-accounts', 'claude-code', 'work')

afterEach(() => {
  vi.mocked(spawnCli).mockReset()
})

describe('Claude account homes', () => {
  it('selects an account folder with CLAUDE_CONFIG_DIR and leaves the default account alone', () => {
    expect(CLAUDE_CAPABILITIES.multipleAccounts).toBe(true)
    expect(CLAUDE_ACCOUNT_HOME.environment(home)).toEqual({ CLAUDE_CONFIG_DIR: home })
    expect(claudeAccountEnvironment(undefined)).toEqual({})
    const base = { PATH: 'bin', CLAUDE_CONFIG_DIR: 'default' }
    expect(withClaudeAccount(base, undefined)).toBe(base)
    expect(withClaudeAccount(base, home)).toEqual({ PATH: 'bin', CLAUDE_CONFIG_DIR: home })
  })

  it("names the CLI's own folder as the default one and seeds settings only", () => {
    expect(CLAUDE_ACCOUNT_HOME.defaultHome({ CLAUDE_CONFIG_DIR: home })).toBe(home)
    expect(CLAUDE_ACCOUNT_HOME.defaultHome({})).toBe(path.join(os.homedir(), '.claude'))
    expect(CLAUDE_ACCOUNT_HOME.seedFiles).toEqual(['settings.json'])
  })

  it("checks the account's sign-in and reads its plan tier from its own folder", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'harness-claude-account-'))
    try {
      writeFileSync(
        path.join(folder, '.claude.json'),
        JSON.stringify({ oauthAccount: { userRateLimitTier: 'default_claude_max_5x' } }),
      )
      const run = vi.fn<typeof runCli>().mockResolvedValue({
        code: 0,
        stdout: '{"loggedIn":true,"subscriptionType":"max"}',
      })
      await expect(claudeAccount({ run, accountHome: folder })).resolves.toEqual({
        signedIn: true,
        plan: 'Max x5',
      })
      expect(run).toHaveBeenCalledWith('claude', ['auth', 'status'], 20_000, {
        env: { CLAUDE_CONFIG_DIR: folder },
      })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('signs in and out in the account folder only', async () => {
    vi.mocked(spawnCli).mockReturnValue(new FakeChild() as ReturnType<typeof spawnCli>)
    startClaudeLogin(() => undefined, { accountHome: home })
    expect(spawnCli).toHaveBeenCalledWith('claude', ['auth', 'login'], {
      env: { CLAUDE_CONFIG_DIR: home },
    })
    startClaudeLogin(() => undefined)
    expect(spawnCli).toHaveBeenLastCalledWith('claude', ['auth', 'login'])

    const run = vi.fn<typeof runCli>().mockResolvedValue({ code: 0, stdout: '' })
    await signOutClaude({ accountHome: home, run })
    expect(run).toHaveBeenCalledWith('claude', ['auth', 'logout'], 15_000, {
      env: { CLAUDE_CONFIG_DIR: home },
    })
    await signOutClaude({ run })
    expect(run).toHaveBeenLastCalledWith('claude', ['auth', 'logout'], 15_000)
  })

  it("runs chats, model lists, limit reads and discovery in the account's folder", async () => {
    const { inputs, createQuery } = recordingQuery()
    const base = { PATH: 'bin', CLAUDE_CONFIG_DIR: 'default' }
    const adapter = new ClaudeCodeAdapter({ createQuery, environment: base, accountHome: home })
    try {
      await adapter.startThread(os.tmpdir())
      await adapter.listModels()
    } finally {
      await adapter.dispose()
    }
    await claudeLimitSource({ createQuery, environment: base, accountHome: home })
    await discoverClaudeProject(os.tmpdir(), {
      createQuery,
      environment: base,
      accountHome: home,
      settleMs: 0,
    })

    expect(inputs.map((options) => options.env?.['CLAUDE_CONFIG_DIR'])).toEqual([
      home,
      home,
      home,
      home,
    ])
    expect(inputs.every((options) => options.env?.['PATH'] === 'bin')).toBe(true)
    // The limit read keeps its own startup switches on top of the account.
    expect(inputs[2]!.env).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' })
  })

  it('leaves the default account on the inherited folder', async () => {
    const { inputs, createQuery } = recordingQuery()
    const base = { PATH: 'bin', CLAUDE_CONFIG_DIR: 'default' }
    const adapter = new ClaudeCodeAdapter({ createQuery, environment: base })
    try {
      await adapter.listModels()
    } finally {
      await adapter.dispose()
    }
    await claudeLimitSource({ createQuery, environment: base })
    expect(inputs.map((options) => options.env?.['CLAUDE_CONFIG_DIR'])).toEqual([
      'default',
      'default',
    ])
  })
})
