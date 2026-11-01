import { afterEach, describe, expect, it } from 'vitest'
import { providerOffered, takeEdition } from './provider-edition.js'
import {
  detectProviders,
  installCommandFor,
  launchCommandFor,
  type SystemProbe,
} from './providers.js'
import { providerRuntime } from './runtime-loader.js'

const everything = (): SystemProbe => ({
  isInstalled: async () => true,
  version: async () => '1.0.0',
  auth: async () => 'unknown',
  acpAgents: async () => [{ name: 'Gemini CLI', installed: true }],
})

afterEach(() => takeEdition({}))

describe('build edition', () => {
  it('offers every provider when no edition is set or it is dev', () => {
    takeEdition({})
    expect(providerOffered('opencode')).toBe(true)
    takeEdition({ HARNESS_EDITION: 'dev' })
    expect(providerOffered('acp')).toBe(true)
  })

  it('reads the edition once and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { HARNESS_EDITION: 'release', PATH: 'kept' }
    takeEdition(env)
    expect(env).toEqual({ PATH: 'kept' })
  })

  it('fails loudly on an edition it does not know', () => {
    expect(() => takeEdition({ HARNESS_EDITION: 'nightly' })).toThrow('Unknown HARNESS_EDITION')
  })

  it('lists only the release providers in a release build', async () => {
    takeEdition({ HARNESS_EDITION: 'release' })
    const listed = await detectProviders(everything())
    expect(listed.map((status) => status.id)).toEqual([
      'claude-code',
      'codex',
      'grok',
      'cursor',
      'antigravity',
    ])
  })

  it('lists every provider and the ACP entry in a dev build', async () => {
    const listed = await detectProviders(everything())
    expect(listed.map((status) => status.id)).toEqual([
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

  it('refuses to install, sign in to or start a provider the build does not offer', async () => {
    takeEdition({ HARNESS_EDITION: 'release' })
    await expect(installCommandFor('opencode')).rejects.toThrow('not part of this TasteCode build')
    await expect(launchCommandFor('acp', 'gemini')).rejects.toThrow(
      'not part of this TasteCode build',
    )
    expect(() => providerRuntime('pi', () => {})).toThrow('not part of this TasteCode build')
    expect(() => providerRuntime('grok', () => {})).not.toThrow()
  })
})
