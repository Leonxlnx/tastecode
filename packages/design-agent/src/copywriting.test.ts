import { describe, expect, it } from 'vitest'
import { assertPageCopy, lintPageCopy } from './copywriting.js'
import type { PageBlueprint } from './page.js'

const page: PageBlueprint = {
  version: 1,
  page: { title: 'Northstar', route: '/', description: 'Fresh coffee delivered weekly.' },
  architecture: {
    contract: 'Help home brewers choose a subscription.',
    mode: 'persuade_convert',
    novelty: 'medium',
    grid: 'Reading rail with product breakouts.',
    signatureRule: 'Product evidence breaks the right edge.',
    rhythm: 'Explanation alternates with proof.',
  },
  navigation: [],
  sections: [
    {
      id: 'offer',
      purpose: 'Explain the subscription.',
      userQuestion: 'What can I order?',
      stage: 'orient',
      dependencies: [],
      evidence: [],
      copy: {
        heading: 'Coffee roasted for your week.',
        body: ['Choose a roast and delivery interval.'],
        callsToAction: [{ label: 'Choose a roast', target: '#plans' }],
      },
      layout: 'Editorial split.',
      componentNeeds: [],
      assetNeeds: [],
      transformation: { compact: 'Stack.', medium: 'Split.', expanded: 'Split.' },
    },
  ],
  responsive: [],
  interactions: [],
  acceptanceCriteria: [],
}

describe('page copy lint', () => {
  it('accepts honest concept content without treating it as unfinished copy or customer proof', () => {
    for (const description of [
      'Concept portfolio. Self-initiated hospitality studies.',
      'Illustrative catalog. Original artist and release concepts.',
    ]) {
      expect(() => assertPageCopy({ ...page, page: { ...page.page, description } })).not.toThrow()
    }
  })
  it('warns about em dashes without aborting the page', () => {
    const draft = { ...page, page: { ...page.page, description: 'Fresh — every week.' } }
    expect(() => assertPageCopy(draft)).not.toThrow()
    expect(lintPageCopy(draft)).toContainEqual(
      expect.objectContaining({ rule: 'copy/em-dash', severity: 'warning' }),
    )
    expect(() =>
      assertPageCopy({ ...page, page: { ...page.page, description: 'Fresh Monday–Friday.' } }),
    ).not.toThrow()
  })

  it('requires evidence for objective claims', () => {
    const claimed = {
      ...page,
      sections: [
        {
          ...page.sections[0]!,
          copy: { ...page.sections[0]!.copy, heading: 'Save 42% on every delivery.' },
        },
      ],
    }
    expect(() => assertPageCopy(claimed)).toThrow('copy/objective-claim')
    expect(
      lintPageCopy({
        ...claimed,
        sections: [{ ...claimed.sections[0]!, evidence: ['Verified pricing comparison'] }],
      })[0]?.severity,
    ).toBe('review')
  })

  it.each([
    'Fictional example: “Either party may terminate this agreement on 30 days’ written notice.”',
    'Illustrative answer: In this fictional agreement, clause 8.2 specifies 30 days’ written notice for either party.',
    'Fictional example: “The supplier shall provide transition assistance for 45 days after notice of termination.”',
  ])('reviews numeric terms in explicitly fictional content: %s', (description) => {
    const example = { ...page, page: { ...page.page, description } }
    expect(() => assertPageCopy(example)).not.toThrow()
    expect(lintPageCopy(example)).toContainEqual(
      expect.objectContaining({ rule: 'copy/objective-claim', severity: 'review' }),
    )
  })

  it('does not let an illustrative label exempt product claims', () => {
    for (const description of [
      'Illustrative interface. Trusted by 100 companies.',
      'Fictional example. The most accurate contract assistant.',
      'Illustrative interface. Save 42% on every delivery.',
      'Representative dashboard. Reviews contracts 3x faster.',
    ]) {
      expect(() => assertPageCopy({ ...page, page: { ...page.page, description } })).toThrow(
        'copy/objective-claim',
      )
    }
  })

  it('warns on formula copy without calling it AI-generated', () => {
    const findings = lintPageCopy({
      ...page,
      page: { ...page.page, description: 'The future of seamless coffee, reimagined.' },
    })
    expect(findings).toContainEqual(expect.objectContaining({ rule: 'copy/generic-phrase' }))
  })

  it('warns about decorative eyebrows while still checking unsupported claims', () => {
    const section = page.sections[0]!
    expect(() =>
      assertPageCopy({
        ...page,
        sections: [{ ...section, copy: { ...section.copy, eyebrow: '01' } }],
      }),
    ).not.toThrow()
    expect(
      lintPageCopy({
        ...page,
        sections: [{ ...section, copy: { ...section.copy, eyebrow: '01' } }],
      }),
    ).toContainEqual(
      expect.objectContaining({ rule: 'copy/decorative-eyebrow', severity: 'warning' }),
    )
    expect(() =>
      assertPageCopy({
        ...page,
        sections: [
          {
            ...section,
            referenceDirectionId: 'reference-hero',
            copy: { ...section.copy, eyebrow: '01' },
          },
        ],
      }),
    ).not.toThrow()
    expect(() =>
      assertPageCopy({
        ...page,
        sections: [
          {
            ...section,
            referenceDirectionId: 'reference-hero',
            copy: { ...section.copy, eyebrow: 'Trusted by 100 companies' },
            evidence: [],
          },
        ],
      }),
    ).toThrow('copy/objective-claim')
  })

  it('blocks internal placeholders while keeping heading advice non-blocking', () => {
    const section = page.sections[0]!
    expect(() =>
      assertPageCopy({
        ...page,
        sections: [
          {
            ...section,
            layoutFamily: 'hero',
            copy: {
              ...section.copy,
              heading:
                'A deliberately overlong heading that cannot remain concise across normal responsive layouts',
              body: ['Primary support.', 'Sample data. To be supplied.'],
            },
          },
        ],
      }),
    ).toThrow('copy/internal-placeholder')
    const longHeading = {
      ...page,
      sections: [
        {
          ...section,
          layoutFamily: 'hero' as const,
          copy: {
            ...section.copy,
            heading:
              'A deliberately overlong heading that cannot remain concise across normal responsive layouts',
            body: ['Primary support.', 'Additional context.'],
          },
        },
      ],
    }
    expect(() => assertPageCopy(longHeading)).not.toThrow()
    expect(lintPageCopy(longHeading)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'copy/heading-length', severity: 'warning' }),
        expect.objectContaining({ rule: 'copy/hero-body-stack', severity: 'warning' }),
      ]),
    )
  })

  it('reviews saturated generated-name patterns without blocking user-owned names', () => {
    expect(lintPageCopy({ ...page, page: { ...page.page, title: 'Relay AI' } })).toContainEqual(
      expect.objectContaining({ rule: 'copy/saturated-product-name', severity: 'review' }),
    )
    expect(() =>
      assertPageCopy({ ...page, page: { ...page.page, title: 'Relay AI' } }),
    ).not.toThrow()
  })
})
