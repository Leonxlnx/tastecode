import type { Model } from '@harness/contracts'
import { propertiesWhen } from './properties-when.js'

/**
 * Collapse agy's per-effort slugs into base models.
 *
 * `agy models` advertises every effort permutation as its own id
 * (`gemini-3.6-flash-high`), which puts effort words in the picker where they
 * belong on the effort slider, like every other provider. Translation back to
 * a concrete slug is a lookup into the listing we actually parsed, never
 * string assembly. See fixtures/antigravity-models-2026-08-07.txt for the
 * captured wire output (agy 1.1.10).
 */

type Variant = { id: string; effort: string | undefined; stem: string }

type BaseEntry = {
  stem: string
  defaultEffort: string | undefined
  /** effort → concrete slug from the listing. */
  variants: Map<string, string>
}

export type AntigravityModelIndex = Map<string, BaseEntry>

/** Trailing tokens the wire uses today, plus the rest of the shared ladder so
 *  a future listing does not silently leave effort words in the picker. */
const EFFORT_SUFFIXES = ['minimal', 'xhigh', 'none', 'high', 'medium', 'low', 'max']

/** Ladder order for the slider, weakest to strongest. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** How the vendor spells its slugs, spelled for humans. */
const NAME_WORDS = [
  ['gemini', 'Gemini'],
  ['claude', 'Claude'],
  ['gpt', 'GPT'],
  ['oss', 'OSS'],
  ['flash', 'Flash'],
  ['pro', 'Pro'],
  ['sonnet', 'Sonnet'],
  ['opus', 'Opus'],
  ['haiku', 'Haiku'],
  ['thinking', 'Thinking'],
] as const

function classify(id: string): Variant {
  let rest = id
  // `-thinking` marks a distinct model, not an effort: hold it aside so the
  // suffix test sees the last token, then restore it into the stem.
  const thinkingSuffix = rest.endsWith('-thinking')
  if (thinkingSuffix) rest = rest.slice(0, -'-thinking'.length)

  let effort: string | undefined
  for (const suffix of EFFORT_SUFFIXES) {
    if (rest.endsWith(`-${suffix}`)) {
      effort = suffix
      rest = rest.slice(0, -(suffix.length + 1))
      break
    }
  }

  return { id, effort, stem: thinkingSuffix ? `${rest}-thinking` : rest }
}

function effortRank(effort: string): number {
  const rank = EFFORT_ORDER.indexOf(effort)
  return rank < 0 ? EFFORT_ORDER.length : rank
}

/** `claude-sonnet-4-6` → "Claude Sonnet 4.6"; `gpt-oss-120b` → "GPT-OSS 120B".
 *  Adjacent bare digits are one dotted version; everything else is a word. */
export function antigravityDisplayName(stem: string): string {
  const tokens = stem.split('-')
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const next = tokens[i + 1]
    if (/^\d+$/.test(token) && next && /^\d+$/.test(next)) {
      out.push(`${token}.${next}`)
      i++
      continue
    }
    if (/^\d+b$/i.test(token)) {
      out.push(token.toUpperCase())
      continue
    }
    if (/^\d+(\.\d+)?$/.test(token)) {
      out.push(token)
      continue
    }
    out.push(
      NAME_WORDS.find(([wireName]) => wireName === token)?.[1] ??
        token.charAt(0).toUpperCase() + token.slice(1),
    )
  }
  return out.join(' ').replace(/^GPT OSS\b/, 'GPT-OSS')
}

export type CollapsedAntigravityModels = {
  models: Model[]
  index: AntigravityModelIndex
}

export function collapseAntigravityModels(slugs: string[]): CollapsedAntigravityModels {
  type Group = { stem: string; variants: Variant[] }
  const groups: Group[] = []
  for (const slug of slugs) {
    const variant = classify(slug)
    const group = groups.find((candidate) => candidate.stem === variant.stem)
    if (group) group.variants.push(variant)
    else groups.push({ stem: variant.stem, variants: [variant] })
  }

  const models: Model[] = []
  const index: AntigravityModelIndex = new Map()
  const defaultSlug = slugs[0]

  for (const group of groups) {
    const efforts = group.variants.map((v) => v.effort).filter((e): e is string => Boolean(e))
    const hasEffortChoice = efforts.length > 1
    // The CLI lists its preferred variant first; that ordering is the only
    // default signal the wire carries.
    const anchor = group.variants[0]!
    const soleEffort = !hasEffortChoice && efforts.length === 1 ? efforts[0] : undefined

    const entry: BaseEntry = {
      stem: group.stem,
      defaultEffort: hasEffortChoice ? anchor.effort : undefined,
      variants: new Map(group.variants.map((v) => [v.effort ?? '', v.id])),
    }
    index.set(anchor.id, entry)

    models.push({
      id: anchor.id,
      displayName: antigravityDisplayName(group.stem),
      // A lone variant with a baked-in effort keeps the honest note; there is
      // no slider to carry the word instead.
      ...propertiesWhen(soleEffort, (includedValue) => ({
        description: `Fixed at ${includedValue} effort`,
      })),
      isDefault: group.variants.some((v) => v.id === defaultSlug),
      reasoningEfforts: hasEffortChoice
        ? [...new Set(efforts)].sort((a, b) => effortRank(a) - effortRank(b))
        : [],
      ...propertiesWhen(hasEffortChoice && entry.defaultEffort, () => ({
        defaultReasoningEffort: entry.defaultEffort,
      })),
      serviceTiers: [],
    })
  }

  return { models, index }
}

/**
 * Concrete slug for a selection. Efforts the listing does not offer degrade
 * to the nearest listed one — a session at a neighboring effort is honest, a
 * refused turn is not. Unknown ids pass through untouched so stale selections
 * fail with the CLI's own error rather than a guess of ours.
 */
export function resolveAntigravityModel(
  index: AntigravityModelIndex | undefined,
  modelId: string,
  effort?: string,
): string {
  const entry = index?.get(modelId)
  if (!entry) return modelId

  const wantEffort = effort ?? entry.defaultEffort
  const exact = entry.variants.get(wantEffort ?? '')
  if (exact) return exact

  const available = [...entry.variants.keys()].filter(Boolean)
  if (available.length === 0 || wantEffort === undefined) return modelId
  const target = effortRank(wantEffort)
  const nearest = available.reduce((best, candidate) =>
    Math.abs(effortRank(candidate) - target) < Math.abs(effortRank(best) - target)
      ? candidate
      : best,
  )
  return entry.variants.get(nearest) ?? modelId
}

/**
 * The last parsed listing, shared across adapter instances: the picker's
 * listModels call runs in a different instance than the session that later
 * needs to resolve a variant slug.
 */
let activeIndex: AntigravityModelIndex | undefined

export function rememberAntigravityIndex(index: AntigravityModelIndex): void {
  activeIndex = index
}

export function getAntigravityIndex(): AntigravityModelIndex | undefined {
  return activeIndex
}

export function resetAntigravityIndexForTests(): void {
  activeIndex = undefined
}
