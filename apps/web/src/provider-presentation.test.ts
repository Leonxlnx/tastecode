import type { ProviderId } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { providerPresentation } from './provider-presentation.js'

describe('provider presentation', () => {
  it.each([
    ['codex', 'Codex', 'openai'],
    ['claude-code', 'Claude Code', 'anthropic'],
    ['grok', 'Grok', 'grok'],
  ] as const)('presents %s consistently', (provider, label, mark) => {
    expect(providerPresentation(provider satisfies ProviderId)).toEqual({ label, mark })
  })
})
