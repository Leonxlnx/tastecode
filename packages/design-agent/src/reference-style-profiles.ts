import { existsSync } from 'node:fs'
import path from 'node:path'
import { readWorkspaceFile } from './workspace-files.js'

/** Design language of one reference source site, from `style-profiles.json`. */
export interface ReferenceStyleProfile {
  // Each field is optional on its own: a partly malformed site still contributes what it has.
  theme?: string | undefined
  headingType?: string | undefined
  bodyType?: string | undefined
  typefaceGuess?: string | undefined
  radius?: string | undefined
  density?: string | undefined
  imagery?: string | undefined
  mood: readonly string[]
  /** Entry ids or groups of this site that do not share its design language. */
  outliers: ReadonlySet<string>
  summary?: string | undefined
}

/** Profiles keyed by {@link referenceSite}. Empty when the library ships none. */
export type ReferenceStyleProfiles = ReadonlyMap<string, ReferenceStyleProfile>

export const REFERENCE_STYLE_PROFILE_FILE = 'style-profiles.json'

/** Source host without `www.`: the key shared by catalog sources and style profiles. */
export function referenceSite(source: string | undefined): string | undefined {
  if (!source) return undefined
  try {
    return siteKey(new URL(source).host)
  } catch {
    return undefined
  }
}

function siteKey(host: string): string | undefined {
  return (
    host
      .trim()
      .toLowerCase()
      .replace(/^www\./u, '') || undefined
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => text(entry) ?? []) : []
}

/**
 * Profiles are optional next to `catalog.json`. A missing, oversized or malformed file means
 * "no profiles", so sampling degrades to same-site and uniform choices instead of failing a run.
 * A single malformed site is skipped without discarding the others.
 */
export function loadReferenceStyleProfiles(root: string): ReferenceStyleProfiles {
  const profiles = new Map<string, ReferenceStyleProfile>()
  try {
    const file = path.join(root, REFERENCE_STYLE_PROFILE_FILE)
    if (!existsSync(file)) return profiles
    const value: unknown = JSON.parse(readWorkspaceFile(file, 4_000_000).toString())
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.sites)) return profiles
    for (const [host, raw] of Object.entries(value.sites)) {
      const site = siteKey(host)
      if (!site || !isRecord(raw)) continue
      profiles.set(site, {
        theme: text(raw.theme),
        headingType: text(raw.headingType),
        bodyType: text(raw.bodyType),
        typefaceGuess: text(raw.typefaceGuess),
        radius: text(raw.radius),
        density: text(raw.density),
        imagery: text(raw.imagery),
        mood: texts(raw.mood).map((mood) => mood.toLowerCase()),
        outliers: new Set(texts(raw.outliers)),
        summary: text(raw.summary),
      })
    }
    return profiles
  } catch {
    return new Map()
  }
}

/** True when the site profile marks this entry as not sharing the site's design language. */
export function isStyleOutlier(
  profile: ReferenceStyleProfile | undefined,
  entry: { id: string; group?: string },
): boolean {
  return !!profile && (profile.outliers.has(entry.id) || profile.outliers.has(entry.group ?? ''))
}

const TYPE_GROUPS: readonly (readonly string[])[] = [
  ['serif', 'high-contrast-serif'],
  ['grotesk-sans', 'geometric-sans', 'humanist-sans', 'condensed-sans'],
]
const RADIUS_SCALE = ['sharp', 'small', 'medium', 'large', 'pill']

function typeScore(anchor: string | undefined, other: string | undefined, exact: number): number {
  if (!anchor || !other) return 0
  if (anchor === other) return exact
  return TYPE_GROUPS.some((group) => group.includes(anchor) && group.includes(other))
    ? exact - 1
    : 0
}

/**
 * The highest {@link styleSimilarity}: heading 3, body 2, theme 2, radius 2, density 1, imagery 1
 * and mood 3.
 */
export const MAX_STYLE_SIMILARITY = 14

/**
 * The lowest {@link styleSimilarity} that still counts as a similar site. Half the maximum (7) is
 * about the median pair among the 53 profiled sites, so it would call every second site similar
 * and let one broadly similar site supply a rare section to a third of all pages. 10 keeps about
 * the closest 8% of site pairs: matching heading and body type, theme and radius plus one more.
 */
export const MIN_SIMILAR_STYLE_SCORE = 10

/**
 * Deterministic design-language similarity. Type carries the most weight because mixed type
 * systems were the most visible drift; theme and radius follow, then density, imagery and mood.
 */
export function styleSimilarity(
  anchor: ReferenceStyleProfile,
  other: ReferenceStyleProfile,
): number {
  let score = typeScore(anchor.headingType, other.headingType, 3)
  score += typeScore(anchor.bodyType, other.bodyType, 2)
  if (anchor.theme && other.theme)
    score +=
      anchor.theme === other.theme ? 2 : anchor.theme === 'mixed' || other.theme === 'mixed' ? 1 : 0
  if (anchor.radius && other.radius) {
    const from = RADIUS_SCALE.indexOf(anchor.radius)
    const to = RADIUS_SCALE.indexOf(other.radius)
    // Unscaled values such as "mixed" only match exactly.
    score +=
      anchor.radius === other.radius ? 2 : from >= 0 && to >= 0 && Math.abs(from - to) === 1 ? 1 : 0
  }
  if (anchor.density && anchor.density === other.density) score += 1
  if (anchor.imagery && anchor.imagery === other.imagery) score += 1
  const shared = [...new Set(anchor.mood)].filter((mood) => other.mood.includes(mood))
  return score + Math.min(3, shared.length)
}

/** One line naming the anchor site's design language for prompts; never a full profile. */
export function styleProfileSummary(
  profile: ReferenceStyleProfile | undefined,
): string | undefined {
  if (!profile) return undefined
  const typefaces = profile.typefaceGuess?.replace(/[.\s]+$/u, '')
  const line = [profile.summary, typefaces ? `Typefaces: ${typefaces}.` : undefined]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return line ? line.slice(0, 700) : undefined
}
