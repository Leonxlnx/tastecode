import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { DesignBrief } from './brief.js'
import { loadReviewedReferences, selectReviewedReferences } from './reference-library.js'
import {
  isStyleOutlier,
  loadReferenceStyleProfiles,
  MIN_SIMILAR_STYLE_SCORE,
  referenceSite,
  styleSimilarity,
} from './reference-style-profiles.js'

// Sampling chooses references; it never reads pixels. Loading still checks every file exists.
vi.mock('./raster-metadata.js', () => ({
  readRasterMetadata: () => ({ format: 'webp', width: 1, height: 1 }),
}))

const root = fileURLToPath(new URL('../references/library/', import.meta.url))
const brief = {
  originalRequest: 'Build a studio site',
  subject: 'Studio',
  brandInputs: [],
  requiredContent: [],
} as unknown as DesignBrief
const slots = [
  'hero',
  'about',
  'about',
  'feature',
  'feature',
  'feature',
  'how_it_works',
  'social_proof',
  'stats',
  'faq',
  'cta',
  'pricing',
  'contact',
  'footer',
]
const groupOf = ({ id, group }: { id: string; group?: string | undefined }) => group ?? id

/** mulberry32: a fixed seed keeps the draw sequence identical on every machine. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('bundled reference sampling', () => {
  it('keeps section families and spreads references over 2,000 seeded pages', () => {
    const references = loadReviewedReferences(root)
    const styles = loadReferenceStyleProfiles(root)
    const sections = references.filter(
      ({ family, tags }) => family !== 'dashboard' && !tags?.includes('native-component'),
    )
    const sparse = (family: string) =>
      new Set(sections.filter((reference) => reference.family === family).map(groupOf)).size < 10
    const random = seeded(20_261_012)
    const draws = 2_000
    const pages = new Map<string, number>()
    let borrowed = 0
    for (let draw = 0; draw < draws; draw++) {
      const deck = selectReviewedReferences(
        brief,
        references,
        (length) => Math.floor(random() * length),
        styles,
      )
      expect(deck).toHaveLength(slots.length)
      const anchor = deck[0]!
      const anchorProfile = styles.get(anchor.site ?? '')
      deck.forEach((reference, index) => {
        pages.set(reference.id, (pages.get(reference.id) ?? 0) + 1)
        const family = slots[index]!
        if (reference.family === family) return
        borrowed++
        // Only a sparse family borrows geometry, and only when its own family was out of reach:
        // nothing unused on the anchor site and nothing on a close enough site.
        expect(sparse(family), family).toBe(true)
        const used = new Set(deck.slice(0, index).map(groupOf))
        const inReach = sections.filter((candidate) => {
          const site = referenceSite(candidate.source)
          const profile = styles.get(site ?? '')
          return (
            candidate.family === family &&
            !used.has(groupOf(candidate)) &&
            !isStyleOutlier(profile, candidate) &&
            (site === anchor.site ||
              (!!anchorProfile &&
                !!profile &&
                styleSimilarity(anchorProfile, profile) >= MIN_SIMILAR_STYLE_SCORE))
          )
        })
        expect(
          inReach.map(({ id }) => id),
          `${family} slot of ${anchor.id}`,
        ).toEqual([])
      })
    }
    expect(borrowed).toBeGreaterThan(0)
    // No reference dominates. Without a minimum similarity, one broadly similar site's only stats
    // section reached 38% of these pages; uniform sampling peaks at 14% and this sampler at 21%.
    expect(Math.max(...pages.values()) / draws).toBeLessThan(0.25)
  }, 60_000)
})
