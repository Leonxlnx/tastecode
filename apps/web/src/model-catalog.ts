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
    const searchableText =
      `${choice.sourceName} ${choice.model.displayName} ${choice.model.id}`.toLowerCase()
    return terms.every((term) => searchableText.includes(term))
  })
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

/** The id defaults and migrations match: lowercase, without context or snapshot-date suffix. */
function visibilityId(model: Model): string {
  return model.id.toLowerCase().replace(LONG_CONTEXT_SUFFIX, '').replace(SNAPSHOT_DATE_SUFFIX, '')
}

const NAME_SEPARATOR = /[\s-]+/
const VERSION_WORD = /^\d+(?:\.\d+)*$/
const FAMILY_WORD = /^[a-z]+$/

type Lineage = { family: string; version: number[] }

/**
 * A model's family and generation, read from its display name: plain words
 * around exactly one version number, such as `GPT-6.1-Sol` (family `gpt sol`,
 * 6.1) or `Opus 5.5` (family `opus`, 5.5). The name works for every provider,
 * including Claude Code's aliases, whose ids carry no version. A name that
 * does not read this way has no lineage and is never hidden for its age.
 */
function modelLineage(model: Model): Lineage | undefined {
  if (typeof model.displayName !== 'string') return undefined
  const words = model.displayName.trim().toLowerCase().split(NAME_SEPARATOR).filter(Boolean)
  const versions = words.filter((word) => VERSION_WORD.test(word))
  const family = words.filter((word) => !VERSION_WORD.test(word))
  if (versions.length !== 1 || family.length === 0) return undefined
  if (!family.every((word) => FAMILY_WORD.test(word))) return undefined
  return { family: family.join(' '), version: versions[0]!.split('.').map(Number) }
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Rows that can be superseded, by source and family. Custom models never are. */
function lineageRows(choices: readonly ModelChoice[]) {
  const families = new Map<string, { choice: ModelChoice; version: number[] }[]>()
  for (const choice of choices) {
    if (isCustomModelChoice(choice)) continue
    const lineage = modelLineage(choice.model)
    if (!lineage) continue
    const family = `${sourceKey({ provider: choice.provider, agentId: choice.agent?.id })}\n${lineage.family}`
    const rows = families.get(family)
    const row = { choice, version: lineage.version }
    if (rows) rows.push(row)
    else families.set(family, [row])
  }
  return families.values()
}

/**
 * Keys of the choices that start hidden in this catalog: known legacy models,
 * and every model whose source also lists a newer generation of its family,
 * so `gpt-6.1-sol` replaces `gpt-6-sol` and `Opus 5.5` replaces `Opus 5`.
 * A new release needs no change here; it starts visible by being newest.
 */
export function defaultHiddenModelKeys(choices: readonly ModelChoice[]): Set<string> {
  const hidden = new Set<string>()
  for (const choice of choices) {
    if (DEFAULT_HIDDEN_MODELS.has(visibilityId(choice.model))) hidden.add(choice.key)
  }
  for (const rows of lineageRows(choices)) {
    let newest = rows[0]!.version
    for (const row of rows) if (compareVersions(row.version, newest) > 0) newest = row.version
    for (const row of rows) {
      if (compareVersions(row.version, newest) < 0) hidden.add(row.choice.key)
    }
  }
  return hidden
}

/** The choices that start hidden in this catalog. */
export function defaultHiddenModels(choices: readonly ModelChoice[]): ModelChoice[] {
  const hidden = defaultHiddenModelKeys(choices)
  return choices.filter((choice) => hidden.has(choice.key))
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

/**
 * Lineages by listed model. A refresh keeps the model objects of every source
 * it did not relist, so recomputing the defaults per settled source only
 * reads the names that are new.
 */
const lineageByModel = new WeakMap<Model, ModelLineage | null>()

function listedLineage(model: Model): ModelLineage | undefined {
  let lineage = lineageByModel.get(model)
  if (lineage === undefined) {
    lineage = readModelLineage(model.displayName) ?? null
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
 * the source lists a newer generation of its family, or when the source
 * still has more than 20 rows after those two rules and the choice is
 * neither among the first 4 of them in the adapter's order nor the source's
 * default. Custom models always start visible. One pass over the catalog,
 * with nothing to migrate when a rule or a provider's lineup changes.
 */
export function modelVisibilityDefaults(choices: readonly ModelChoice[]): ModelVisibilityDefaults {
  const hidden = new Set<string>()
  const supersededBy = new Map<string, string>()
  const stock: { choice: ModelChoice; source: string }[] = []
  const families = new Map<string, { newest: LineageMember; members: LineageMember[] }>()
  for (const choice of choices) {
    if (isCustomModelChoice(choice)) continue
    const source = sourceKey({
      provider: choice.provider,
      connectionId: choice.connectionId,
      agentId: choice.agent?.id,
    })
    stock.push({ choice, source })
    if (DEFAULT_HIDDEN_MODELS.has(visibilityId(choice.model))) hidden.add(choice.key)
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

/**
 * Choices a saved profile should hide now that `choices` lists models it has
 * never listed: each new model that starts hidden, and each listed model a new
 * generation of its family replaces. The handover happens once, when the new
 * generation is first listed, so turning the older one back on sticks. A model
 * can appear long after the profile was set up: a new release, a newly
 * installed provider, or an older catalog row that an alias used to stand in
 * for. Without a record of the listed keys, a new model cannot be told apart
 * from one the user turned on, so nothing is returned.
 */
export function unlistedHiddenModels(
  choices: readonly ModelChoice[],
  listed: ReadonlySet<string> | null,
): ModelChoice[] {
  if (!listed) return []
  const hidden = defaultHiddenModelKeys(choices)
  const handedOver = new Set<string>()
  for (const rows of lineageRows(choices)) {
    for (const successor of rows) {
      // Only a new newest generation takes over, not an older row that shows up late.
      if (listed.has(successor.choice.key) || hidden.has(successor.choice.key)) continue
      for (const row of rows) {
        if (listed.has(row.choice.key) && compareVersions(row.version, successor.version) < 0) {
          handedOver.add(row.choice.key)
        }
      }
    }
  }
  return choices.filter((choice) =>
    listed.has(choice.key) ? handedOver.has(choice.key) : hidden.has(choice.key),
  )
}

/**
 * Raise together with an entry in `MODEL_VISIBILITY_CHANGES` when a default
 * above changes for models a saved profile already lists.
 */
export const MODEL_VISIBILITY_VERSION = '8'

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
  // Codex's defaults came from a fixed list that hid every GPT-5.6 tier. They
  // now follow the generation rule, so Codex rows return to the newest of
  // each tier once; every other source keeps its choices.
  [8, { sources: ['codex'] }],
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

/**
 * Move a saved visibility profile onto the current defaults for the models in
 * `choices`. `defaults` are the keys hidden by default in the whole catalog,
 * which can be larger than `choices`.
 */
export function migrateHiddenModels(
  hidden: ReadonlySet<string>,
  storedVersion: string | null,
  choices: readonly ModelChoice[],
  defaults: ReadonlySet<string> = defaultHiddenModelKeys(choices),
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
    if (defaults.has(choice.key)) migrated.add(choice.key)
    else migrated.delete(choice.key)
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
  const defaults = defaultHiddenModelKeys(choices)
  for (const [version, rows] of pending) {
    migrated = migrateHiddenModels(migrated, version, rows, defaults)
  }
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
