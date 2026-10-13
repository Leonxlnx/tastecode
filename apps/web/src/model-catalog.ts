import type { Model, ProviderId } from '@harness/contracts'
import type { ProviderMark } from './provider-presentation.js'
import { providerPresentation } from './provider-presentation.js'

export { providerDisplayName, providerMark } from './provider-presentation.js'
export type { ProviderMark } from './provider-presentation.js'

export type ModelChoice = {
  key: string
  provider: ProviderId
  sourceName: string
  mark: ProviderMark
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

const DEFAULT_HIDDEN_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'grok-4.7-build-fast',
])

/**
 * The newest generation of each Claude family. Any older generation starts
 * hidden, whether it is listed as `claude-opus-5` or as a dated snapshot such
 * as `claude-haiku-4-5-20251001`. Claude Code's bare aliases (`fable`, `opus`,
 * `sonnet`, `haiku`) always resolve to the newest generation, so they carry no
 * version here and start visible.
 */
const CURRENT_CLAUDE_GENERATIONS = new Map<string, readonly [major: number, minor: number]>([
  ['fable', [5, 1]],
  ['opus', [5, 5]],
  ['sonnet', [5, 5]],
  ['haiku', [5, 5]],
])
const CLAUDE_GENERATION_ID = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/
const LONG_CONTEXT_SUFFIX = /\[1m\]$/
const SNAPSHOT_DATE_SUFFIX = /-\d{8}$/

/** The id defaults and migrations match: lowercase, without context or snapshot-date suffix. */
function visibilityId(model: Model): string {
  return model.id.toLowerCase().replace(LONG_CONTEXT_SUFFIX, '').replace(SNAPSHOT_DATE_SUFFIX, '')
}

function olderClaudeGeneration(id: string): boolean {
  const match = CLAUDE_GENERATION_ID.exec(id)
  const current = match ? CURRENT_CLAUDE_GENERATIONS.get(match[1]!) : undefined
  if (!match || !current) return false
  const major = Number(match[2])
  const minor = Number(match[3] ?? 0)
  return major < current[0] || (major === current[0] && minor < current[1])
}

/** Hide known older models while letting newly discovered models start enabled. */
export function modelVisibleByDefault(model: Model): boolean {
  const id = visibilityId(model)
  return !DEFAULT_HIDDEN_MODELS.has(id) && !olderClaudeGeneration(id)
}

/**
 * Choices a saved profile has never listed and that start hidden. A model can
 * appear long after the profile was set up: a newly installed provider, or an
 * older catalog row that an alias used to stand in for. Without a record of the
 * listed keys, a new model cannot be told apart from one the user turned on, so
 * nothing is returned.
 */
export function unlistedHiddenModels(
  choices: readonly ModelChoice[],
  listed: ReadonlySet<string> | null,
): ModelChoice[] {
  if (!listed) return []
  return choices.filter((choice) => !listed.has(choice.key) && !modelVisibleByDefault(choice.model))
}

/**
 * Raise together with an entry in `MODEL_VISIBILITY_CHANGES` when a default
 * above changes for models a saved profile already lists.
 */
export const MODEL_VISIBILITY_VERSION = '7'

type VisibilityChange = {
  /** Models, by visibility id, whose default changed. */
  ids?: readonly string[]
  /** Stock sources whose every listed model goes back to its default. */
  sources?: readonly string[]
}

/**
 * What each version changed. A profile saved at version 4 or later only has
 * these models moved to their default, so its other manual choices survive
 * the upgrade.
 */
const MODEL_VISIBILITY_CHANGES = new Map<number, VisibilityChange>([
  // Claude Code's `haiku` alias now resolves to Haiku 5.5, the current small model.
  [5, { ids: ['haiku'] }],
  // While `opus`, `sonnet` and `haiku` resolved to the 5.0 generation, their
  // alias rows stood in for these catalog rows. Once the aliases moved to 5.5
  // the older rows came back under their own ids and, being unknown to the
  // saved profile, started visible.
  [6, { ids: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] }],
  // Profiles saved by older builds can still hide the `sonnet` and `haiku`
  // aliases from when they named an older generation, and show the dated
  // Haiku 4.5 row the id list never matched. Claude Code's rows return to
  // the current lineup once; every other source keeps its choices.
  [7, { sources: ['claude-code'] }],
])
const FIRST_INCREMENTAL_VISIBILITY_VERSION = 4

function changedSince(
  choice: ModelChoice,
  changed: { ids: ReadonlySet<string>; sources: ReadonlySet<string> },
): boolean {
  if (changed.ids.has(visibilityId(choice.model))) return true
  if (isCustomModelChoice(choice)) return false
  return changed.sources.has(sourceKey({ provider: choice.provider, agentId: choice.agent?.id }))
}

/** Move a saved visibility profile onto the current defaults for the models in `choices`. */
export function migrateHiddenModels(
  hidden: ReadonlySet<string>,
  storedVersion: string | null,
  choices: readonly ModelChoice[],
): Set<string> {
  const migrated = new Set(hidden)
  if (storedVersion === MODEL_VISIBILITY_VERSION) return migrated
  const from = Number(storedVersion)
  const to = Number(MODEL_VISIBILITY_VERSION)
  // Older or unknown profiles predate incremental changes and take every default once.
  let changed: { ids: Set<string>; sources: Set<string> } | undefined
  if (Number.isInteger(from) && from >= FIRST_INCREMENTAL_VISIBILITY_VERSION && from < to) {
    changed = { ids: new Set(), sources: new Set() }
    for (let version = from + 1; version <= to; version += 1) {
      const change = MODEL_VISIBILITY_CHANGES.get(version)
      for (const id of change?.ids ?? []) changed.ids.add(id)
      for (const source of change?.sources ?? []) changed.sources.add(source)
    }
  }
  for (const choice of choices) {
    if (changed && !changedSince(choice, changed)) continue
    if (modelVisibleByDefault(choice.model)) migrated.delete(choice.key)
    else migrated.add(choice.key)
  }
  return migrated
}

/**
 * How far a saved visibility profile has come: the version every row last
 * reached together, and the rows a pending migration has already moved on
 * their own, by choice key, each with the version it reached.
 */
export type ModelVisibilityProgress = {
  version: string | null
  rows: ReadonlyMap<string, string>
}

/** The hidden list after a migration, and the choice keys it moved. */
export type ModelVisibilityMigration = { hidden: Set<string>; migrated: string[] }

/**
 * Apply the pending migration to each row in `choices` that has not had it
 * yet, and name the rows it moved. A row is migrated once, as soon as it is
 * known, whether from the cached catalog or from its source's listing: a later
 * run must not undo what the user chose since, and a source that cannot be
 * listed must not hold back the others.
 */
export function migratePendingHiddenModels(
  hidden: ReadonlySet<string>,
  progress: ModelVisibilityProgress,
  choices: readonly ModelChoice[],
): ModelVisibilityMigration {
  const pending = new Map<string | null, ModelChoice[]>()
  for (const choice of choices) {
    const version = progress.rows.get(choice.key) ?? progress.version
    if (version === MODEL_VISIBILITY_VERSION) continue
    const rows = pending.get(version)
    if (rows) rows.push(choice)
    else pending.set(version, [choice])
  }
  let migrated = new Set(hidden)
  for (const [version, rows] of pending) migrated = migrateHiddenModels(migrated, version, rows)
  return {
    hidden: migrated,
    migrated: [...pending.values()].flatMap((rows) => rows.map((choice) => choice.key)),
  }
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
  ['ultracode', 8],
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

export function sourceKey(input: { provider: ProviderId; agentId?: string | undefined }): string {
  if (input.agentId) return `${input.provider}:${input.agentId}`
  return input.provider
}

export function modelChoiceKey(source: string, modelId: string): string {
  return `${source}:${encodeURIComponent(modelId || 'automatic')}`
}

function automaticModel(): Model {
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
function customModelSource(provider: ProviderId): string {
  return `custom:${provider}`
}

export function customModelKey(input: CustomModelInput): string {
  return modelChoiceKey(customModelSource(input.provider), input.modelId)
}

export function customModelChoice(input: CustomModelInput): ModelChoice {
  const presentation = providerPresentation(input.provider)
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
  // An agent identity on a direct provider means this is a user-owned
  // executable, whose chosen name is the source identity. Stock provider
  // discovery remains canonical even if a transport reports another label.
  const presentation = input.agent
    ? { label: input.sourceName.trim(), mark: input.mark }
    : providerPresentation(input.provider)
  const source = sourceKey({ provider: input.provider, agentId: input.agent?.id })
  return (models.length > 0 ? models : fallback ? [automaticModel()] : []).map((model) => ({
    ...input,
    sourceName: presentation.label,
    mark: presentation.mark,
    model,
    key: modelChoiceKey(source, model.id),
  }))
}
