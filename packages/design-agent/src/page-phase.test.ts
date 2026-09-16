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
    layoutCase: 'navigation-1',
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
      layoutFamily: 'hero',
      layoutCases: ['hero-text-5', 'hero-visual-2'],
      purpose: 'Introduce the offer.',
      userQuestion: 'What can I subscribe to?',
      stage: 'orient',
      dependencies: [],
      evidence: [],
      copy: { heading: 'Fresh by design.', body: [], callsToAction: [] },
      layout: 'Editorial split.',
      motion: {
        purpose: 'explanation',
        trigger: 'scroll_enter',
        behavior: 'Product proof resolves into the reading rail.',
        durationMs: 220,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
        reducedMotion: 'Show the final composition immediately.',
      },
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
    const prompt = designPagePrompt(brief, brand, ['/tmp/reference-home.png'])
    expect(prompt).toContain('replace such unsupported assumptions in the page plan')
    expect(prompt).toContain('normally plan at least eight substantive, relevant content sections')
    expect(prompt).toContain('Visibly identify concept work or an illustrative catalog')
    expect(prompt).toContain('<design-brief>')
    expect(prompt).toContain('<brand-system>')
    expect(prompt).toContain('<reference-direction-deck>')
    expect(prompt).toContain('<supplied-reference-catalog>')
    expect(prompt).toContain('user-reference-1')
    expect(prompt).toContain('Inspect the pixels rather than guessing')
    expect(prompt).toContain('"imagePath"')
    expect(prompt).toContain('REFERENCE LOCK')
    expect(prompt).toContain("Preserve the chosen reference's macro geometry")
    expect(prompt).toContain('Do not invent a second signature motif')
    expect(prompt).toContain('Do not choose new colors or typefaces')
    expect(prompt).toContain('order sections by information dependencies')
    expect(prompt).toContain('Compact reduces simultaneity, not content or capability')
    expect(prompt).toContain('Treat the selected reference images as composition requirements')
    expect(prompt).toContain('Do not add a section to use an available reference')
    expect(prompt).toContain('one related base card language and at most one emphasized variant')
    expect(prompt).toContain('record stable assetNeeds for every meaningful image')
    expect(prompt).toContain('Carry the approved brand accent into primary actions')
    expect(prompt).toContain('Give every section one explicit motion decision')
    expect(prompt).toContain('Derive heading placement, scale, image proportions')
    expect(prompt).toContain('Unify typography, spacing tokens, buttons and section transitions')
    expect(prompt).toContain('Never use an em dash')
    expect(prompt).toContain('Do not write eyebrow copy')
    expect(prompt).toContain(
      'Use the following beta layout cases as the source material for Hero, Navigation, About, Feature, How It Works, Social Proof, Stats, FAQ, CTA, Pricing, Contact, and Footer',
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
    expect(prompt).toContain('How It Works overlaps strongly with Feature layouts')
    expect(prompt).toContain('Draw one horizontal line with numbered steps')
    expect(prompt).toContain('left and right arrow buttons')
    expect(prompt).toContain('Place a vertical list of steps on the left')
    expect(prompt).toContain('Day 1 and Day 2')
    expect(prompt).toContain('Draw a winding or snake-like line through the center')
    expect(prompt).toContain('Treat this as a small supporting element rather than a full section')
    expect(prompt).toContain('company logos moving from right to left')
    expect(prompt).toContain('A static row of roughly five logos is equally valid')
    expect(prompt).toContain('multi-row grid or logo-wall composition')
    expect(prompt).toContain('in color or in a restrained gray treatment')
    expect(prompt).toContain('Place a strong, fitting quote at the top left')
    expect(prompt).toContain('only two very large numbers or a longer list')
    expect(prompt).toContain('Use a bento arrangement for the quote, numbers')
    expect(prompt).toContain('followed by a list of questions that open and close')
    expect(prompt).toContain('a small table of contents on the left')
    expect(prompt).toContain('a large "FAQ," "Questions," or another fitting heading on the left')
    expect(prompt).toContain('designed cards that expand, or as a simple accordion list')
    expect(prompt).toContain(
      'Lead with a compelling invitation rather than a generic section heading',
    )
    expect(prompt).toContain('email input and CTA button')
    expect(prompt).toContain('action word itself, such as "Sign up," directly inside the headline')
    expect(prompt).toContain('images in tiles or a bento arrangement on the right')
    expect(prompt).toContain('a compact toggle, two larger buttons')
    expect(prompt).toContain('Place benefits in the left column and plans across the top')
    expect(prompt).toContain('a larger neighboring card contains separate Pro and Max choices')
    expect(prompt).toContain('a fitting background image, or a restrained shader effect')
    expect(prompt).toContain('Use a contact form on the right or centered in the section')
    expect(prompt).toContain('only one or two short words')
    expect(prompt).toContain('Group destinations into columns with headings and sub-links')
    expect(prompt).toContain('intentionally cropped by the lower edge')
    expect(prompt).toContain('each grouped set of links inside its own card')
    expect(prompt).toContain('one short descriptive text block')
    const deck = /<reference-direction-deck>\s*([\s\S]*?)\s*<\/reference-direction-deck>/u.exec(
      prompt,
    )?.[1]
    expect(JSON.parse(deck ?? '[]')).toHaveLength(11)
  })

  it('persists and validates the selected visual reference', () => {
    const prompt = designPagePrompt(brief, brand)
    const deck = JSON.parse(
      /<reference-direction-deck>\s*([\s\S]*?)\s*<\/reference-direction-deck>/u.exec(prompt)?.[1] ??
        '[]',
    )
    expect(() => parsePagePhaseOutput(JSON.stringify(page), deck)).toThrow(
      'referenceDirectionId must identify an attached user reference or internal direction',
    )

    const internalLocked = parsePagePhaseOutput(
      JSON.stringify({
        ...page,
        sections: [{ ...page.sections[0], referenceDirectionId: deck[0].id }],
      }),
      deck,
    )
    expect(internalLocked.sections[0]?.referenceDirectionId).toBe(deck[0].id)

    const userLocked = parsePagePhaseOutput(
      JSON.stringify({
        ...page,
        sections: [{ ...page.sections[0], referenceDirectionId: 'user-reference-1' }],
      }),
      deck,
      ['user-reference-1'],
    )
    expect(userLocked.sections[0]?.referenceDirectionId).toBe('user-reference-1')

    expect(() => parsePagePhaseOutput(JSON.stringify(page), [], ['user-reference-1'])).toThrow(
      'referenceDirectionId must identify an attached user reference or internal direction',
    )
    expect(() =>
      parsePagePhaseOutput(
        JSON.stringify({
          ...page,
          sections: [{ ...page.sections[0], referenceDirectionId: deck[0].id }],
        }),
        deck,
        ['user-reference-1'],
      ),
    ).toThrow('page must select at least one attached user reference')
  })

  it('parses the final response through the page validator', () => {
    expect(parsePagePhaseOutput(JSON.stringify(page))).toEqual(page)
  })
  it('uses reviewed image IDs instead of imposing legacy layout recipes on new runs', () => {
    const deck = [
      {
        id: 'studio-hero',
        family: 'hero' as const,
        imagePath: '/library/desktop.png',
        mobileImagePath: '/library/mobile.png',
        cue: 'Large editorial composition',
      },
    ]
    const prompt = designPagePrompt(brief, brand, [], deck)
    expect(prompt).toContain('/library/mobile.png')
    expect(prompt).not.toContain('Use the following beta layout cases')
    const result = parsePagePhaseOutput(
      JSON.stringify({
        ...page,
        navigationDesign: { ...page.navigationDesign, layoutCase: 'reference-navigation' },
        sections: [
          {
            ...page.sections[0],
            referenceDirectionId: 'studio-hero',
            layoutCases: ['studio-hero'],
          },
        ],
      }),
      deck,
      [],
      true,
    )
    expect(result.sections[0]?.layoutCases).toEqual(['studio-hero'])
    expect(() =>
      parsePagePhaseOutput(
        JSON.stringify({
          ...result,
          sections: [{ ...result.sections[0], referenceDirectionId: 'unknown' }],
        }),
        deck,
        [],
        true,
      ),
    ).toThrow('must identify')
  })

  it('rejects page-phase output without a concrete layout selection', () => {
    const { layoutFamily: _layoutFamily, layoutCases: _layoutCases, ...section } = page.sections[0]!

    expect(() => parsePagePhaseOutput(JSON.stringify({ ...page, sections: [section] }))).toThrow(
      'must select a layoutFamily and layoutCases',
    )
  })

  it('rejects cases from a different layout family', () => {
    expect(() =>
      parsePagePhaseOutput(
        JSON.stringify({
          ...page,
          sections: [{ ...page.sections[0], layoutCases: ['feature-grid-3'] }],
        }),
      ),
    ).toThrow('not a hero case')
  })

  it('allows feature compositions for how-it-works sections', () => {
    expect(() =>
      parsePagePhaseOutput(
        JSON.stringify({
          ...page,
          sections: [
            {
              ...page.sections[0],
              layoutFamily: 'how_it_works',
              layoutCases: ['feature-heading-5', 'feature-grid-3'],
            },
          ],
        }),
      ),
    ).not.toThrow()
  })

  it('rejects the same composition in adjacent sections', () => {
    expect(() =>
      parsePagePhaseOutput(
        JSON.stringify({
          ...page,
          sections: [page.sections[0], { ...page.sections[0], id: 'hero-followup' }],
        }),
      ),
    ).toThrow('adjacent sections must not repeat the same layout composition')
  })
})
