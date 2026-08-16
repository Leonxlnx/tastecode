import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { BrandSystem } from './brand.js'
import type { DesignBrief } from './brief.js'
import { PAGE_LAYOUT_FAMILIES } from './page.js'
import { REFERENCE_DIRECTIONS, selectReferenceDirectionDeck } from './reference-directions.js'

const brief: DesignBrief = {
  originalRequest: 'Build a calm launch page for a material research studio.',
  subject: 'Material research studio',
  pageType: 'Landing page',
  scope: 'Single responsive page',
  primaryGoal: 'Turn qualified visitors into project enquiries',
  audience: 'Design leaders and product founders',
  offer: 'Research-led product and brand direction',
  primaryAction: 'Start a project',
  requiredContent: [],
  constraints: [],
  brandInputs: ['Warm mineral palette'],
  creativeControl: 'Choose the visual direction',
  explicitAnswers: [],
  assumptions: [],
  unresolved: [],
}

const brand: BrandSystem = {
  version: 1,
  foundation: {
    strategy: 'create',
    existingAssets: [],
    assetActions: [],
    lockedDecisions: [],
    assumptions: [],
  },
  creativeDirection: {
    summary: 'Quiet material confidence with precise editorial contrast.',
    traits: [{ quality: 'Tactile', boundary: 'Never rustic' }],
    productiveTension: 'Warm matter and exact structure',
    signatureDevice: {
      description: 'Cropped material studies interrupt the grid.',
      status: 'candidate',
      invariants: ['The crop must reveal real texture.'],
    },
    restraint: 'One dominant gesture per section.',
    avoid: ['Generic dashboard decoration'],
  },
  colorPalette: [
    { name: 'Mineral', value: '#d8d0c2', usage: 'Primary surface' },
    { name: 'Ink', value: '#171715', usage: 'Text and contrast' },
  ],
  typefaces: [
    { family: 'Inter', source: 'system', roles: ['display', 'body'], weights: [400, 600] },
  ],
  interfaceDirection: 'Editorial structure with tactile image-led proof.',
  imageDirection: {
    summary: 'Close material studies and composed working scenes.',
    subjects: ['Materials', 'People at work'],
    treatment: 'Natural light and preserved image ratio.',
    avoid: ['Decorative abstract renders'],
  },
  motionDirection: {
    summary: 'Measured spatial continuity.',
    principles: ['Motion explains hierarchy.'],
    avoid: ['Continuous ambient motion'],
  },
  voice: {
    summary: 'Direct, calm, and specific.',
    avoid: ['Empty superlatives'],
  },
}

describe('reference directions', () => {
  it('keeps the 132-file library valid and selects one deterministic cue per family', () => {
    expect(REFERENCE_DIRECTIONS).toHaveLength(132)
    expect(new Set(REFERENCE_DIRECTIONS.map(({ id }) => id)).size).toBe(132)
    expect(new Set(REFERENCE_DIRECTIONS.map(({ imagePath }) => imagePath)).size).toBe(132)
    expect(new Set(REFERENCE_DIRECTIONS.map(({ family }) => family))).toEqual(
      new Set(PAGE_LAYOUT_FAMILIES),
    )

    for (const entry of REFERENCE_DIRECTIONS) {
      expect(entry.id).toMatch(/^direction-\d{3}$/u)
      expect(entry.cue.trim().length).toBeGreaterThan(20)
      expect(entry.imagePath).toBe(`references/directions/${entry.family}/${entry.id}.webp`)
      expect(existsSync(fileURLToPath(new URL(`../${entry.imagePath}`, import.meta.url)))).toBe(
        true,
      )
    }

    const firstDeck = selectReferenceDirectionDeck(brief, brand)
    const secondDeck = selectReferenceDirectionDeck(brief, brand)

    expect(firstDeck).toEqual(secondDeck)
    expect(firstDeck).toHaveLength(PAGE_LAYOUT_FAMILIES.length)
    expect(firstDeck.map(({ family }) => family)).toEqual(PAGE_LAYOUT_FAMILIES)
    expect(new Set(firstDeck.map(({ family }) => family)).size).toBe(PAGE_LAYOUT_FAMILIES.length)
  })
})
