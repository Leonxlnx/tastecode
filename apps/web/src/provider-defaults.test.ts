// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { Model } from '@harness/contracts'
import { choicesFor, customModelChoice } from './model-catalog.js'
import {
  PROVIDER_DEFAULTS_KEY,
  pinnableModels,
  pinnedModelChoice,
  providerApprovalDefault,
  readProviderDefaults,
  writeProviderDefaults,
} from './provider-defaults.js'

function model(id: string): Model {
  return { id, displayName: id, isDefault: false, reasoningEfforts: [], serviceTiers: [] }
}

afterEach(() => localStorage.removeItem(PROVIDER_DEFAULTS_KEY))

describe('provider default storage', () => {
  it('round-trips pins and forgets the key once nothing is pinned', () => {
    writeProviderDefaults({ codex: { model: 'gpt-6', effort: 'high' }, grok: { model: 'grok-5' } })
    expect(readProviderDefaults()).toEqual({
      codex: { model: 'gpt-6', effort: 'high' },
      grok: { model: 'grok-5' },
    })
    writeProviderDefaults({})
    expect(localStorage.getItem(PROVIDER_DEFAULTS_KEY)).toBeNull()
  })

  it('keeps only entries that name a known provider and a model', () => {
    localStorage.setItem(
      PROVIDER_DEFAULTS_KEY,
      JSON.stringify({
        codex: { model: 'gpt-6', effort: '' },
        'claude-code': { model: '' },
        grok: 'grok-5',
        unknown: { model: 'x' },
      }),
    )
    expect(readProviderDefaults()).toEqual({ codex: { model: 'gpt-6' } })
  })

  it('reads unreadable storage as no pins', () => {
    localStorage.setItem(PROVIDER_DEFAULTS_KEY, '{not json')
    expect(readProviderDefaults()).toEqual({})
    localStorage.setItem(PROVIDER_DEFAULTS_KEY, '[]')
    expect(readProviderDefaults()).toEqual({})
  })
})

describe('pinnable models', () => {
  const codexModels = choicesFor({ provider: 'codex', sourceName: '', mark: 'openai' }, [
    model('gpt-6'),
    model('gpt-5.5'),
  ])
  const agentModels = choicesFor(
    { provider: 'codex', sourceName: 'Mine', mark: 'openai', agent: { id: 'mine', name: 'Mine' } },
    [model('gpt-6')],
  )
  const catalogless = choicesFor({ provider: 'grok', sourceName: '', mark: 'grok' }, [])
  const custom = customModelChoice({ provider: 'codex', modelId: 'gpt-x', displayName: '' })
  const all = [...codexModels, ...agentModels, ...catalogless, custom]

  it('lists only the provider’s own visible catalog models', () => {
    expect(pinnableModels(all, 'codex').map((choice) => choice.key)).toEqual(
      codexModels.map((choice) => choice.key),
    )
    expect(pinnableModels(all, 'codex', new Set([codexModels[1]!.key]))).toEqual([codexModels[0]])
    expect(pinnableModels(all, 'grok')).toEqual([])
  })

  it('finds the choice a pin points at, unless it is hidden', () => {
    expect(pinnedModelChoice(all, 'codex', { model: 'gpt-5.5' })).toBe(codexModels[1])
    expect(pinnedModelChoice(all, 'codex', { model: 'gpt-x' })).toBeUndefined()
    expect(
      pinnedModelChoice(all, 'codex', { model: 'gpt-5.5' }, new Set([codexModels[1]!.key])),
    ).toBeUndefined()
    expect(pinnedModelChoice(all, 'codex', undefined)).toBeUndefined()
  })
})

describe('providerApprovalDefault', () => {
  it('starts where the composer starts a new chat', () => {
    expect(providerApprovalDefault(undefined, true)).toBe('auto-review')
    expect(providerApprovalDefault(undefined, false)).toBe('full')
    expect(providerApprovalDefault('ask', false)).toBe('ask')
  })

  it('shows full access for a remembered auto-review the engine cannot run', () => {
    expect(providerApprovalDefault('auto-review', false)).toBe('full')
    expect(providerApprovalDefault('auto-review', true)).toBe('auto-review')
  })
})
