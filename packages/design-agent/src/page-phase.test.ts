import { describe, expect, it } from 'vitest'
import { designPagePrompt, parsePagePhaseOutput } from './page-phase.js'

const brief = {
  originalRequest: 'Build a coffee page.',
  subject: 'Coffee subscription',
  pageType: 'Landing page',
  scope: 'One page',
  primaryGoal: 'Sell subscriptions',
  audience: 'Home brewers',
  offer: 'Fresh coffee',
  primaryAction: 'Subscribe',
  requiredContent: [],
  constraints: [],
  brandInputs: [],
  creativeControl: 'Agent decides',
  explicitAnswers: [],
  assumptions: [],
  unresolved: [],
}

const brand = {
  version: 1 as const,
  creativeDirection: { summary: 'Warm precision.', keywords: [], avoid: [] },
  colorPalette: [{ name: 'Ink', value: '#171512', usage: 'Text' }],
  typefaces: [{ family: 'Geist', source: 'Project', roles: ['UI'], weights: [500] }],
  interfaceDirection: 'Editorial commerce.',
  imageDirection: { summary: 'Product studies.', subjects: [], treatment: 'Warm.', avoid: [] },
  motionDirection: { summary: 'Tactile.', principles: [], avoid: [] },
  voice: { summary: 'Direct.', avoid: [] },
}

const page = {
  version: 1,
  page: { title: 'Northstar', route: '/', description: 'Fresh coffee delivered.' },
  navigation: [],
  sections: [
    {
      id: 'hero',
      purpose: 'Introduce the offer.',
      copy: { heading: 'Fresh by design.', body: [], callsToAction: [] },
      layout: 'Editorial split.',
      componentNeeds: [],
      assetNeeds: [],
    },
  ],
  responsive: [],
  interactions: [],
  acceptanceCriteria: [],
}

describe('page phase', () => {
  it('passes both upstream artifacts through clear data boundaries', () => {
    const prompt = designPagePrompt(brief, brand)
    expect(prompt).toContain('<design-brief>')
    expect(prompt).toContain('<brand-system>')
    expect(prompt).toContain('Do not choose new colors or typefaces')
  })

  it('parses the final response through the page validator', () => {
    expect(parsePagePhaseOutput(JSON.stringify(page))).toEqual(page)
  })
})
