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

  it('counts ACP as installed when any one agent is present', async () => {
    const providers = await detectProviders(
      system({
        acpAgents: async () => [
          { name: 'Gemini CLI', installed: true },
          { name: 'Qwen Code', installed: false },
        ],
      }),
    )

    const acp = find(providers, 'acp')
    expect(acp.installed).toBe(true)
    // There is no single binary whose version means anything here, so the
    // field carries which agents were found instead.
    expect(acp.version).toBe('Gemini CLI')
    expect(acp.problem).toBeUndefined()
  })

  it('lists every ACP agent it found, not just the first', async () => {
    const providers = await detectProviders(
      system({
        acpAgents: async () => [
          { name: 'Gemini CLI', installed: true },
          { name: 'Kimi CLI', installed: true },
        ],
      }),
    )

    expect(find(providers, 'acp').version).toBe('Gemini CLI, Kimi CLI')
  })

  it('explains ACP being unavailable when no agent is present', async () => {
    const providers = await detectProviders(
      system({ acpAgents: async () => [{ name: 'Gemini CLI', installed: false }] }),
    )

    const acp = find(providers, 'acp')
    expect(acp.installed).toBe(false)
    expect(acp.problem).toContain('No ACP agent')
  })

  it('reports every provider we know about, installed or not', async () => {
    const providers = await detectProviders(system())

    expect(providers.map((entry) => entry.id).sort()).toEqual([
      'acp',
      'antigravity',
      'claude-code',
      'codex',
      'cursor',
      'opencode',
    ])
  })
})

describe('install command resolution', () => {
  it('resolves install commands from the server-side tables only', () => {
    expect(installCommandFor('opencode')).toBe('npm install -g opencode-ai')
    expect(installCommandFor('claude-code')).toBe('npm install -g @anthropic-ai/claude-code')
    expect(installCommandFor('acp', 'gemini')).toBe('npm install -g @google/gemini-cli')
  })

  it('refuses targets it cannot script instead of guessing', () => {
    // Cursor ships its own installer; there is no command worth running blind.
    expect(() => installCommandFor('cursor')).toThrow(/no scripted install/)
    expect(() => installCommandFor('acp', 'nonexistent')).toThrow(/unknown install target/)
    expect(() => installCommandFor('acp')).toThrow(/unknown install target/)
  })
})

describe('sign-in launch command resolution', () => {
  it('resolves the interactive sign-in CLI from the server-side tables only', () => {
    expect(launchCommandFor('acp', 'gemini')).toBe('gemini')
    expect(launchCommandFor('acp', 'kimi')).toBe('kimi')
    expect(launchCommandFor('acp', 'qwen')).toBe('qwen')
    expect(launchCommandFor('opencode')).toBe('opencode auth login')
  })

  it('refuses providers whose sign-in happens in the app, and unknown targets', () => {
    expect(() => launchCommandFor('codex')).toThrow(/signs in through the app/)
    expect(() => launchCommandFor('claude-code')).toThrow(/signs in through the app/)
    expect(() => launchCommandFor('acp', 'nonexistent')).toThrow(/unknown launch target/)
    expect(() => launchCommandFor('acp')).toThrow(/unknown launch target/)
  })
})
