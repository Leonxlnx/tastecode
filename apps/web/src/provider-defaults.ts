import { ProviderIdSchema, type ApprovalMode, type ProviderId } from '@harness/contracts'
import { isCustomModelChoice, type ModelChoice } from './model-catalog.js'

/**
 * The model a new chat on one provider starts with, when the user pinned one.
 * Without a pin a new chat keeps the last model used there, as it always has.
 */
export type ProviderDefault = { model: string; effort?: string | undefined }
export type ProviderDefaults = Partial<Record<ProviderId, ProviderDefault>>

export const PROVIDER_DEFAULTS_KEY = 'harness.providerDefaults'

export function readProviderDefaults() {
  const defaults: ProviderDefaults = {}
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PROVIDER_DEFAULTS_KEY) ?? '{}')
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return defaults
    for (const [provider, entry] of Object.entries(stored)) {
      const id = ProviderIdSchema.safeParse(provider)
      if (!id.success || typeof entry !== 'object' || entry === null) continue
      const { model, effort } = entry as Record<string, unknown>
      if (typeof model !== 'string' || model.length === 0) continue
      defaults[id.data] = {
        model,
        ...(typeof effort === 'string' && effort.length > 0 ? { effort } : {}),
      }
    }
  } catch {
    // Unreadable storage leaves every provider on its last used model.
  }
  return defaults
}

/**
 * The provider's own catalog models the picker shows. Custom ids, agent
 * sources and the catalogless "Provider default" stand-in cannot be pinned:
 * none of them names a model the provider listed.
 */
export function pinnableModels(
  choices: readonly ModelChoice[],
  provider: ProviderId,
  hidden: ReadonlySet<string> = new Set(),
): ModelChoice[] {
  return choices.filter(
    (choice) =>
      choice.provider === provider &&
      !choice.agent &&
      !isCustomModelChoice(choice) &&
      choice.model.id.length > 0 &&
      !hidden.has(choice.key),
  )
}

export function pinnedModelChoice(
  choices: readonly ModelChoice[],
  provider: ProviderId,
  pin: ProviderDefault | undefined,
  hidden?: ReadonlySet<string>,
): ModelChoice | undefined {
  if (!pin) return undefined
  return pinnableModels(choices, provider, hidden).find((choice) => choice.model.id === pin.model)
}

/**
 * The access a new chat on this provider starts with. A remembered
 * auto-review falls back to full access where the engine has no reviewer,
 * which is what the session would actually get.
 */
export function providerApprovalDefault(
  stored: ApprovalMode | undefined,
  autoReview: boolean,
): ApprovalMode {
  if (stored === 'auto-review' && !autoReview) return 'full'
  return stored ?? (autoReview ? 'auto-review' : 'full')
}

export function writeProviderDefaults(defaults: ProviderDefaults): void {
  try {
    if (Object.keys(defaults).length === 0) localStorage.removeItem(PROVIDER_DEFAULTS_KEY)
    else localStorage.setItem(PROVIDER_DEFAULTS_KEY, JSON.stringify(defaults))
  } catch {
    // A lost pin falls back to the last model used, which is still a working chat.
  }
}
