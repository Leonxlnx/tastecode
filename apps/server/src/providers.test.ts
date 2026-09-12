import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectProviders,
  installCommandFor,
  launchCommandFor,
  prewarmProviders,
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
    expect(installedChecks).toBe(3)

    release()
    await Promise.all([first, second])
  })

  it('consumes one prewarmed scan before refreshing the machine state', async () => {
    let installedChecks = 0
    const sharedSystem = system({
      isInstalled: async () => {
        installedChecks += 1
        return false
      },
    })

    const prewarmed = prewarmProviders(sharedSystem)
    expect(prewarmProviders(sharedSystem)).toBe(prewarmed)
    await prewarmed
    expect(installedChecks).toBe(3)

    expect(detectProviders(sharedSystem)).toBe(prewarmed)
    await detectProviders(sharedSystem)
    expect(installedChecks).toBe(6)
  })

  it('refreshes a prewarmed scan that waited too long for its first reader', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let installedChecks = 0
    const sharedSystem = system({
      isInstalled: async () => {
        installedChecks += 1
        return false
      },
    })

    await prewarmProviders(sharedSystem)
    vi.setSystemTime(30_001)
    await detectProviders(sharedSystem)

    expect(installedChecks).toBe(6)
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

  it('reports every provider we know about, installed or not', async () => {
    const providers = await detectProviders(system())

    expect(providers.map((entry) => entry.id).sort()).toEqual(['claude-code', 'codex', 'grok'])
  })
})

describe('install command resolution', () => {
  it('resolves install commands from the server-side tables only', async () => {
    await expect(installCommandFor('acp', 'kimi')).resolves.toBe(
      'npm install -g @moonshot-ai/kimi-code',
    )
    await expect(installCommandFor('claude-code')).resolves.toBe(
      'npm install -g @anthropic-ai/claude-code',
    )
    await expect(installCommandFor('acp', 'gemini')).resolves.toBe(
      'npm install -g @google/gemini-cli',
    )
  })

  it('refuses targets it cannot script instead of guessing', async () => {
    // Grok ships its own installer; there is no command worth running blind.
    await expect(installCommandFor('grok')).rejects.toThrow(/no scripted install/)
    await expect(installCommandFor('acp', 'nonexistent')).rejects.toThrow(/unknown install target/)
    await expect(installCommandFor('acp')).rejects.toThrow(/unknown install target/)
  })
})

describe('sign-in launch command resolution', () => {
  it('resolves the interactive sign-in CLI from the server-side tables only', async () => {
    await expect(launchCommandFor('acp', 'gemini')).resolves.toBe('gemini')
    await expect(launchCommandFor('acp', 'kimi')).resolves.toBe('kimi')
    await expect(launchCommandFor('acp', 'qwen')).resolves.toBe('qwen')
    await expect(launchCommandFor('codex')).resolves.toBe('codex login')
    await expect(launchCommandFor('claude-code')).resolves.toBe('claude auth login')
    await expect(launchCommandFor('grok')).resolves.toBe('grok login')
  })

  it('refuses unknown launch targets', async () => {
    await expect(launchCommandFor('acp', 'nonexistent')).rejects.toThrow(/unknown launch target/)
    await expect(launchCommandFor('acp')).rejects.toThrow(/unknown launch target/)
  })
})
