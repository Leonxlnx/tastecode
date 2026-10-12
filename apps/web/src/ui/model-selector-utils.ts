import { resolveReasoningEffort, sourceKey, type ModelChoice } from '../model-catalog.js'
import { PROVIDER_ORDER, providerRank } from '../provider-presentation.js'

/** The gap between effort meter segments, mirrored in model-selector-menu.css. */
export const EFFORT_METER_GAP = 4
/** How far a drag must travel into the next segment before the level follows it. */
export const EFFORT_METER_HOLD = 6

export type ModelSelectorProps = {
  models: ModelChoice[]
  modelId: string | undefined
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

export function getCompactModelName(displayName: string | undefined): string {
  if (!displayName) return 'Model'
  return displayName
    .replace(/^gpt[-\s]*/i, '')
    .replace(/-/g, ' ')
    .trim()
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
 * The segment under the pointer. Each segment owns the gap after it, so the
 * whole meter is clickable. While a drag holds a level (`currentIndex`), the
 * level only follows once the pointer is EFFORT_METER_HOLD pixels into the
 * neighbouring segment: a hand resting on a boundary does not flicker.
 */
export function getEffortIndexFromPointer(input: {
  clientX: number
  left: number
  width: number
  stopCount: number
  currentIndex?: number | null
}): number {
  const count = input.stopCount
  if (count <= 1) return 0
  if (input.width <= 0) return 0
  const pitch = (input.width + EFFORT_METER_GAP) / count
  const x = input.clientX - input.left
  const segmentAt = (position: number) =>
    Math.min(count - 1, Math.max(0, Math.floor(position / pitch)))
  const index = segmentAt(x)
  const current = input.currentIndex
  if (current == null || index === current) return index
  return index > current
    ? Math.max(current, segmentAt(x - EFFORT_METER_HOLD))
    : Math.min(current, segmentAt(x + EFFORT_METER_HOLD))
}

export function modelSourceKey(entry: ModelChoice): string {
  return sourceKey({ provider: entry.provider, agentId: entry.agent?.id })
}

/**
 * Discovery settles sources in whatever order they answer, so the catalog's
 * order shifts while models load. Stock providers therefore take their place
 * in `PROVIDER_ORDER`, and custom harnesses follow in the order they arrived
 * (the sort is stable), so groups hold still instead of jumping.
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
      ranks.set(next, entry.agent ? PROVIDER_ORDER.length : providerRank(entry.provider))
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
