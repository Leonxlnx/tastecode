import { describe, expect, it } from 'vitest'
import { designAssetPrompt, parseAssetPhaseOutput } from './asset-phase.js'

const input = {
  brief: {
    originalRequest: 'Build a coffee page.',
    subject: 'Coffee',
    pageType: 'Landing page',
    scope: 'One page',
    primaryGoal: 'Sell coffee',
    audience: 'Home brewers',
    offer: 'Fresh coffee',
    primaryAction: 'Buy',
    requiredContent: [],
    constraints: [],
    brandInputs: [],
    creativeControl: 'Agent decides',
    explicitAnswers: [],
    assumptions: [],
    unresolved: [],
  },
  brand: {
    version: 1 as const,
    creativeDirection: { summary: 'Warm.', keywords: [], avoid: [] },
    colorPalette: [{ name: 'Ink', value: '#171512', usage: 'Text' }],
    typefaces: [{ family: 'Geist', source: 'Project', roles: ['UI'], weights: [500] }],
    interfaceDirection: 'Editorial.',
    imageDirection: { summary: 'Product.', subjects: [], treatment: 'Warm.', avoid: [] },
    motionDirection: { summary: 'Tactile.', principles: [], avoid: [] },
    voice: { summary: 'Direct.', avoid: [] },
  },
  page: {
    version: 1 as const,
    page: { title: 'Coffee', route: '/', description: 'Fresh coffee.' },
    navigation: [],
    sections: [
      {
        id: 'hero',
        purpose: 'Lead.',
        copy: { heading: 'Fresh.', body: [], callsToAction: [] },
        layout: 'Split.',
        componentNeeds: ['Product card'],
        assetNeeds: ['hero-product'],
      },
    ],
    responsive: [],
    interactions: [],
    acceptanceCriteria: [],
  },
}

describe('asset phase', () => {
  it('makes OriginKit optional and rate-limit safe', () => {
    const prompt = designAssetPrompt(input.brief, input.brand, input.page)
    expect(prompt).toContain('OriginKit is optional')
    expect(prompt).toContain('This is an acquisition phase, not a wish list')
    expect(prompt).toContain('image generation for a precise original need')
    expect(prompt).toContain('frontend image-direction skill')
    expect(prompt).toContain('Generate one finished asset per file')
    expect(prompt).toContain('request the exact aspect ratio')
    expect(prompt).toContain('download the actual image to the local destination')
    expect(prompt).toContain('Every image-led selected layout case must receive')
    expect(prompt).toContain('abstract diagram, fake dashboard, sonar graphic')
    expect(prompt).toContain('simple form, calendar, dashboard, chart, or interface')
    expect(prompt).toContain('never expect Build to stretch, crop, or distort')
    expect(prompt).toContain('rate limit')
    expect(prompt).toContain('Never invent a component ID')
  })

  it('parses the final response through the asset validator', () => {
    const manifest = { version: 1, assets: [] }
    expect(parseAssetPhaseOutput(JSON.stringify(manifest))).toEqual(manifest)
  })
})
