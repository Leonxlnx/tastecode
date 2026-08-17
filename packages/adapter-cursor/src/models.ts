import type { Model } from '@harness/contracts'
import { propertiesWhen } from './properties-when.js'

/**
 * Collapse cursor-agent's per-variant listing into base models.
 *
 * The CLI advertises every effort/fast permutation as its own id
 * (`gpt-5.3-codex-high-fast`), which put forty-odd rows in the picker where
 * the user thinks of a dozen models. Effort belongs on the effort slider and
 * Fast on the service-tier toggle, like every other provider.
 *
 * The suffix grammar is not uniform — `xhigh` vs `extra-high`, `-thinking`
 * before or after the effort — so translation back to a concrete id is a
 * lookup into the listing we actually parsed, never string assembly. See
 * fixtures/cursor-models-2026-08-07.txt for the captured wire output.
 */

export type RawCursorModel = { id: string; displayName: string; isDefault: boolean }

type Variant = RawCursorModel & { effort: string | undefined; fast: boolean; stem: string }

type BaseEntry = {
  stem: string
  defaultEffort: string | undefined
  /** `${effort}|${fast}` → concrete id from the listing. */
  variants: Map<string, string>
}

export type CursorModelIndex = Map<string, BaseEntry>

/**
 * The effort selected when a base also has a suffix-less variant. The wire has
 * no name for that level (`gpt-5.3-codex` is simply between `-low` and
 * `-high`), so the slider needs a token for it.
 */
const DEFAULT_EFFORT = 'default'

/** Trailing tokens the wire actually uses. Longest first so that a model id
 *  ending in `extra-high` is not misread as effort `high`. */
const EFFORT_SUFFIXES: Array<[suffix: string, normalized: string]> = [
  ['extra-high', 'xhigh'],
  ['minimal', 'minimal'],
  ['medium', 'medium'],
  ['xhigh', 'xhigh'],
  ['none', 'none'],
  ['high', 'high'],
  ['low', 'low'],
  ['max', 'max'],
]

/** Ladder order for the slider, weakest to strongest. */
const EFFORT_ORDER = ['none', 'minimal', 'low', DEFAULT_EFFORT, 'medium', 'high', 'xhigh', 'max']

/** Words that mark a display name as effort- or tier-specific. */
const DISPLAY_EFFORT_WORDS = /\b(?:None|Minimal|Low|Medium|High|Extra High|Max|Fast)\b/

const FAST_TIER = { id: 'fast', name: 'Fast', description: 'Priority routing' }
const STANDARD_TIER = { id: 'standard', name: 'Standard', description: 'Regular routing' }

function classify(raw: RawCursorModel): Variant {
  let rest = raw.id
  const fast = rest.endsWith('-fast')
  if (fast) rest = rest.slice(0, -'-fast'.length)

  // `-thinking` may follow the effort (`claude-4.6-sonnet-medium-thinking`);
  // hold it aside so the effort test sees the token, then restore it into the
  // stem, where it also lands when it precedes the effort.
  const thinkingSuffix = rest.endsWith('-thinking')
  if (thinkingSuffix) rest = rest.slice(0, -'-thinking'.length)

  let effort: string | undefined
  for (const [suffix, normalized] of EFFORT_SUFFIXES) {
    if (rest.endsWith(`-${suffix}`)) {
      effort = normalized
      rest = rest.slice(0, -(suffix.length + 1))
      break
    }
  }

  const stem = thinkingSuffix ? `${rest}-thinking` : rest
  return { ...raw, effort, fast, stem }
}

function variantKey(effort: string | undefined, fast: boolean): string {
  return `${effort ?? DEFAULT_EFFORT}|${fast}`
}

function effortRank(effort: string): number {
  const rank = EFFORT_ORDER.indexOf(effort)
  return rank < 0 ? EFFORT_ORDER.length : rank
}

/** The variant whose display name carries no effort word is how the vendor
 *  presents the base model, so it names the base and marks the default. */
function isUnmarked(variant: Variant): boolean {
  return !variant.fast && !DISPLAY_EFFORT_WORDS.test(variant.displayName)
}

export type CollapsedCursorModels = {
  models: Model[]
  index: CursorModelIndex
}

export function collapseCursorModels(raw: RawCursorModel[]): CollapsedCursorModels {
  type Group = { stem: string; variants: Variant[] }
  const groups: Group[] = []
  for (const model of raw) {
    const variant = classify(model)
    const group = groups.find((candidate) => candidate.stem === variant.stem)
    if (group) group.variants.push(variant)
    else groups.push({ stem: variant.stem, variants: [variant] })
  }

  const models: Model[] = []
  const index: CursorModelIndex = new Map()

  for (const group of groups) {
    const efforts = [...new Set(group.variants.map((v) => v.effort ?? DEFAULT_EFFORT))]
    const hasEffortChoice = efforts.length > 1
    const unmarked = group.variants.find(isUnmarked)
    const first = group.variants.find((v) => !v.fast) ?? group.variants[0]!
    const anchor = unmarked ?? first
    const hasFastTwin = group.variants.some((v) => v.fast)

    // A group that collapsed nothing keeps its wire display name verbatim —
    // stripping effort words is only justified once variants actually merged.
    const displayName =
      unmarked?.displayName ??
      (group.variants.length > 1
        ? first.displayName
            .replace(DISPLAY_EFFORT_WORDS, '')
            .replace(/\s{2,}/g, ' ')
            .trim() || first.displayName
        : first.displayName)

    const entry: BaseEntry = {
      stem: group.stem,
      defaultEffort: hasEffortChoice ? (anchor.effort ?? DEFAULT_EFFORT) : undefined,
      variants: new Map(group.variants.map((v) => [variantKey(v.effort, v.fast), v.id])),
    }
    index.set(anchor.id, entry)

    models.push({
      id: anchor.id,
      displayName,
      isDefault: group.variants.some((v) => v.isDefault),
      reasoningEfforts: hasEffortChoice
        ? [...efforts].sort((a, b) => effortRank(a) - effortRank(b))
        : [],
      ...propertiesWhen(hasEffortChoice && entry.defaultEffort, () => ({
        defaultReasoningEffort: entry.defaultEffort,
      })),
      serviceTiers: hasFastTwin ? [STANDARD_TIER, FAST_TIER] : [],
      ...propertiesWhen(hasFastTwin, () => ({ defaultServiceTier: STANDARD_TIER.id })),
    })
  }

  return { models, index }
}

/**
 * Concrete id for a selection. Combos the CLI does not offer degrade to the
 * nearest listed variant — first dropping Fast, then walking the effort
 * ladder — because a session that runs at standard routing is honest and a
 * refused turn is not. Unknown model ids pass through untouched so stale
 * selections fail with the CLI's own error rather than a guess of ours.
 */
export function resolveCursorModel(
  index: CursorModelIndex | undefined,
  modelId: string,
  effort?: string,
  serviceTier?: string,
): string {
  const entry = index?.get(modelId)
  if (!entry) return modelId

  const wantFast = serviceTier === FAST_TIER.id
  const wantEffort = effort ?? entry.defaultEffort ?? DEFAULT_EFFORT

  const exact = entry.variants.get(variantKey(wantEffort, wantFast))
  if (exact) return exact
  const withoutFast = entry.variants.get(variantKey(wantEffort, false))
  if (withoutFast) return withoutFast

  const available = [...entry.variants.keys()]
    .filter((key) => key.endsWith('|false'))
    .map((key) => key.slice(0, key.indexOf('|')))
    .sort((a, b) => effortRank(a) - effortRank(b))
  const target = effortRank(wantEffort)
  const nearest = available.reduce<string | undefined>((best, candidate) => {
    if (!best) return candidate
    return Math.abs(effortRank(candidate) - target) < Math.abs(effortRank(best) - target)
      ? candidate
      : best
  }, undefined)
  if (nearest) {
    return (
      entry.variants.get(variantKey(nearest, wantFast)) ??
      entry.variants.get(variantKey(nearest, false)) ??
      modelId
    )
  }
  return modelId
}

/**
 * The last parsed listing, shared across adapter instances: the picker's
 * listModels call runs in a different instance than the session that later
 * needs to resolve a variant id.
 */
let activeIndex: CursorModelIndex | undefined

export function rememberCursorIndex(index: CursorModelIndex): void {
  activeIndex = index
}

export function getCursorIndex(): CursorModelIndex | undefined {
  return activeIndex
}

export function resetCursorIndexForTests(): void {
  activeIndex = undefined
}
