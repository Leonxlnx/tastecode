import { describe, expect, it } from 'vitest'
import {
  detectProviders,
  installCommandFor,
  launchCommandFor,
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
    acpAgents: async () => [],
    ...overrides,
  }
}

const find = (list: Awaited<ReturnType<typeof detectProviders>>, id: string) =>
  list.find((entry) => entry.id === id)!

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
    expect(installedChecks).toBe(6)

    release()
    await Promise.all([first, second])
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
    expect(claude.setup?.login).toBe('app')
  })

  it('links every missing provider to its current product setup guide', async () => {
    const providers = await detectProviders(system())

    expect(find(providers, 'codex').setup?.installUrl).toBe(
      'https://developers.openai.com/codex/cli',
    )
    expect(find(providers, 'claude-code').setup?.installUrl).toBe(
      'https://code.claude.com/docs/en/getting-started',
    )
    expect(find(providers, 'grok').setup?.installUrl).toBe('https://x.ai/cli')
    expect(find(providers, 'cursor').setup?.installUrl).toBe(
      'https://docs.cursor.com/en/cli/installation',
    )
    expect(find(providers, 'opencode').setup?.installUrl).toBe('https://opencode.ai/en/docs')
  })

  it('reports when the installed Cursor wire version is unsupported', async () => {
    const providers = await detectProviders(
      system({ isInstalled: async () => true, version: async () => '2025.12.1' }),
    )

    const cursor = find(providers, 'cursor')
    expect(cursor.installed).toBe(true)
    expect(cursor.problem).toContain('supports 2026.07')
  })

  it('omits the version when the binary would not say', async () => {
    const providers = await detectProviders(
      system({ isInstalled: async () => true, version: async () => undefined }),
    )

    // Reporting an empty string would render as a blank version chip, which
    // reads as a broken install rather than a quiet one.
    expect(find(providers, 'codex').version).toBeUndefined()
  })

  it('never claims to know whether someone is signed in', async () => {
    const providers = await detectProviders(system({ isInstalled: async () => true }))

    // We do not read credential files to answer this. See rules/security.md.
    expect(providers.every((entry) => entry.auth === 'unknown')).toBe(true)
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
  })
})

describe('install command resolution', () => {
  it('resolves install commands from the server-side tables only', () => {
    expect(installCommandFor('acp', 'kimi')).toBe('npm install -g @moonshot-ai/kimi-code')
    expect(installCommandFor('claude-code')).toBe('npm install -g @anthropic-ai/claude-code')
    expect(installCommandFor('opencode')).toBe('npm install -g opencode-ai')
    expect(installCommandFor('acp', 'gemini')).toBe('npm install -g @google/gemini-cli')
  })

  it('refuses targets it cannot script instead of guessing', () => {
    // Grok ships its own installer; there is no command worth running blind.
    expect(() => installCommandFor('grok')).toThrow(/no scripted install/)
    expect(() => installCommandFor('acp', 'nonexistent')).toThrow(/unknown install target/)
    expect(() => installCommandFor('acp')).toThrow(/unknown install target/)
  })
})

describe('sign-in launch command resolution', () => {
  it('resolves the interactive sign-in CLI from the server-side tables only', () => {
    expect(launchCommandFor('acp', 'gemini')).toBe('gemini')
    expect(launchCommandFor('acp', 'kimi')).toBe('kimi')
    expect(launchCommandFor('acp', 'qwen')).toBe('qwen')
    expect(launchCommandFor('grok')).toBe('grok login')
    expect(launchCommandFor('opencode')).toBe('opencode auth login')
  })

  it('refuses providers whose sign-in happens in the app, and unknown targets', () => {
    expect(() => launchCommandFor('codex')).toThrow(/signs in through the app/)
    expect(() => launchCommandFor('claude-code')).toThrow(/signs in through the app/)
    expect(() => launchCommandFor('acp', 'nonexistent')).toThrow(/unknown launch target/)
    expect(() => launchCommandFor('acp')).toThrow(/unknown launch target/)
  })
})
