import type { ProviderId } from '@harness/contracts'

export type ProviderMark = 'openai' | 'anthropic' | 'grok'

export type ProviderPresentation = {
  label: string
  mark: ProviderMark
}

const PROVIDERS = {
  codex: { label: 'Codex', mark: 'openai' },
  'claude-code': { label: 'Claude Code', mark: 'anthropic' },
  grok: { label: 'Grok', mark: 'grok' },
} as const satisfies Record<ProviderId, ProviderPresentation>

export function providerPresentation(provider: ProviderId): ProviderPresentation {
  return PROVIDERS[provider]
}

export function providerDisplayName(provider: ProviderId): string {
  return providerPresentation(provider).label
}

export function providerMark(provider: ProviderId): ProviderMark {
  return providerPresentation(provider).mark
}
