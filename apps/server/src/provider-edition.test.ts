import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CustomHarnessStore } from './custom-harnesses.js'
import { ProviderControls } from './provider-controls.js'
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

  it('keeps a harness on a hidden provider in the file but out of the list', () => {
    takeEdition({ HARNESS_EDITION: 'release' })
    const location = path.join(mkdtempSync(path.join(tmpdir(), 'edition-')), 'harnesses.json')
    const hidden = {
      id: 'pi-local',
      displayName: 'Pi local',
      provider: 'pi',
      command: 'pi',
      args: [],
    }
    writeFileSync(location, JSON.stringify({ version: 1, harnesses: [hidden] }))
    const store = new CustomHarnessStore(location)

    expect(store.list()).toEqual([])
    expect(() => store.upsert({ ...hidden, provider: 'opencode' })).toThrow(
      'not part of this TasteCode build',
    )
    store.upsert({ id: 'fork', displayName: 'Fork', provider: 'codex', command: 'c', args: [] })
    expect(JSON.parse(readFileSync(location, 'utf8')).harnesses).toContainEqual(hidden)
  })

  it('answers for a hidden provider without its services', async () => {
    takeEdition({ HARNESS_EDITION: 'release' })
    const controls = new ProviderControls({ listModels: async () => [] })
    const control = controls.forProvider('opencode')
    expect(control.capabilities.managedMcp).toBe(false)
    expect(control.listModels).toBeUndefined()
    await expect(control.account()).resolves.toMatchObject({ signedIn: false })
    await controls.disposeAll()
  })
})
