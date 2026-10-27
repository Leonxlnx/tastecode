import { resolveReasoningEffort, sourceKey, type ModelChoice } from '../model-catalog.js'
import { PROVIDER_ORDER, providerRank } from '../provider-presentation.js'

/** Padding between the effort track's edge and its thumb, mirrored in model-selector-menu.css. */
export const EFFORT_TRACK_INSET = 3
/** Diameter of the effort thumb; the level dots sit on the line its centre travels. */
export const EFFORT_THUMB_SIZE = 24

export type ModelSelectorProps = {
  models: ModelChoice[]
  modelId: string | undefined
  /**
   * The choice the next request uses, resolved once by the owner. When set, the
   * trigger and the checked row show it, even if it is not in `models`, so the
   * label can never name another model than the one a send starts.
   */
  choice?: ModelChoice | undefined
  effort: string | undefined
  serviceTier: string | undefined
  disabled: boolean
  onOpen?: (() => void) | undefined
  onModelChange: (id: string) => void
  onEffortChange: (value: string) => void
  onServiceTierChange: (value: string | undefined) => void
}

export type ModelGroup = {
  key: string
  name: string
  mark: ModelChoice['mark']
  entries: ModelChoice[]
}

const WORD_START = /(^|[\s\-_/(])(\p{Ll})/gu

/** Starts every word of a model name with a capital letter: `Opus 4.7 fast` → `Opus 4.7 Fast`. */
export function formatModelName(name: string): string {
  return name.replace(
    WORD_START,
    (_, before: string, letter: string) => before + letter.toUpperCase(),
  )
}

const GPT_MODEL_NAME = /^gpt(?:[-\s]*(\d[\w.]*))?(?:[-\s]+(.+))?$/i

/**
 * Codex lists names such as `GPT-6-Astra`. The family keeps its version
 * (`GPT-6 Astra`), so the composer never shows a bare number like `6 Astra`.
 */
export function getCompactModelName(displayName: string | undefined): string {
  const name = displayName?.trim()
  if (!name) return 'Model'
  const gpt = GPT_MODEL_NAME.exec(name)
  if (!gpt) return formatModelName(name.replace(/-/g, ' ').trim())
  const version = gpt[1] ? `-${gpt[1]}` : ''
  const rest = gpt[2] ? formatModelName(gpt[2].replace(/-/g, ' ').trim()) : undefined
  return `GPT${version}${rest ? ` ${rest}` : ''}`
}

export function getFriendlyEffortLabel(value: string | undefined): string {
  if (!value) return 'Default'
  if (value.toLowerCase() === 'xhigh') return 'Extra High'
  if (value.toLowerCase() === 'xlow') return 'Extra Low'
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\bx([a-z])/gi, (_, letter: string) => `extra ${letter}`)
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/**
 * An effort level as one word in sentence case, for the ledger picker:
 * `xhigh` is "Extra high", `max` is "Max". The list and rail keep
 * `getFriendlyEffortLabel`'s title case.
 */
export function getEffortWord(value: string | undefined): string {
  if (!value) return 'Default'
  const words = value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\bx(?=(?:high|low)\b)/g, 'extra ')
    .replace(/\s+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function getEffortIndexFromPointer(input: {
  clientX: number
  left: number
  width: number
  stopCount: number
  currentIndex?: number | null
}): number {
  if (input.stopCount <= 1) return 0
  const position = getEffortProgressFromPointer(input) * (input.stopCount - 1)
  if (input.currentIndex == null) return Math.round(position)
  const current = input.currentIndex
  // Keep the current stop until the pointer reaches the next stop's final quarter.
  return position > current
    ? Math.max(current, Math.floor(position + 0.25))
    : Math.max(0, Math.min(current, Math.ceil(position - 0.25)))
}

export function getEffortProgressFromPointer(input: {
  clientX: number
  left: number
  width: number
}): number {
  const innerWidth = input.width - EFFORT_TRACK_INSET * 2
  if (innerWidth <= EFFORT_THUMB_SIZE) return 0
  const travelWidth = innerWidth - EFFORT_THUMB_SIZE
  const relativeX = input.clientX - input.left - EFFORT_TRACK_INSET - EFFORT_THUMB_SIZE / 2
  return Math.min(1, Math.max(0, relativeX / travelWidth))
}

export function modelSourceKey(entry: ModelChoice): string {
  return sourceKey({
    provider: entry.provider,
    connectionId: entry.connectionId,
    agentId: entry.agent?.id,
    accountId: entry.accountId,
  })
}

/**
 * Every ACP source names its agent, so an agent identity only marks a custom
 * harness when the provider is a direct one. ACP agents (an ACP-backed custom
 * harness among them) share ACP's place; custom harnesses on a direct
 * provider follow every provider.
 */
function sourceRank(entry: ModelChoice): number {
  if (entry.agent && entry.provider !== 'acp') return PROVIDER_ORDER.length
  return providerRank(entry.provider)
}

/**
 * Discovery settles sources in whatever order they answer, so the catalog's
 * order shifts while models load. Stock providers therefore take their place
 * in `PROVIDER_ORDER`, then ACP agents and API connections, and custom
 * harnesses follow; sources that share a place keep the order they arrived
 * in (the sort is stable), so groups hold still instead of jumping.
 */
export function groupModelsBySource(models: ModelChoice[]): ModelGroup[] {
  const groups: ModelGroup[] = []
  const groupsByKey = new Map<string, ModelGroup>()
  const ranks = new Map<ModelGroup, number>()
  for (const entry of models) {
    const key = modelSourceKey(entry)
    const group = groupsByKey.get(key)
    if (group) group.entries.push(entry)
    else {
      const next = { key, name: entry.sourceName, mark: entry.mark, entries: [entry] }
      groupsByKey.set(key, next)
      ranks.set(next, sourceRank(entry))
      groups.push(next)
    }
  }
  return groups.sort((left, right) => ranks.get(left)! - ranks.get(right)!)
}

export function getSelectedChoice(
  models: ModelChoice[],
  modelId: string | undefined,
): ModelChoice | undefined {
  let fallback = models[0]
  for (const entry of models) {
    if (entry.key === modelId) return entry
    if (entry.model.isDefault) fallback = entry
  }
  return fallback
}

export function getSelectedEffort(
  model: ModelChoice['model'] | undefined,
  effort: string | undefined,
): string | undefined {
  if (!model) return undefined
  return resolveReasoningEffort({ currentEffort: effort, nextModel: model })
}

export function isFastModeEnabled(
  model: ModelChoice['model'] | undefined,
  serviceTier: string | undefined,
): boolean {
  return Boolean(serviceTier && getFastServiceTier(model)?.id === serviceTier)
}

export function getFastServiceTier(
  model: ModelChoice['model'] | undefined,
): { id: string; name: string; description: string } | undefined {
  return model?.serviceTiers.find((tier) => {
    const id = tier.id.trim().toLowerCase()
    const name = tier.name.trim().toLowerCase()
    return id === 'priority' || id === 'fast' || name === 'fast'
  })
}

export function getFastModeOffValue(model: ModelChoice['model'] | undefined): string | undefined {
  const defaultTier = model?.defaultServiceTier ?? undefined
  if (!defaultTier) return undefined
  return defaultTier === getFastServiceTier(model)?.id ? undefined : defaultTier
}

function supportsServiceTier(
  model: ModelChoice['model'] | undefined,
  serviceTier: string | undefined,
): boolean {
  return Boolean(serviceTier && model?.serviceTiers.some((tier) => tier.id === serviceTier))
}

/** Carries fast intent across models whose fast tiers use different ids. */
export function getNextServiceTierForModel(input: {
  nextModel: ModelChoice['model']
  currentModel: ModelChoice['model'] | undefined
  currentServiceTier: string | undefined
}): string | undefined {
  const { nextModel, currentModel, currentServiceTier } = input
  if (isFastModeEnabled(currentModel, currentServiceTier)) {
    return getFastServiceTier(nextModel)?.id ?? getFastModeOffValue(nextModel)
  }
  if (supportsServiceTier(nextModel, currentServiceTier)) {
    return currentServiceTier
  }
  return getFastModeOffValue(nextModel)
}
