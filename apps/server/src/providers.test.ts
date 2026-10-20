import { afterEach, describe, expect, it, vi } from 'vitest'
import { antigravityInstallCommand } from '@harness/adapter-antigravity'
import { claudeInstallCommand } from '@harness/adapter-claude-code/updates'
import { codexInstallCommand } from '@harness/adapter-codex/updates'
import { cursorInstallCommand } from '@harness/adapter-cursor'
import { grokInstallCommand } from '@harness/adapter-grok/updates'
import {
  detectProviders,
  installCommandFor,
  installTimeAuth,
  launchCommandFor,
  prewarmProviders,
  SignInChecks,
  type SystemProbe,
} from './providers.js'

/**
 * These assert what we *say* about the machine, not what is on it. A test that
 * depended on which agents happen to be installed would pass on one laptop and
 * fail on the next, which is the opposite of useful.
 */

function system(overrides: Partial<SystemProbe> = {}): SystemProbe {
  return {
    isInstalled: async () => false,
    version: async () => undefined,
    auth: async () => 'unknown',
    acpAgents: async () => [],
    ...overrides,
  }
}

const find = (list: Awaited<ReturnType<typeof detectProviders>>, id: string) =>
  list.find((entry) => entry.id === id)!

afterEach(() => vi.useRealTimers())

describe('detectProviders', () => {
  it('shares one machine scan across concurrent callers', async () => {
    let installedChecks = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sharedSystem = system({
      isInstalled: async () => {
        installedChecks += 1
        await gate
        return false
      },
    })

    const first = detectProviders(sharedSystem)
    const second = detectProviders(sharedSystem)
    expect(first).toBe(second)
    await Promise.resolve()
    expect(installedChecks).toBe(7)

    release()
    await Promise.all([first, second])
  })

  it('lets the first listing join the startup scan while it runs', async () => {
    let installedChecks = 0
    const sharedSystem = system({
      isInstalled: async () => {
        installedChecks += 1
        return false
      },
    })

    const prewarmed = prewarmProviders(sharedSystem)
    expect(detectProviders(sharedSystem)).toBe(prewarmed)
    await prewarmed
    expect(installedChecks).toBe(7)
  })

  it('re-reads the PATH before looking for binaries after the launch listing', async () => {
    const order: string[] = []
    const sharedSystem = system({
      refreshPath: async () => {
        order.push('path')
      },
      isInstalled: async (command) => {
        order.push(command)
        return command === 'agy' && order.includes('path')
      },
    })
    expect(find(await detectProviders(sharedSystem), 'antigravity').installed).toBe(false)
    order.length = 0
    const providers = await detectProviders(sharedSystem)
    expect(order[0]).toBe('path')
    expect(find(providers, 'antigravity').installed).toBe(true)
  })

  it('answers the launch scan and the first listing without reading the registry PATH', async () => {
    let refreshes = 0
    const sharedSystem = system({
      refreshPath: async () => {
        refreshes += 1
      },
    })
    await prewarmProviders(sharedSystem)
    await detectProviders(sharedSystem)
    expect(refreshes).toBe(0)
    await detectProviders(sharedSystem)
    expect(refreshes).toBe(1)
  })

  it('scans again for a listing after the startup scan, so installs show up', async () => {
    let installed = false
    const sharedSystem = system({ isInstalled: async (command) => installed && command === 'grok' })

    await prewarmProviders(sharedSystem)
    installed = true
    expect(find(await detectProviders(sharedSystem), 'grok').installed).toBe(true)
  })

  it('reports an installed provider with the version it gave us', async () => {
    const providers = await detectProviders(
      system({
        isInstalled: async (command) => command === 'codex',
        version: async () => 'codex-cli 1.4.0',
      }),
    )

    const codex = find(providers, 'codex')
    expect(codex.installed).toBe(true)
    expect(codex.version).toBe('codex-cli 1.4.0')
    expect(codex.problem).toBeUndefined()
  })

  it('says why a provider is unusable rather than only that it is', async () => {
    const providers = await detectProviders(system())

    const claude = find(providers, 'claude-code')
    expect(claude.installed).toBe(false)
    // "not installed" with no reason leaves the user nothing to act on.
    expect(claude.problem).toContain('claude')
    expect(claude.setup?.installUrl).toMatch(/^https:/)
    expect(claude.setup?.login).toBe('provider')
  })

  it('links every missing provider to its current product setup guide', async () => {
    const providers = await detectProviders(system())

    expect(find(providers, 'codex').setup?.installUrl).toBe(
      'https://developers.openai.com/codex/cli',
    )
    expect(find(providers, 'codex').setup?.login).toBe('provider')
    expect(find(providers, 'claude-code').setup?.installUrl).toBe(
      'https://code.claude.com/docs/en/getting-started',
    )
    expect(find(providers, 'grok').setup?.installUrl).toBe('https://x.ai/cli')
    expect(find(providers, 'cursor').setup?.installUrl).toBe(
      'https://cursor.com/docs/cli/installation',
    )
    expect(find(providers, 'opencode').setup?.installUrl).toBe('https://opencode.ai/en/docs')
  })

  it('keeps Cursor usable after it updates itself to a newer build', async () => {
    for (const version of ['2026.10.02-abc1234', '2025.12.1']) {
      const providers = await detectProviders(
        system({ isInstalled: async () => true, version: async () => version }),
      )

      const cursor = find(providers, 'cursor')
      expect(cursor.installed).toBe(true)
      expect(cursor.version).toBe(version)
      expect(cursor.problem).toBeUndefined()
    }
  })

  it('omits the version when the binary would not say', async () => {
    const providers = await detectProviders(
      system({ isInstalled: async () => true, version: async () => undefined }),
    )

    // Reporting an empty string would render as a blank version chip, which
    // reads as a broken install rather than a quiet one.
    expect(find(providers, 'codex').version).toBeUndefined()
  })

  it('finds Antigravity without starting agy', async () => {
    const asked: string[] = []
    const providers = await detectProviders(
      system({
        isInstalled: async () => true,
        version: async (command) => {
          asked.push(command)
          return '1.4.0'
        },
      }),
    )

    // Starting agy launches its language server and self-updater; a scan only
    // needs to find the binary.
    const antigravity = find(providers, 'antigravity')
    expect(antigravity.installed).toBe(true)
    expect(antigravity.version).toBeUndefined()
    expect(antigravity.problem).toBeUndefined()
    expect(antigravity.capabilities).toBeDefined()
    expect(asked).not.toContain('agy')
    expect(asked).toContain('codex')
  })

  it('never claims to know whether someone is signed in', async () => {
    const providers = await detectProviders(system({ isInstalled: async () => true }))

    // We do not read credential files to answer this. See rules/security.md.
    expect(providers.every((entry) => entry.auth === 'unknown')).toBe(true)
  })

  it('reports the login state returned by an installed provider', async () => {
    const providers = await detectProviders(
      system({
        isInstalled: async () => true,
        auth: async (provider) => (provider === 'codex' ? 'authenticated' : 'unknown'),
      }),
    )

    expect(find(providers, 'codex').auth).toBe('authenticated')
    expect(find(providers, 'claude-code').auth).toBe('unknown')
  })

  it('bounds a slow sign-in check and reports its answer to a later listing', async () => {
    vi.useFakeTimers()
    let checks = 0
    let answer!: (value: 'authenticated') => void
    const checksOf = new SignInChecks(() => {
      checks += 1
      return new Promise((resolve) => {
        answer = resolve
      })
    }, 250)

    const first = checksOf.read('codex')
    const joined = checksOf.read('codex')
    await vi.advanceTimersByTimeAsync(250)
    await expect(first).resolves.toBe('unknown')
    await expect(joined).resolves.toBe('unknown')
    // The check goes on in the background; a second listing does not start another.
    expect(checks).toBe(1)

    answer('authenticated')
    await vi.advanceTimersByTimeAsync(0)
    const next = checksOf.read('codex')
    expect(checks).toBe(2)
    await vi.advanceTimersByTimeAsync(250)
    // The new check has not answered, so the last answer stands in for it.
    await expect(next).resolves.toBe('authenticated')
  })

  it('reports a sign-in check that answers in time, and unknown for one that fails', async () => {
    const answered = new SignInChecks(async () => 'unauthenticated', 250)
    await expect(answered.read('codex')).resolves.toBe('unauthenticated')
    const failed = new SignInChecks(async () => {
      throw new Error('no codex')
    }, 250)
    await expect(failed.read('codex')).resolves.toBe('unknown')
  })

  it('reports unknown for a provider whose probe declares no sign-in check', async () => {
    // Nothing is started for these: the account read answers them later.
    const unchecked = [
      'claude-code',
      'grok',
      'cursor',
      'opencode',
      'antigravity',
      'pi',
      'acp',
    ] as const
    for (const provider of unchecked) {
      await expect(installTimeAuth(provider)).resolves.toBe('unknown')
    }
  })

  it('reports every provider we know about, installed or not', async () => {
    const providers = await detectProviders(system())

    expect(providers.map((entry) => entry.id).sort()).toEqual([
      'acp',
      'antigravity',
      'claude-code',
      'codex',
      'cursor',
      'grok',
      'opencode',
      'pi',
    ])
  })

  it('reports every installed ACP agent through the aggregate row', async () => {
    const providers = await detectProviders(
      system({
        acpAgents: async () => [
          { name: 'Kimi CLI', installed: true },
          { name: 'Qwen Code', installed: true },
        ],
      }),
    )

    const acp = find(providers, 'acp')
    expect(acp.installed).toBe(true)
    expect(acp.version).toBe('Kimi CLI, Qwen Code')
    // The composer sends only to a provider that declares what it can do.
    expect(acp.capabilities).toMatchObject({ interrupt: true, approvals: true, steer: false })
  })

  it('declares no capabilities while no ACP agent is installed', async () => {
    const acp = find(
      await detectProviders(
        system({ acpAgents: async () => [{ name: 'Devin', installed: false }] }),
      ),
      'acp',
    )
    expect(acp.installed).toBe(false)
    expect(acp.capabilities).toBeUndefined()
    expect(acp.problem).toBe('No ACP agent found on PATH')
  })

  it('declares what each provider source must name, installed or not', async () => {
    const direct = { agent: 'optional', connection: false, direct: true }
    for (const installed of [false, true]) {
      const providers = await detectProviders(
        system({
          isInstalled: async () => installed,
          acpAgents: async () => [{ name: 'Kimi CLI', installed }],
        }),
      )

      expect(Object.fromEntries(providers.map((entry) => [entry.id, entry.source]))).toEqual({
        'claude-code': direct,
        codex: direct,
        grok: direct,
        cursor: direct,
        opencode: direct,
        antigravity: direct,
        pi: { agent: 'required', connection: false, direct: true },
        acp: { agent: 'required', connection: false, direct: false },
      })
    }
  })

  it('lists Claude Code first, then Codex, Grok, the other CLIs and ACP', async () => {
    const providers = await detectProviders(system())

    expect(providers.map((entry) => entry.id)).toEqual([
      'claude-code',
      'codex',
      'grok',
      'cursor',
      'opencode',
      'antigravity',
      'pi',
      'acp',
    ])
  })
})

describe('install command resolution', () => {
  it('offers and runs the same standalone Codex installer on a clean machine', async () => {
    const codex = find(await detectProviders(system()), 'codex')
    expect(codex.installed).toBe(false)
    expect(codex.setup?.installCommand).toBe(codexInstallCommand())
    await expect(installCommandFor('codex')).resolves.toBe(codex.setup?.installCommand)
  })

  it('installs Claude Code with the native installer, not npm', async () => {
    const claude = find(await detectProviders(system()), 'claude-code')
    expect(claude.setup?.installCommand).toBe(claudeInstallCommand())
    await expect(installCommandFor('claude-code')).resolves.toBe(claudeInstallCommand())
    expect(claudeInstallCommand()).not.toMatch(/npm/)
  })

  it('resolves nightly CLI and ACP installs from trusted tables', async () => {
    await expect(installCommandFor('acp', 'kimi')).resolves.toBe(
      'npm install -g @moonshot-ai/kimi-code',
    )
    await expect(installCommandFor('opencode')).resolves.toBe('npm install -g opencode-ai')
    await expect(installCommandFor('acp', 'gemini')).resolves.toBe(
      'npm install -g @google/gemini-cli',
    )
    await expect(installCommandFor('acp', 'nonexistent')).rejects.toThrow(/unknown install target/)
    await expect(installCommandFor('acp')).rejects.toThrow(/unknown install target/)
  })

  it('installs Grok with the installer xAI documents', async () => {
    const grok = find(await detectProviders(system()), 'grok')
    expect(grok.setup?.installCommand).toBe(grokInstallCommand())
    await expect(installCommandFor('grok')).resolves.toBe(grokInstallCommand())
  })

  it('installs Cursor with the installer Cursor documents', async () => {
    const cursor = find(await detectProviders(system()), 'cursor')
    expect(cursor.setup?.installCommand).toBe(cursorInstallCommand())
    await expect(installCommandFor('cursor')).resolves.toBe(cursorInstallCommand())
  })

  it('installs Antigravity with the installer Google documents', async () => {
    const antigravity = find(await detectProviders(system()), 'antigravity')
    expect(antigravity.setup?.installCommand).toBe(antigravityInstallCommand())
    await expect(installCommandFor('antigravity')).resolves.toBe(antigravityInstallCommand())
  })

  it('refuses targets it cannot script instead of guessing', async () => {
    // Pi's entry names no install command, so its row links the setup page.
    await expect(installCommandFor('pi')).rejects.toThrow(/no scripted install/)
    await expect(installCommandFor('unlisted-cli' as never)).rejects.toThrow(
      /unknown install target/,
    )
  })
})

describe('sign-in launch command resolution', () => {
  it('resolves the interactive sign-in CLI from the server-side tables only', async () => {
    await expect(launchCommandFor('codex')).resolves.toBe('codex login')
    await expect(launchCommandFor('claude-code')).resolves.toBe('claude auth login')
    await expect(launchCommandFor('grok')).resolves.toBe('grok login')
    await expect(launchCommandFor('opencode')).resolves.toBe('opencode auth login')
    await expect(launchCommandFor('pi')).resolves.toBe('pi')
    await expect(launchCommandFor('acp', 'gemini')).resolves.toBe('gemini')
    await expect(launchCommandFor('acp', 'kimi')).resolves.toBe('kimi')
    await expect(launchCommandFor('acp', 'qwen')).resolves.toBe('qwen')
    // An agent with a login command of its own signs in through it.
    await expect(launchCommandFor('acp', 'devin')).resolves.toBe('devin auth login')
    await expect(launchCommandFor('acp', 'vibe')).resolves.toBe('vibe-acp --setup')
    await expect(launchCommandFor('acp', 'droid')).resolves.toBe('droid')
  })

  it('refuses unknown launch targets', async () => {
    await expect(launchCommandFor('acp', 'nonexistent')).rejects.toThrow(/unknown launch target/)
    await expect(launchCommandFor('acp')).rejects.toThrow(/unknown launch target/)
    await expect(launchCommandFor('cursor')).rejects.toThrow(/signs in through the app/)
    await expect(launchCommandFor('unlisted-cli' as never)).rejects.toThrow(/unknown launch target/)
  })
})
