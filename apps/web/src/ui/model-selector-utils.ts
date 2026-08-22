import { resolveReasoningEffort, sourceKey, type ModelChoice } from '../model-catalog.js'
import { getFastServiceTier } from '../model-service-tier.js'

export const SLIDER_DITHER_MIN_WIDTH = 44
export const SLIDER_DITHER_INSET = 2

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

export function getEffortIndexFromPointer(input: {
  clientX: number
  left: number
  width: number
  stopCount: number
}): number {
  if (input.stopCount <= 1) return 0
  return Math.round(getEffortProgressFromPointer(input) * (input.stopCount - 1))
}

export function getEffortProgressFromPointer(input: {
  clientX: number
  left: number
  width: number
}): number {
  const innerWidth = input.width - SLIDER_DITHER_INSET * 2
  if (innerWidth <= SLIDER_DITHER_MIN_WIDTH) return 0
  const travelWidth = innerWidth - SLIDER_DITHER_MIN_WIDTH
  const relativeX = input.clientX - input.left - SLIDER_DITHER_INSET - SLIDER_DITHER_MIN_WIDTH
  return Math.min(1, Math.max(0, relativeX / travelWidth))
}

export function modelSourceKey(entry: ModelChoice): string {
  return sourceKey({
    provider: entry.provider,
    connectionId: entry.connectionId,
    agentId: entry.agent?.id,
  })
}

export function groupModelsBySource(models: ModelChoice[]): ModelGroup[] {
  const groups: ModelGroup[] = []
  const groupsByKey = new Map<string, ModelGroup>()
  for (const entry of models) {
    const key = modelSourceKey(entry)
    const group = groupsByKey.get(key)
    if (group) group.entries.push(entry)
    else {
      const next = { key, name: entry.sourceName, mark: entry.mark, entries: [entry] }
      groupsByKey.set(key, next)
      groups.push(next)
    }
  }
  return groups
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

export {
  getFastModeOffValue,
  getFastServiceTier,
  getNextServiceTierForModel,
} from '../model-service-tier.js'
