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
  it('blocks em dashes but not en dashes', () => {
    expect(() =>
      assertPageCopy({ ...page, page: { ...page.page, description: 'Fresh — every week.' } }),
    ).toThrow('copy/em-dash at page.description')
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

  it('warns on formula copy without calling it AI-generated', () => {
    const findings = lintPageCopy({
      ...page,
      page: { ...page.page, description: 'The future of seamless coffee, reimagined.' },
    })
    expect(findings).toContainEqual(expect.objectContaining({ rule: 'copy/generic-phrase' }))
  })

  it('blocks every eyebrow, including process numbering', () => {
    const section = page.sections[0]!
    expect(() =>
      assertPageCopy({
        ...page,
        sections: [{ ...section, copy: { ...section.copy, eyebrow: '01' } }],
      }),
    ).toThrow('copy/decorative-eyebrow')
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

  it('blocks internal placeholders and overlong heading stacks', () => {
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
    ).toThrow(/copy\/(?:heading-length|hero-body-stack|internal-placeholder)/u)
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
