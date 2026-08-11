import type { Model, ProviderId } from '@harness/contracts'
import type { ProviderMark } from './provider-presentation.js'
import { sourcePresentation } from './provider-presentation.js'

export {
  agentMark,
  connectionMark,
  providerDisplayName,
  providerMark,
} from './provider-presentation.js'
export type { ProviderMark } from './provider-presentation.js'

export type ModelChoice = {
  key: string
  provider: ProviderId
  sourceName: string
  mark: ProviderMark
  connectionId?: string | undefined
  agent?: { id: string; name: string } | undefined
  model: Model
}

/** A user-defined model the provider may accept without listing it. */
export type CustomModelInput = {
  provider: ProviderId
  /** The exact id the adapter hands to the engine, e.g. `qwen-max`. */
  modelId: string
  /** Shown in the picker; falls back to the model id when empty. */
  displayName: string
}

const MODEL_SEARCH_WHITESPACE = /\s+/

export function filterModelChoicesByQuery(choices: ModelChoice[], query: string): ModelChoice[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return choices

  const terms = normalizedQuery.split(MODEL_SEARCH_WHITESPACE)
  return choices.filter((choice) => {
    const searchableText =
      `${choice.sourceName} ${choice.model.displayName} ${choice.model.id}`.toLowerCase()
    return terms.every((term) => searchableText.includes(term))
  })
}

const REASONING_EFFORT_RANKS = new Map([
  ['none', 0],
  ['minimal', 1],
  ['xlow', 2],
  ['extralow', 2],
  ['low', 3],
  ['medium', 4],
  ['high', 5],
  ['xhigh', 6],
  ['extrahigh', 6],
  ['max', 7],
  ['maximum', 7],
  ['ultra', 8],
])

function reasoningEffortRank(value: string): number | undefined {
  return REASONING_EFFORT_RANKS.get(value.toLowerCase().replace(/[^a-z]/g, ''))
}

function defaultReasoningEffort(model: Model): string | undefined {
  return model.defaultReasoningEffort &&
    model.reasoningEfforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : model.reasoningEfforts[0]
}

export function resolveReasoningEffort(input: {
  currentEffort: string | undefined
  currentModel?: Model | undefined
  nextModel: Model
}): string | undefined {
  const nextEfforts = input.nextModel.reasoningEfforts
  if (nextEfforts.length === 0) return undefined
  if (!input.currentEffort) return defaultReasoningEffort(input.nextModel)

  const currentEfforts = input.currentModel?.reasoningEfforts ?? []
  const currentIndex = currentEfforts.indexOf(input.currentEffort)

  // Catalogue order already drives the slider from low to high. Carrying its
  // top endpoint across models preserves the user's intent even when one model
  // calls that level "high" and another calls it "max" or "ultra".
  if (currentEfforts.length > 1 && currentIndex === currentEfforts.length - 1) {
    return nextEfforts[nextEfforts.length - 1]
  }
  if (nextEfforts.includes(input.currentEffort)) return input.currentEffort

  if (currentIndex >= 0 && currentEfforts.length > 1) {
    const relativeIndex = Math.round(
      (currentIndex / (currentEfforts.length - 1)) * (nextEfforts.length - 1),
    )
    return nextEfforts[relativeIndex]
  }

  const currentRank = reasoningEffortRank(input.currentEffort)
  if (currentRank !== undefined) {
    let closest: { effort: string; distance: number; rank: number } | undefined
    for (const effort of nextEfforts) {
      const rank = reasoningEffortRank(effort)
      if (rank === undefined) continue
      const distance = Math.abs(rank - currentRank)
      if (
        !closest ||
        distance < closest.distance ||
        (distance === closest.distance && rank > closest.rank)
      ) {
        closest = { effort, distance, rank }
      }
    }
    if (closest) return closest.effort
  }

  return defaultReasoningEffort(input.nextModel)
}

export function sourceKey(input: {
  provider: ProviderId
  connectionId?: string | undefined
  agentId?: string | undefined
}): string {
  if (input.connectionId) return `api:${input.connectionId}`
  if (input.agentId) return `acp:${input.agentId}`
  return input.provider
}

export function modelChoiceKey(source: string, modelId: string): string {
  return `${source}:${encodeURIComponent(modelId || 'automatic')}`
}

export function automaticModel(): Model {
  return {
    id: '',
    // Only shown when a provider cannot enumerate its models at all — name
    // the honest behavior, never the word "Automatic".
    displayName: 'Provider default',
    description: 'The model this provider is configured to use',
    isDefault: true,
    reasoningEfforts: [],
    serviceTiers: [],
  }
}

/**
 * Source bucket for custom models. It is deliberately distinct from the
 * provider's own source key: a custom id may already exist in the provider's
 * catalog, and the two must never share a choice key.
 */
export function customModelSource(provider: ProviderId): string {
  return `custom:${provider}`
}

export function customModelKey(input: CustomModelInput): string {
  return modelChoiceKey(customModelSource(input.provider), input.modelId)
}

export function customModelChoice(
  input: CustomModelInput,
  sourceName: string,
  mark: ProviderMark,
): ModelChoice {
  const presentation = sourcePresentation({ provider: input.provider, sourceName, mark })
  return {
    provider: input.provider,
    sourceName: presentation.label,
    mark: presentation.mark,
    model: {
      id: input.modelId,
      displayName: input.displayName.trim() || input.modelId,
      description: 'Custom model',
      isDefault: false,
      reasoningEfforts: [],
      serviceTiers: [],
    },
    key: customModelKey(input),
  }
}

export function isCustomModelChoice(choice: ModelChoice): boolean {
  return choice.key.startsWith('custom:')
}

export function choicesFor(
  input: Omit<ModelChoice, 'key' | 'model'>,
  models: Model[],
  fallback = true,
): ModelChoice[] {
  const presentation = sourcePresentation(input)
  const source = sourceKey({
    provider: input.provider,
    connectionId: input.connectionId,
    agentId: input.agent?.id,
  })
  return (models.length > 0 ? models : fallback ? [automaticModel()] : []).map((model) => ({
    ...input,
    sourceName: presentation.label,
    mark: presentation.mark,
    model,
    key: modelChoiceKey(source, model.id),
  }))
}
