import {
  effectiveHiddenModels,
  importLegacyVisibility,
  modelVisibilityDefaults,
  type ModelChoice,
  type ModelVisibilityDefaults,
  type ModelVisibilityOverride,
} from './model-catalog.js'

/**
 * Model visibility as saved: only what the user chose, and when each newer
 * generation was first listed. Defaults are never saved; they follow the
 * catalog, so a new release replaces its older generation without a
 * migration.
 */
export type ModelVisibilityRecord = {
  readonly overrides: Readonly<Record<string, ModelVisibilityOverride>>
  /** By successor key: when a newer generation of a listed family first appeared. */
  readonly firstSeen: Readonly<Record<string, number>>
  /**
   * What a profile saved before this record hid in sources the launch
   * catalog did not list. Each source's keys are imported once it is listed.
   */
  readonly legacyHidden?: readonly string[] | undefined
}

export const EMPTY_MODEL_VISIBILITY: ModelVisibilityRecord = { overrides: {}, firstSeen: {} }

/**
 * A discovered source can stop listing a model for a while: a slow discovery
 * that falls back to other ids, a provider that is briefly disconnected. The
 * user's choices for the most recent of those models survive that; older
 * ones go, so a bulk choice over a catalog that later shrinks cannot grow
 * the record without bound.
 */
const UNLISTED_OVERRIDES_PER_SOURCE = 50

/**
 * The source part of a choice key, such as `codex`, `acp:kimi` or
 * `custom:codex`. The model id after it is URI-encoded, so it holds no colon.
 */
export function choiceKeySource(key: string): string {
  return key.slice(0, key.lastIndexOf(':'))
}

export function parseModelVisibility(raw: string | null): ModelVisibilityRecord | undefined {
  if (raw === null) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !isRecord(value['overrides']) || !isRecord(value['firstSeen'])) {
    return undefined
  }
  const overrides: [string, ModelVisibilityOverride][] = []
  for (const [key, override] of Object.entries(value['overrides'])) {
    if (!isRecord(override)) continue
    const visible = override['visible']
    const at = override['at']
    if (typeof visible === 'boolean' && isTime(at)) overrides.push([key, { visible, at }])
  }
  const firstSeen: [string, number][] = []
  for (const [key, at] of Object.entries(value['firstSeen'])) {
    if (isTime(at)) firstSeen.push([key, at])
  }
  const legacy = value['legacyHidden']
  const legacyHidden = Array.isArray(legacy)
    ? legacy.filter((key): key is string => typeof key === 'string')
    : []
  // Built as own data properties, whatever a stored key looks like.
  return withLegacyHidden(
    { overrides: Object.fromEntries(overrides), firstSeen: Object.fromEntries(firstSeen) },
    legacyHidden,
  )
}

export function serializeModelVisibility(record: ModelVisibilityRecord): string {
  return JSON.stringify(record)
}

/** From this format version on, an older build changed a saved hidden list only per row. */
const FIRST_INCREMENTAL_LEGACY_VERSION = 4

/**
 * Sources whose every row an older build returned to its defaults, by the
 * format version that did it: Claude Code's lineup at 7, Codex's generation
 * rule at 8. A row that never reached that version still held the defaults
 * of the build before it, not a choice.
 */
const LEGACY_SOURCE_RESETS: ReadonlyMap<string, number> = new Map([
  ['claude-code', 7],
  ['codex', 8],
])

/**
 * The entries of an older build's hidden list that can be choices. That
 * build saved its format version, and the version each row reached while
 * other sources were still unlisted. A list older than per-row changes holds
 * only defaults, and so does a row that missed its source's reset.
 */
export function legacyHiddenChoices(
  hidden: readonly string[],
  version: string | null,
  rows: Readonly<Record<string, string>>,
): string[] {
  const listVersion = Number(version)
  if (!Number.isInteger(listVersion) || listVersion < FIRST_INCREMENTAL_LEGACY_VERSION) return []
  return hidden.filter((key) => {
    const reset = LEGACY_SOURCE_RESETS.get(choiceKeySource(key))
    if (reset === undefined) return true
    const reached = Object.hasOwn(rows, key) ? Number(rows[key]) : listVersion
    return reached >= reset
  })
}

/**
 * Start the record from a profile saved as one complete hidden list, which
 * mixed the user's choices with the defaults of the build that saved it. The
 * sources `launchCatalog` lists return to the current defaults now, keeping
 * only what their defaults would not hide; custom models are always known.
 * Keys of every other source wait until that source is listed, so a missing
 * catalog cache cannot turn old defaults into choices.
 */
export function importLegacyModelVisibility(
  legacyHidden: Iterable<string>,
  launchCatalog: readonly ModelChoice[],
  now: number,
): ModelVisibilityRecord {
  const listedSources = new Set(launchCatalog.map((choice) => choiceKeySource(choice.key)))
  const known: string[] = []
  const pending: string[] = []
  for (const key of legacyHidden) {
    const isKnown = key.startsWith('custom:') || listedSources.has(choiceKeySource(key))
    ;(isKnown ? known : pending).push(key)
  }
  const defaults = modelVisibilityDefaults(launchCatalog)
  return withLegacyHidden(
    { overrides: importLegacyVisibility(known, launchCatalog, defaults, now), firstSeen: {} },
    pending,
  )
}

/**
 * Bring the record up to date with a fresh listing of one source: import
 * what an older profile hid there, forget first sightings of models it no
 * longer lists, and keep choices for only the most recent of those models.
 * Returns `record` itself when nothing changed.
 */
export function settleModelVisibilitySource(
  record: ModelVisibilityRecord,
  source: string,
  listed: readonly ModelChoice[],
  now: number,
): ModelVisibilityRecord {
  const listedKeys = new Set(listed.map((choice) => choice.key))
  let changed = false

  const overrides = { ...record.overrides }
  const legacyHidden: string[] = []
  const imported: string[] = []
  for (const key of record.legacyHidden ?? []) {
    ;(choiceKeySource(key) === source ? imported : legacyHidden).push(key)
  }
  if (imported.length > 0) {
    changed = true
    const restored = importLegacyVisibility(imported, listed, modelVisibilityDefaults(listed), now)
    for (const [key, override] of Object.entries(restored)) {
      // A choice made since the upgrade wins over the old list.
      if (!Object.hasOwn(overrides, key)) overrides[key] = override
    }
  }

  const unlisted = Object.entries(overrides).filter(
    ([key]) => !listedKeys.has(key) && choiceKeySource(key) === source,
  )
  if (unlisted.length > UNLISTED_OVERRIDES_PER_SOURCE) {
    changed = true
    unlisted.sort(([, left], [, right]) => right.at - left.at)
    for (const [key] of unlisted.slice(UNLISTED_OVERRIDES_PER_SOURCE)) delete overrides[key]
  }

  const firstSeen = { ...record.firstSeen }
  for (const key of Object.keys(firstSeen)) {
    if (listedKeys.has(key) || choiceKeySource(key) !== source) continue
    changed = true
    delete firstSeen[key]
  }

  return changed ? withLegacyHidden({ overrides, firstSeen }, legacyHidden) : record
}

/**
 * Note when each newer generation in `defaults` was first listed, so a
 * choice to show an older one, made before that, gives way to it once.
 * Returns `record` itself when every successor is already noted.
 */
export function recordModelSuccessors(
  record: ModelVisibilityRecord,
  defaults: ModelVisibilityDefaults,
  now: number,
): ModelVisibilityRecord {
  let firstSeen: Record<string, number> | undefined
  for (const successor of defaults.supersededBy.values()) {
    if (Object.hasOwn(firstSeen ?? record.firstSeen, successor)) continue
    firstSeen ??= { ...record.firstSeen }
    firstSeen[successor] = now
  }
  return firstSeen ? { ...record, firstSeen } : record
}

/**
 * Save the user's choice for every key in `keys` at once. Successors listed
 * right now are noted first, so showing an older generation the picker
 * lists next to its successor sticks.
 */
export function chooseModelsVisibility(
  record: ModelVisibilityRecord,
  keys: Iterable<string>,
  visible: boolean,
  defaults: ModelVisibilityDefaults,
  now: number,
): ModelVisibilityRecord {
  const chosen = new Set(keys)
  if (chosen.size === 0) return record
  const noted = recordModelSuccessors(record, defaults, now)
  const overrides = { ...noted.overrides }
  for (const key of chosen) overrides[key] = { visible, at: now }
  return withLegacyHidden(
    { overrides, firstSeen: noted.firstSeen },
    (noted.legacyHidden ?? []).filter((key) => !chosen.has(key)),
  )
}

/** The keys hidden right now: choices first, then defaults, then what an older profile hid. */
export function hiddenModelKeys(
  choices: readonly ModelChoice[],
  defaults: ModelVisibilityDefaults,
  record: ModelVisibilityRecord,
): Set<string> {
  const hidden = effectiveHiddenModels(choices, defaults, record.overrides, record.firstSeen)
  for (const key of record.legacyHidden ?? []) hidden.add(key)
  return hidden
}

function withLegacyHidden(
  record: Omit<ModelVisibilityRecord, 'legacyHidden'>,
  legacyHidden: readonly string[],
): ModelVisibilityRecord {
  return legacyHidden.length > 0 ? { ...record, legacyHidden } : record
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
