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
    expect(prompt).toContain('prefer image generation when available')
    expect(prompt).toContain('if unavailable or unsuccessful, use licensed online image search')
    expect(prompt).toContain(
      'rather than declaring nonexistent client or artist materials mandatory',
    )
    expect(prompt).toContain('only fulfilled image needs may reach Build')
    expect(prompt).toContain('use an available image tool with the selected reference composition')
    expect(prompt).not.toContain('frontend image-direction skill')
    expect(prompt).toContain('use status needed and omit source and destination entirely')
    expect(prompt).toContain('Generate one finished asset per file')
    expect(prompt).toContain('exact subject, art direction, camera or rendering language')
    expect(prompt).toContain('make at most one bounded regeneration')
    expect(prompt).toContain('download the actual image to the local destination')
    expect(prompt).toContain('Every image-led selected layout case must receive')
    expect(prompt).toContain('abstract diagram, fake dashboard, sonar graphic')
    expect(prompt).toContain('simple form, calendar, dashboard, chart, or interface')
    expect(prompt).toContain('even when renamed with another extension')
    expect(prompt).toContain('source.reference must be the stable user-reference-# ID')
    expect(prompt).toContain('pixel dimensions match aspectRatio')
    expect(prompt).toContain('rate limit')
    expect(prompt).toContain('Never invent a component ID')
    expect(prompt).toContain('A footer photo credit does not consume the photograph')
    expect(prompt).toContain('source.reference must contain only an HTTP(S) source-page URL')
    expect(prompt).toContain('do not invent a public URL for a local generation')
  })

  it('parses the final response through the asset validator', () => {
    const manifest = { version: 1, assets: [] }
    expect(parseAssetPhaseOutput(JSON.stringify(manifest))).toEqual(manifest)
  })
})
