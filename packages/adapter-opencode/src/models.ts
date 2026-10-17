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

/**
 * The models of every connected provider, newest first. Each is named as
 * its provider names it; the provider's name follows only when another
 * connected provider offers a model of the same name. Each declares its lab,
 * its lineage within its provider and its release day, so a newer
 * generation replaces an older one without parsing a display name.
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
  return ordered.map((entry) => {
    const shared = (providersByName.get(nameKey(entry.name))?.size ?? 0) > 1
    const lab = modelLab(entry)
    const lineage = nameLineage(entry.name)
    const family = lineage ? familyOf(entry, lineage) : undefined
    const released = isoDay(entry.releaseDate)
    return {
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
  })
}
