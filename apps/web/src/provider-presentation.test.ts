import { ProviderIdSchema, type ProviderId } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { PROVIDER_ORDER, providerPresentation, providerRank } from './provider-presentation.js'

describe('provider presentation', () => {
  it.each([
    ['codex', 'Codex', 'openai'],
    ['claude-code', 'Claude Code', 'anthropic'],
    ['grok', 'Grok', 'grok'],
  ] as const)('presents %s consistently', (provider, label, mark) => {
    expect(providerPresentation(provider satisfies ProviderId)).toEqual({ label, mark })
  })

  it('ranks every provider exactly once, Claude Code first', () => {
    expect(PROVIDER_ORDER[0]).toBe('claude-code')
    expect([...PROVIDER_ORDER].sort()).toEqual([...ProviderIdSchema.options].sort())
    expect([...ProviderIdSchema.options].sort((a, b) => providerRank(a) - providerRank(b))).toEqual(
      PROVIDER_ORDER,
    )
  })
})
