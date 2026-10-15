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

/**
 * The one order every provider list follows: Claude Code, then Codex, then
 * Grok. The server reports `providers.list` in the same order.
 */
export const PROVIDER_ORDER: readonly ProviderId[] = ['claude-code', 'codex', 'grok']

/** A provider's place in `PROVIDER_ORDER`; one it does not name sorts last. */
export function providerRank(provider: ProviderId): number {
  const rank = PROVIDER_ORDER.indexOf(provider)
  return rank === -1 ? PROVIDER_ORDER.length : rank
}

export function providerPresentation(provider: ProviderId): ProviderPresentation {
  return PROVIDERS[provider]
}

export function providerDisplayName(provider: ProviderId): string {
  return providerPresentation(provider).label
}

export function providerMark(provider: ProviderId): ProviderMark {
  return providerPresentation(provider).mark
}
