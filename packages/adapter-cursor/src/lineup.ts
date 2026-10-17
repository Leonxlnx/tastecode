import type { Model } from '@harness/contracts'

/**
 * Who made each Cursor model, which line and generation it belongs to, the
 * order the picker lists them in, and the few that start visible.
 *
 * cursor-agent lists every lab's models in its own order (Codex 5.3 first,
 * Claude Opus 5.5 somewhere in the middle) and fifty-odd of them after the
 * collapse. The id stems are steadier than the display names ("1M", "300K",
 * "(NO ZDR)", two spellings of a version), so the lineage is read from them.
 * See fixtures/cursor-models-2026-10-16.txt.
 */

type LabLineup = {
  lab: string
  /** First words of the id stems of this lab's models. */
  words: readonly string[]
  /** Line words, strongest first. A line with none of them ranks after these. */
  tiers: readonly string[]
  /** Line words of a lighter tier, which ranks last and starts visible only alone. */
  light: readonly string[]
  /**
   * The models that start visible: none, the lab's newest full-tier model, or
   * that one and the newest of the lab's top tier when they differ.
   */
  recommend: 'none' | 'newest' | 'newest-and-top'
}

/** Labs in picker order. Labs not named here follow, in Cursor's order. */
const LINEUP: readonly LabLineup[] = [
  {
    lab: 'Anthropic',
    words: ['claude'],
    tiers: ['fable', 'opus', 'sonnet'],
    light: ['haiku'],
    recommend: 'newest-and-top',
  },
  {
    lab: 'OpenAI',
    words: ['gpt'],
    tiers: ['sol', 'terra', 'luna'],
    light: ['mini', 'nano'],
    recommend: 'newest',
  },
  {
    lab: 'Google',
    words: ['gemini'],
    tiers: ['argon', 'pro'],
    light: ['flash', 'lite'],
    recommend: 'newest',
  },
  { lab: 'xAI', words: ['grok'], tiers: [], light: [], recommend: 'newest' },
  { lab: 'Cursor', words: ['composer'], tiers: [], light: [], recommend: 'newest' },
  { lab: 'Moonshot', words: ['kimi'], tiers: [], light: [], recommend: 'none' },
  { lab: 'Z.ai', words: ['glm'], tiers: [], light: [], recommend: 'none' },
  { lab: 'Meta', words: ['muse'], tiers: [], light: [], recommend: 'none' },
]

/** Cursor's prefix for its own serving of another lab's model (`cursor-grok-4.6`). */
const ROUTING_PREFIX = 'cursor'
const THINKING = 'thinking'
const VERSION_PART = /^\d+(?:\.\d+)*$/
/** A version behind letters, as in Kimi's `k3` and `k2.7`. */
const PREFIXED_VERSION = /^([a-z]+)(\d+(?:\.\d+)*)$/
const MAX_FAMILY_LENGTH = 120
const MAX_GENERATION_LENGTH = 32

export type CursorLineage = { family: string; generation: string }

function isVersionPart(token: string): boolean {
  return VERSION_PART.test(token) && (token.includes('.') || token.length < 4)
}

/**
 * The line an id stem belongs to and its generation there: the stem without
 * its version. Cursor writes a version as `4.6`, as `4-6` or behind letters as
 * `k2.7`, and before or after the line's name, so `claude-4.6-opus` and
 * `claude-opus-4-8` are both `claude-opus`. `-thinking` stays part of the
 * line. An integer of four or more digits is a date, never a generation.
 */
export function cursorLineage(stem: string): CursorLineage | undefined {
  const tokens = stem.toLowerCase().split('-').filter(Boolean)
  if (tokens[0] === ROUTING_PREFIX && tokens.length > 1) tokens.shift()
  const family: string[] = []
  let generation: string | undefined
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (generation === undefined && isVersionPart(token)) {
      const parts: string[] = []
      while (index < tokens.length && isVersionPart(tokens[index]!)) {
        parts.push(tokens[index]!)
        index += 1
      }
      generation = parts.join('.')
      continue
    }
    const prefixed =
      generation === undefined && family.length > 0 ? PREFIXED_VERSION.exec(token) : null
    if (prefixed) {
      family.push(prefixed[1]!)
      generation = prefixed[2]!
    } else {
      family.push(token)
    }
    index += 1
  }
  const name = family.join('-')
  if (!generation || !/[a-z]/.test(name)) return undefined
  if (name.length > MAX_FAMILY_LENGTH || generation.length > MAX_GENERATION_LENGTH) return undefined
  return { family: name, generation }
}

type Described = {
  model: Model
  index: number
  lineup: LabLineup | undefined
  lineage: CursorLineage | undefined
  tier: number
  light: boolean
  thinking: boolean
}

function labLineup(stem: string): LabLineup | undefined {
  const words = stem.toLowerCase().split('-')
  const first = words[0] === ROUTING_PREFIX && words.length > 1 ? words[1] : words[0]
  return LINEUP.find((entry) => entry.words.includes(first ?? ''))
}

function describe(model: Model, stem: string, index: number): Described {
  const lineup = labLineup(stem)
  const lineage = cursorLineage(stem)
  const words = (lineage?.family ?? stem).split('-')
  const light = Boolean(lineup?.light.some((word) => words.includes(word)))
  const tierIndex = lineup?.tiers.findIndex((word) => words.includes(word)) ?? -1
  const tiers = lineup?.tiers.length ?? 0
  return {
    model,
    index,
    lineup,
    lineage,
    tier: tierIndex >= 0 ? tierIndex : light ? tiers + 1 : tiers,
    light,
    thinking: words.includes(THINKING),
  }
}

function compareGenerations(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0
  if (left === undefined) return -1
  if (right === undefined) return 1
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Newest generation first, the stronger tier within one, a thinking twin after its line. */
function withinLab(left: Described, right: Described): number {
  return (
    compareGenerations(right.lineage?.generation, left.lineage?.generation) ||
    left.tier - right.tier ||
    Number(left.thinking) - Number(right.thinking) ||
    left.index - right.index
  )
}

function labRank(row: Described): number {
  return row.lineup ? LINEUP.indexOf(row.lineup) : LINEUP.length
}

/**
 * The rows that start visible. Per lab, the newest model of a full tier that
 * no newer generation of its line replaces, preferring the stronger tier
 * within one generation; for a lab that asks for it, also the newest of its
 * top tier. A thinking twin never starts visible ahead of its line, and a
 * lighter tier only when the lab lists nothing else.
 */
function recommendedRows(rows: readonly Described[]): Set<Described> {
  const newest = new Map<string, string>()
  for (const { lineage } of rows) {
    if (!lineage) continue
    const current = newest.get(lineage.family)
    if (compareGenerations(lineage.generation, current) > 0) {
      newest.set(lineage.family, lineage.generation)
    }
  }
  const picks = new Set<Described>()
  for (const lineup of LINEUP) {
    if (lineup.recommend === 'none') continue
    const current = rows
      .filter(
        (row) =>
          row.lineup === lineup &&
          !row.thinking &&
          (!row.lineage ||
            compareGenerations(row.lineage.generation, newest.get(row.lineage.family)) === 0),
      )
      .sort(withinLab)
    const full = current.filter((row) => !row.light)
    const candidates = full.length > 0 ? full : current
    const best = candidates[0]
    if (best) picks.add(best)
    if (lineup.recommend !== 'newest-and-top') continue
    const top = candidates.find((row) => row.tier === 0)
    if (top) picks.add(top)
  }
  return picks
}

/**
 * The collapsed models with their lab and lineage, in picker order: by lab,
 * newest generation first. Today the ones that start visible are Claude Opus
 * 5.5 1M, Claude Fable 5.1 1M, GPT-5.6 Sol 1M, Gemini 4 Argon, Grok 4.7 and
 * Composer 2.5.
 */
export function arrangeCursorModels(stemmed: readonly { model: Model; stem: string }[]): Model[] {
  const rows = stemmed.map(({ model, stem }, index) => describe(model, stem, index))
  const picks = recommendedRows(rows)
  return [...rows]
    .sort((left, right) => labRank(left) - labRank(right) || withinLab(left, right))
    .map((row) => ({
      ...row.model,
      ...(row.lineup ? { lab: row.lineup.lab } : {}),
      ...(row.lineage ? { family: row.lineage.family, generation: row.lineage.generation } : {}),
      ...(picks.has(row) ? { recommended: true } : {}),
    }))
}
