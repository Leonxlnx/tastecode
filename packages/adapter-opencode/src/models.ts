import type { Model } from '@harness/contracts'

/** One model a connected provider can run, as OpenCode lists it. */
export type OpenCodeCatalogEntry = {
  providerID: string
  providerName: string
  modelID: string
  name: string
  /** models.dev's family, such as `deepseek-flash` or `minimax`. */
  family?: string | undefined
  /** models.dev's status, such as `active`, `beta` or `alpha`. */
  status?: string | undefined
  /** models.dev's release day, an ISO date. */
  releaseDate?: string | undefined
  /** Whether the model calls tools, which an OpenCode agent turn needs. */
  toolCall?: boolean | undefined
  /** Whether the model answers in text; an image or video model does not. */
  textOutput?: boolean | undefined
  isDefault: boolean
  reasoningEfforts: string[]
  defaultReasoningEffort?: string | undefined
}

/**
 * Model creators by the word an id, a models.dev family or a provider id
 * starts with. A routing provider (OpenRouter, OpenCode's own tier) is not a
 * creator, so a model this table does not place keeps its provider's name.
 */
const LABS: ReadonlyMap<string, string> = new Map([
  ['deepseek', 'DeepSeek'],
  ['anthropic', 'Anthropic'],
  ['claude', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['gpt', 'OpenAI'],
  ['google', 'Google'],
  ['gemini', 'Google'],
  ['gemma', 'Google'],
  ['xai', 'xAI'],
  ['x-ai', 'xAI'],
  ['grok', 'xAI'],
  ['moonshot', 'Moonshot'],
  ['moonshotai', 'Moonshot'],
  ['kimi', 'Moonshot'],
  ['zai', 'Z.ai'],
  ['z-ai', 'Z.ai'],
  ['zhipu', 'Z.ai'],
  ['zhipuai', 'Z.ai'],
  ['glm', 'Z.ai'],
  ['minimax', 'MiniMax'],
  ['qwen', 'Qwen'],
  ['xiaomi', 'Xiaomi'],
  ['mimo', 'Xiaomi'],
  ['nvidia', 'NVIDIA'],
  ['nemotron', 'NVIDIA'],
  ['meta', 'Meta'],
  ['meta-llama', 'Meta'],
  ['llama', 'Meta'],
  ['mistral', 'Mistral'],
  ['mistralai', 'Mistral'],
  ['devstral', 'Mistral'],
  ['codestral', 'Mistral'],
])

const LETTER = /[a-z]/

/** The lab whose word `value` starts with, as a whole word: `qwen3.6` is Qwen, `metaphor` is not Meta. */
function labOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  const text = value.toLowerCase()
  let found: { word: string; lab: string } | undefined
  for (const [word, lab] of LABS) {
    if (!text.startsWith(word) || LETTER.test(text.charAt(word.length))) continue
    if (!found || word.length > found.word.length) found = { word, lab }
  }
  return found?.lab
}

const MAX_LAB_LENGTH = 80

function modelLab(entry: OpenCodeCatalogEntry): string | undefined {
  const slash = entry.modelID.indexOf('/')
  const lab =
    (slash > 0 ? labOf(entry.modelID.slice(0, slash)) : undefined) ??
    labOf(entry.family) ??
    labOf(entry.modelID) ??
    labOf(entry.providerID) ??
    entry.providerName.trim()
  return lab && lab.length <= MAX_LAB_LENGTH ? lab : undefined
}

const NAME_SEPARATOR = /[\s\-_/·:()]+/
/** A version, optionally behind letters as in `V4.1`, `M2.7`, `K2.6` or `Qwen3.6`. */
const VERSION = /^([a-z]*)(\d+(?:\.\d+)*)$/

type NameLineage = { skeleton: string; generation: string }

/**
 * A name's lineage: its first version is the generation and every other word
 * is the skeleton, so `MiniMax-M3` and `MiniMax-M2.7` share `minimax m#`
 * while `DeepSeek V4 Pro` and `DeepSeek V4.1 Flash` do not. An integer of
 * four or more digits is a date or a size, never a generation.
 */
function nameLineage(name: string): NameLineage | undefined {
  const words: string[] = []
  let generation: string | undefined
  for (const token of name.toLowerCase().split(NAME_SEPARATOR)) {
    if (!token) continue
    const version = generation === undefined ? VERSION.exec(token) : null
    const digits = version?.[2]
    if (version && digits && (digits.includes('.') || digits.length < 4)) {
      generation = digits
      words.push(`${version[1]}#`)
      continue
    }
    words.push(token)
  }
  const skeleton = words.join(' ')
  return generation && LETTER.test(skeleton) ? { skeleton, generation } : undefined
}

const MAX_FAMILY_LENGTH = 120
const MAX_GENERATION_LENGTH = 32
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** `value` when it is a real calendar day in ISO form. */
function isoDay(value: string | undefined): string | undefined {
  if (!value || !ISO_DAY.test(value)) return undefined
  const day = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value) ? value : undefined
}

function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** models.dev statuses of a release that is not yet the stable one. */
const PREVIEW_STATUSES: ReadonlySet<string> = new Set(['alpha', 'beta'])

/**
 * The family a model replaces older generations within. A beta or alpha
 * release forms its own, as a name that says "Preview" already does, so it
 * never takes over from the stable model it previews.
 */
function familyOf(entry: OpenCodeCatalogEntry, lineage: NameLineage): string {
  const stage = entry.status && PREVIEW_STATUSES.has(entry.status) ? ` ${entry.status}` : ''
  return `${entry.providerID}/${lineage.skeleton}${stage}`
}

/** Labs whose best model starts visible, in the order they get a slot. */
const LAB_PRIORITY = [
  'DeepSeek',
  'Anthropic',
  'OpenAI',
  'Google',
  'xAI',
  'Moonshot',
  'Z.ai',
  'MiniMax',
  'Qwen',
  'Xiaomi',
]
/** Labs that also start with their best model of the other tier: DeepSeek's Pro and Flash. */
const TWO_TIER_LABS: ReadonlySet<string> = new Set(['DeepSeek'])
const MAX_RECOMMENDED = 4
/** Name words of a release that is not yet the stable one. */
const PREVIEW_WORDS: ReadonlySet<string> = new Set([
  'preview',
  'alpha',
  'beta',
  'exp',
  'experimental',
])
/**
 * Name words of a lighter tier or a faster serving of a model. Such a model
 * starts visible only when its lab offers nothing else, so Claude Haiku waits
 * behind Sonnet and GPT Sol Fast behind Sol.
 */
const LIGHT_TIER_WORDS: ReadonlySet<string> = new Set([
  'haiku',
  'mini',
  'nano',
  'lite',
  'flash',
  'flashx',
  'air',
  'small',
  'tiny',
  'micro',
  'fast',
  'ultrafast',
  'highspeed',
  'ultraspeed',
  'lightning',
  'turbo',
])
/** The name word of an alias that follows a line, which yields to a versioned model. */
const ALIAS_WORD = 'latest'
/** The name word of OpenCode's free tier, which yields to a provider the user connected. */
const FREE_WORD = 'free'

function nameWords(text: string): string[] {
  return nameKey(text)
    .split(NAME_SEPARATOR)
    .filter((word) => word !== '')
}

function isPreview(entry: OpenCodeCatalogEntry): boolean {
  if (entry.status && PREVIEW_STATUSES.has(entry.status)) return true
  return nameWords(`${entry.name} ${entry.modelID}`).some((word) => PREVIEW_WORDS.has(word))
}

function compareGenerations(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

type DescribedModel = { entry: OpenCodeCatalogEntry; model: Model }

/**
 * Whether a model may start visible: a stable release that runs an agent
 * turn (tools, text out) and is the newest generation of its family.
 */
function canStartVisible(
  { entry, model }: DescribedModel,
  newest: ReadonlyMap<string, string>,
): boolean {
  if (isPreview(entry) || entry.toolCall === false || entry.textOutput === false) return false
  const newestGeneration = model.family ? newest.get(model.family) : undefined
  return !(
    model.generation &&
    newestGeneration &&
    compareGenerations(model.generation, newestGeneration) < 0
  )
}

type Candidate = { index: number; light: boolean; rank: number }

/**
 * A model's place within its lab, lowest first: a full tier before a lighter
 * one, a versioned model before an alias, and a provider the user connected
 * before OpenCode's free tier. Equal places keep the newest first.
 */
function candidate({ entry }: DescribedModel, index: number): Candidate {
  const words = nameWords(entry.name)
  const light = words.some((word) => LIGHT_TIER_WORDS.has(word))
  const rank =
    (light ? 4 : 0) + (words.includes(ALIAS_WORD) ? 2 : 0) + (words.includes(FREE_WORD) ? 1 : 0)
  return { index, light, rank }
}

/**
 * The models that start visible: the agent's default, then the best model of
 * each lab in priority order, at most four in all. DeepSeek also starts with
 * its best model of the other tier, as V4 Pro and V4.1 Flash. Labs outside
 * the priority list wait for the user to pick.
 */
function recommendedModels(rows: readonly DescribedModel[]): Set<number> {
  const newest = new Map<string, string>()
  for (const { model } of rows) {
    if (!model.family || !model.generation) continue
    const current = newest.get(model.family)
    if (current === undefined || compareGenerations(model.generation, current) > 0) {
      newest.set(model.family, model.generation)
    }
  }
  const picks = new Set<number>()
  rows.forEach(({ entry }, index) => {
    if (entry.isDefault && picks.size < MAX_RECOMMENDED) picks.add(index)
  })
  for (const lab of LAB_PRIORITY) {
    if (picks.size >= MAX_RECOMMENDED) break
    // Rows come newest first and the sort is stable.
    const candidates = rows
      .flatMap((row, index) =>
        row.model.lab === lab && canStartVisible(row, newest) ? [candidate(row, index)] : [],
      )
      .sort((left, right) => left.rank - right.rank)
    const best = candidates[0]
    if (!best) continue
    picks.add(best.index)
    if (!TWO_TIER_LABS.has(lab) || picks.size >= MAX_RECOMMENDED) continue
    const other = candidates.find((option) => option.light !== best.light)
    if (other) picks.add(other.index)
  }
  return picks
}

/**
 * The models of every connected provider, newest first. Each is named as
 * its provider names it; the provider's name follows only when another
 * connected provider offers a model of the same name. Each declares its lab,
 * its lineage within its provider and its release day, so a newer
 * generation replaces an older one without parsing a display name, and up
 * to four are recommended so a large account does not start with every
 * model switched on.
 */
export function openCodeModels(entries: readonly OpenCodeCatalogEntry[]): Model[] {
  // An ISO date sorts as text. The sort is stable, so models of the same day
  // keep OpenCode's provider order.
  const ordered = [...entries].sort((left, right) =>
    (right.releaseDate ?? '').localeCompare(left.releaseDate ?? ''),
  )
  const providersByName = new Map<string, Set<string>>()
  for (const entry of ordered) {
    const key = nameKey(entry.name)
    const providers = providersByName.get(key)
    if (providers) providers.add(entry.providerID)
    else providersByName.set(key, new Set([entry.providerID]))
  }
  const described = ordered.map((entry): DescribedModel => {
    const shared = (providersByName.get(nameKey(entry.name))?.size ?? 0) > 1
    const lab = modelLab(entry)
    const lineage = nameLineage(entry.name)
    const family = lineage ? familyOf(entry, lineage) : undefined
    const released = isoDay(entry.releaseDate)
    const model: Model = {
      id: `${entry.providerID}/${entry.modelID}`,
      displayName: shared ? `${entry.name} · ${entry.providerName}` : entry.name,
      isDefault: entry.isDefault,
      reasoningEfforts: entry.reasoningEfforts,
      ...(entry.defaultReasoningEffort
        ? { defaultReasoningEffort: entry.defaultReasoningEffort }
        : {}),
      serviceTiers: [],
      ...(lab ? { lab } : {}),
      ...(lineage &&
      family &&
      family.length <= MAX_FAMILY_LENGTH &&
      lineage.generation.length <= MAX_GENERATION_LENGTH
        ? { family, generation: lineage.generation }
        : {}),
      ...(released ? { released } : {}),
    }
    return { entry, model }
  })
  const recommended = recommendedModels(described)
  return described.map(({ model }, index) =>
    recommended.has(index) ? { ...model, recommended: true } : model,
  )
}
