import type { ProviderId } from '@harness/contracts'

/**
 * The model a new chat on one provider starts with, when the user pinned one.
 * Without a pin a new chat keeps the last model used there, as it always has.
 */
export type ProviderDefault = { model: string; effort?: string | undefined }
export type ProviderDefaults = Partial<Record<ProviderId, ProviderDefault>>

export const PROVIDER_DEFAULTS_KEY = 'harness.providerDefaults'
const PROVIDERS = new Set<string>(['codex', 'claude-code', 'grok'])

export function readProviderDefaults(): ProviderDefaults {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PROVIDER_DEFAULTS_KEY) ?? '{}')
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
    const defaults: ProviderDefaults = {}
    for (const [provider, entry] of Object.entries(stored)) {
      if (!PROVIDERS.has(provider) || typeof entry !== 'object' || entry === null) continue
      const { model, effort } = entry as Record<string, unknown>
      if (typeof model !== 'string' || model.length === 0) continue
      defaults[provider as ProviderId] = {
        model,
        ...(typeof effort === 'string' && effort.length > 0 ? { effort } : {}),
      }
    }
    return defaults
  } catch {
    return {}
  }
}

export function writeProviderDefaults(defaults: ProviderDefaults): void {
  try {
    if (Object.keys(defaults).length === 0) localStorage.removeItem(PROVIDER_DEFAULTS_KEY)
    else localStorage.setItem(PROVIDER_DEFAULTS_KEY, JSON.stringify(defaults))
  } catch {
    // A lost pin falls back to the last model used, which is still a working chat.
  }
}
