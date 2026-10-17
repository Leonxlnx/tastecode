import type { Model, ProviderId } from '@harness/contracts'
import type { ProviderMark } from './provider-presentation.js'
import { providerPresentation, sourcePresentation } from './provider-presentation.js'

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
    // The lab a source declares finds a model whose name does not carry it:
    // "google" finds Gemini, "moonshot" finds Kimi.
    const searchableText =
      `${choice.sourceName} ${choice.model.lab ?? ''} ${choice.model.displayName} ${choice.model.id}`.toLowerCase()
    return terms.every((term) => searchableText.includes(term))
  })
}

/** One creator lab's models within a source, in the order the source lists them. */
export type ModelLabGroup = {
  /** The lab folded to lower case, or '' for the rows that name no lab. */
  key: string
  /** The lab as the source first spells it; undefined for the rows that name none. */
  lab: string | undefined
  choices: ModelChoice[]
}

/**
 * A source's models grouped by the lab that made them (`model.lab`), labs in
 * the order the source first lists them and the rows that name no lab last.
 */
export function groupModelChoicesByLab(choices: readonly ModelChoice[]): ModelLabGroup[] {
  const groups = new Map<string, ModelLabGroup>()
  for (const choice of choices) {
    const lab = choice.model.lab?.trim() || undefined
    const key = lab?.toLowerCase() ?? ''
    const group = groups.get(key)
    if (group) group.choices.push(choice)
    else groups.set(key, { key, lab, choices: [choice] })
  }
  const unlabeled = groups.get('')
  if (!unlabeled) return [...groups.values()]
  groups.delete('')
  return [...groups.values(), unlabeled]
}

/** Legacy models that start hidden although nothing in their family replaces them. */
const DEFAULT_HIDDEN_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'grok-4.7-build-fast',
])

const LONG_CONTEXT_SUFFIX = /\[1m\]$/
const SNAPSHOT_DATE_SUFFIX = /-\d{8}$/

/** The id the legacy models above are listed by: lowercase, without context or snapshot-date suffix. */
function visibilityId(model: Model): string {
  return model.id.toLowerCase().replace(LONG_CONTEXT_SUFFIX, '').replace(SNAPSHOT_DATE_SUFFIX, '')
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const LINEAGE_SEPARATOR = /[\s\-_/·:()]+/
const LINEAGE_DIGIT = /\d/
/** A version with an optional letter prefix, or a context size such as `1m` or `300k`. */
const LINEAGE_NUMBER = /^([a-z]*)(\d+(?:\.\d+)*)([km]?)$/
const LINEAGE_LETTER = /[a-z]/

/** The family a model belongs to within its source, and its generation there. */
export type ModelLineage = { family: string; generation: readonly number[] }

/**
 * Read a lineage from a display name: its words around exactly one version,
 * which may carry a letter prefix such as `V4.1`, `M2.7` or `Qwen3.6`. The
 * family is the name with that version left out, so `GPT-6.1-Sol` and
 * `GPT-5.6-Sol` share `gpt # sol`, and `MiniMax-M3` and `MiniMax-M2.7` share
 * `minimax m#`. A context size such as `1M` or `300K` is not part of the
 * name, and an integer of four or more digits is a date or a size, never a
 * generation. A name without a version, or with more than one, has none.
 */
export function readModelLineage(displayName: string): ModelLineage | undefined {
  const family: string[] = []
  let generation: number[] | undefined
  for (const token of displayName.toLowerCase().split(LINEAGE_SEPARATOR)) {
    if (!token) continue
    const numeric = LINEAGE_DIGIT.test(token) ? LINEAGE_NUMBER.exec(token) : null
    const prefix = numeric?.[1] ?? ''
    const digits = numeric?.[2] ?? ''
    const firstDot = digits.indexOf('.')
    if (numeric?.[3]) {
      // `1m` and `300k` are context sizes and drop out; `v4k` stays a word.
      if (!prefix && firstDot === digits.lastIndexOf('.')) continue
      family.push(token)
      continue
    }
    if (!numeric || (firstDot < 0 && digits.length >= 4)) {
      family.push(token)
      continue
    }
    if (generation) return undefined
    generation = digits.split('.').map(Number)
    family.push(`${prefix}#`)
  }
  const name = family.join(' ')
  return generation && LINEAGE_LETTER.test(name) ? { family: name, generation } : undefined
}

const DECLARED_GENERATION = /^\d+(?:\.\d+)*$/

/**
 * The lineage an adapter declared, when it declared both parts. Declared
 * families live apart from the ones read out of names, so a declared
 * `gpt-terra` never meets a parsed `gpt # terra` of the same source.
 */
function declaredLineage(model: Model): ModelLineage | undefined {
  const { family, generation } = model
  if (!family || !generation || !DECLARED_GENERATION.test(generation)) return undefined
  return { family: `declared:${family}`, generation: generation.split('.').map(Number) }
}

/**
 * Lineages by listed model. A refresh keeps the model objects of every source
 * it did not relist, so recomputing the defaults per settled source only
 * reads the names that are new.
 */
const lineageByModel = new WeakMap<Model, ModelLineage | null>()

function listedLineage(model: Model): ModelLineage | undefined {
  let lineage = lineageByModel.get(model)
  if (lineage === undefined) {
    lineage = declaredLineage(model) ?? readModelLineage(model.displayName) ?? null
    lineageByModel.set(model, lineage)
  }
  return lineage ?? undefined
}

/** A source with more rows than this starts with only a few of them visible. */
const LARGE_SOURCE_ROWS = 20
const LARGE_SOURCE_VISIBLE_ROWS = 4

/** How every choice in a catalog starts out, before any choice of the user's. */
export type ModelVisibilityDefaults = {
  /** Keys of the choices that start hidden. */
  hidden: ReadonlySet<string>
  /** For a choice its source lists a newer generation of, that newest key. */
  supersededBy: ReadonlyMap<string, string>
}

type LineageMember = { key: string; generation: readonly number[] }

/**
 * The visibility each choice starts with, from the catalog alone. Within its
 * own source, a choice starts hidden when it is a known legacy model, when
 * the adapter marks it deprecated, or when the source lists a newer
 * generation of its family (the family and generation the adapter declared,
 * otherwise the ones its name reads as). A source whose adapter recommends
 * any of its rows then shows only those and its default. Any other source
 * that still has more than 20 rows shows only the first 4 of them in the
 * adapter's order and its default. Custom models always start visible. One
 * pass over the catalog, with nothing to migrate when a rule or a provider's
 * lineup changes.
 */
export function modelVisibilityDefaults(choices: readonly ModelChoice[]): ModelVisibilityDefaults {
  const hidden = new Set<string>()
  const supersededBy = new Map<string, string>()
  const stock: { choice: ModelChoice; source: string }[] = []
  const curatedSources = new Set<string>()
  const families = new Map<string, { newest: LineageMember; members: LineageMember[] }>()
  for (const choice of choices) {
    if (isCustomModelChoice(choice)) continue
    const source = sourceKey({
      provider: choice.provider,
      connectionId: choice.connectionId,
      agentId: choice.agent?.id,
    })
    stock.push({ choice, source })
    if (choice.model.recommended === true) curatedSources.add(source)
    if (DEFAULT_HIDDEN_MODELS.has(visibilityId(choice.model))) hidden.add(choice.key)
    // A retiring model starts hidden and never takes over from an older one.
    if (choice.model.deprecated === true) {
      hidden.add(choice.key)
      continue
    }
    const lineage = listedLineage(choice.model)
    if (!lineage) continue
    const member = { key: choice.key, generation: lineage.generation }
    const familyKey = `${source}\n${lineage.family}`
    const family = families.get(familyKey)
    if (!family) {
      families.set(familyKey, { newest: member, members: [member] })
      continue
    }
    family.members.push(member)
    if (compareVersions(member.generation, family.newest.generation) > 0) family.newest = member
  }
  for (const { newest, members } of families.values()) {
    for (const member of members) {
      if (compareVersions(member.generation, newest.generation) >= 0) continue
      hidden.add(member.key)
      supersededBy.set(member.key, newest.key)
    }
  }
  const remaining = new Map<string, ModelChoice[]>()
  for (const { choice, source } of stock) {
    if (hidden.has(choice.key)) continue
    if (curatedSources.has(source)) {
      if (choice.model.recommended !== true && !choice.model.isDefault) hidden.add(choice.key)
      continue
    }
    const rows = remaining.get(source)
    if (rows) rows.push(choice)
    else remaining.set(source, [choice])
  }
  for (const rows of remaining.values()) {
    if (rows.length <= LARGE_SOURCE_ROWS) continue
    rows.forEach((choice, index) => {
      if (index >= LARGE_SOURCE_VISIBLE_ROWS && !choice.model.isDefault) hidden.add(choice.key)
    })
  }
  return { hidden, supersededBy }
}

/** A visibility the user chose for one model, and when. */
export type ModelVisibilityOverride = { visible: boolean; at: number }

/**
 * The keys hidden right now: a choice's own override when it has one, its
 * default otherwise. Showing a superseded model sticks only when the user did
 * so after its successor was first listed. An older choice predates that
 * generation, which takes over once, and so does a successor without a
 * recorded first sighting, which has only just been listed.
 */
export function effectiveHiddenModels(
  choices: readonly ModelChoice[],
  defaults: ModelVisibilityDefaults,
  overrides: Readonly<Record<string, ModelVisibilityOverride>>,
  firstSeen: Readonly<Record<string, number>>,
): Set<string> {
  const hidden = new Set<string>()
  for (const { key } of choices) {
    const override = Object.hasOwn(overrides, key) ? overrides[key] : undefined
    if (!override) {
      if (defaults.hidden.has(key)) hidden.add(key)
      continue
    }
    if (!override.visible) {
      hidden.add(key)
      continue
    }
    const successor = defaults.supersededBy.get(key)
    if (successor === undefined) continue
    const successorSeen = Object.hasOwn(firstSeen, successor) ? firstSeen[successor] : undefined
    if (successorSeen === undefined || override.at < successorSeen) hidden.add(key)
  }
  return hidden
}

/**
 * Overrides for a profile saved as one complete hidden list, which mixed the
 * user's own choices with the defaults of the build that saved it. A hidden
 * model that the current defaults show, or that this catalog does not list,
 * becomes a hidden override, so nothing the user hid comes back. Every other
 * model returns to the current defaults once: one hidden by default needs no
 * override, and an older generation the profile still showed is hidden now.
 */
export function importLegacyVisibility(
  legacyHidden: Iterable<string>,
  choices: readonly ModelChoice[],
  defaults: ModelVisibilityDefaults,
  now: number,
): Record<string, ModelVisibilityOverride> {
  const listed = new Set(choices.map((choice) => choice.key))
  const entries: [string, ModelVisibilityOverride][] = []
  for (const key of legacyHidden) {
    if (listed.has(key) && defaults.hidden.has(key)) continue
    entries.push([key, { visible: false, at: now }])
  }
  // Built as own data properties, whatever a stored key looks like.
  return Object.fromEntries(entries)
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

export function sourceKey(input: {
  provider: ProviderId
  connectionId?: string | undefined
  agentId?: string | undefined
}): string {
  if (input.connectionId) return `api:${input.connectionId}`
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

export function customModelChoice(
  input: CustomModelInput,
  sourceName = providerPresentation(input.provider).label,
  mark = providerPresentation(input.provider).mark,
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
  // An agent identity on a direct provider means this is a user-owned
  // executable, whose chosen name is the source identity. Stock provider
  // discovery remains canonical even if a transport reports another label.
  const presentation = input.agent
    ? { label: input.sourceName.trim(), mark: input.mark }
    : sourcePresentation(input)
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
