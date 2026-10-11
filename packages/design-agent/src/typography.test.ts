import { describe, expect, it } from 'vitest'
import {
  DESIGN_FONT_POOLS,
  selectTypographyCandidates,
  typographyGuidance,
  validateTypographySelection,
} from './typography.js'
import type { BrandSystem } from './brand.js'
import type { DesignBrief } from './brief.js'

describe('typography draw', () => {
  it('gives all ten distinct families in every category an equal first slot, without replacement', () => {
    for (const [role, pool] of Object.entries(DESIGN_FONT_POOLS)) {
      expect(new Set(pool).size).toBe(10)
      const first = new Set<string>()
      for (let index = 0; index < 10; index++) {
        const draw = selectTypographyCandidates((length) => Math.min(index, length - 1))[
          role as keyof typeof DESIGN_FONT_POOLS
        ]
        first.add(draw[0]!)
        expect(new Set(draw)).toEqual(new Set(pool))
      }
      expect(first).toEqual(new Set(pool))
    }
  })
  it('matches the draw to the anchor reference only', () => {
    const guidance = typographyGuidance(
      selectTypographyCandidates(() => 0),
      {
        pageType: 'landing_page',
        originalRequest: 'Build a one-pager site for my analytics app',
      },
    )
    expect(guidance).toContain('hierarchy of the anchor reference (the deck entry whose role is')
    expect(guidance).toContain('in a deck without roles, the hero reference')
    expect(guidance).toContain('Ignore the typography of the other references')
    expect(guidance).toContain('choose the matching category (sans, serif, display or mono)')
    expect(guidance).toContain('only when the anchor itself sets text in monospace')
  })

  it('keeps dashboards to one sans family plus optional monospace data', () => {
    const guidance = typographyGuidance(
      selectTypographyCandidates(() => 0),
      {
        pageType: 'dashboard',
        originalRequest: 'Create an analytics dashboard',
      },
    )
    expect(guidance).toContain('use the FIRST drawn sans family for the whole interface')
    expect(guidance).toContain('optionally the FIRST drawn mono family for data')
    expect(guidance).toContain('Never use a display or serif draw for a dashboard')
    expect(guidance).not.toContain('choose the matching category')
  })

  it('keeps the draw while honoring explicit typography and existing brands', () => {
    const candidates = selectTypographyCandidates(() => 0)
    const brief = {
      originalRequest: 'Create a website',
      brandInputs: [],
      explicitAnswers: [],
    } as unknown as DesignBrief
    const brand = {
      foundation: { strategy: 'create', lockedDecisions: ['Use Arial'] },
      typefaces: [{ family: 'Arial' }],
    } as unknown as BrandSystem
    expect(() => validateTypographySelection(brief, brand, candidates)).toThrow('first-draw')
    expect(() =>
      validateTypographySelection({ ...brief, brandInputs: ['Use Arial'] }, brand, candidates),
    ).toThrow('first-draw')
    brand.typefaces[0]!.family = candidates.serif[0]!
    expect(() => validateTypographySelection(brief, brand, candidates)).not.toThrow()
    brand.typefaces[0]!.family = 'Arial'
    expect(() =>
      validateTypographySelection({ ...brief, originalRequest: 'Use Arial' }, brand, candidates),
    ).not.toThrow()
    brand.foundation.strategy = 'preserve'
    expect(() => validateTypographySelection(brief, brand, candidates)).not.toThrow()
  })
})
