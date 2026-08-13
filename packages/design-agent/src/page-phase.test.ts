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
  architecture: {
    contract: 'This page helps home brewers choose a fresh subscription.',
    mode: 'persuade_convert',
    novelty: 'medium',
    grid: 'A narrow copy rail with product breakouts.',
    signatureRule: 'Product evidence breaks the right page edge.',
    rhythm: 'Explanation alternates with proof.',
  },
  navigation: [],
  navigationDesign: {
    layout: 'Left logo, direct links, and the primary account action at the right.',
    behavior: ['Gain a solid surface after leaving the hero.'],
    transformation: {
      compact: 'Logo and one menu trigger.',
      medium: 'Logo, priority links, and account action.',
      expanded: 'Full direct navigation.',
    },
  },
  sections: [
    {
      id: 'hero',
      purpose: 'Introduce the offer.',
      userQuestion: 'What can I subscribe to?',
      stage: 'orient',
      dependencies: [],
      evidence: [],
      copy: { heading: 'Fresh by design.', body: [], callsToAction: [] },
      layout: 'Editorial split.',
      componentNeeds: [],
      assetNeeds: [],
      transformation: {
        compact: 'Copy before product media.',
        medium: 'Compact split.',
        expanded: 'Editorial split.',
      },
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
    expect(prompt).toContain('order sections by information dependencies')
    expect(prompt).toContain('Compact reduces simultaneity, not content or capability')
    expect(prompt).toContain('Never use an em dash')
    expect(prompt).toContain('Omit eyebrow copy by default')
    expect(prompt).toContain(
      'Use the following beta layout cases as the source material for Hero, Navigation, About, and Feature',
    )
    expect(prompt).toContain('Place the headline at the bottom left or bottom right')
    expect(prompt).toContain('show a wide dashboard, product preview, interface')
    expect(prompt).toContain('Place a list of destinations with icons and subheadings on the left')
    expect(prompt).toContain('As the user scrolls, smoothly introduce the navigation background')
    expect(prompt).toContain('An About section may describe the company, the people who work there')
    expect(prompt).toContain('Arrange portraits of the people in an orderly grid')
    expect(prompt).toContain('Build an open asymmetric image-and-text grid beneath it')
    expect(prompt).toContain('move from left to right through a smooth GSAP scroll treatment')
    expect(prompt).toContain('Create a more experimental checkerboard composition')
    expect(prompt).toContain('The text may reveal or fade in as the user scrolls')
    expect(prompt).toContain('Treat Features as one of the most open section types')
    expect(prompt).toContain('Place the heading on the left and the description on the right')
    expect(prompt).toContain('Use one horizontal row of three cards')
    expect(prompt).toContain('creating a stair-step composition')
    expect(prompt).toContain('four cards above and three below')
    expect(prompt).toContain('Present roughly two to five features with a timed progress line')
    expect(prompt).toContain('through GSAP, horizontal scroll, or direct dragging')
    expect(prompt).toContain('move in a controlled swirl')
  })

  it('parses the final response through the page validator', () => {
    expect(parsePagePhaseOutput(JSON.stringify(page))).toEqual(page)
  })
})
