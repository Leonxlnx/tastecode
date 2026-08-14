import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePageBlueprint, writePageBlueprint } from './page.js'

const validBlueprint = {
  version: 1,
  page: {
    title: 'Northstar Coffee',
    route: '/',
    description: 'Small-batch coffee delivered without the ceremony.',
  },
  navigation: [{ label: 'Shop', target: '#shop' }],
  navigationDesign: {
    layout: 'Left logo with direct links and a right-side action.',
    behavior: ['Become opaque after the hero.'],
    transformation: {
      compact: 'Logo and menu trigger.',
      medium: 'Show priority links.',
      expanded: 'Show every destination.',
    },
  },
  architecture: {
    contract: 'This page helps home brewers choose and buy a fresh roast.',
    mode: 'persuade_convert',
    novelty: 'medium',
    grid: 'A stable reading rail with product breakouts.',
    signatureRule: 'Product evidence breaks the right page edge.',
    rhythm: 'Narrow explanation alternates with wide product proof.',
  },
  sections: [
    {
      id: 'hero',
      purpose: 'State the offer and lead into the primary purchase path.',
      userQuestion: 'What coffee can I buy here?',
      stage: 'orient',
      dependencies: [],
      evidence: ['Seasonal beans roasted weekly'],
      copy: {
        eyebrow: 'Roasted weekly',
        heading: 'Coffee worth waking up for.',
        body: ['Seasonal beans, roasted in small batches and shipped fresh.'],
        callsToAction: [{ label: 'Shop the roast', target: '#shop' }],
      },
      layout: 'Split copy and product image with the product leading on wide screens.',
      componentNeeds: ['Primary button'],
      assetNeeds: ['hero-product'],
      transformation: {
        compact: 'Copy first, then a portrait product crop.',
        medium: 'Keep copy and product adjacent in a compact split.',
        expanded: 'Use the full split with product context.',
      },
    },
  ],
  responsive: ['Stack hero content below 720px.'],
  interactions: ['Primary action scrolls to the product selection.'],
  acceptanceCriteria: ['The primary action is visible without scrolling on common laptops.'],
}

describe('page blueprint', () => {
  it('normalizes and writes a valid page artifact', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-page-'))
    const blueprint = writePageBlueprint(workspace, validBlueprint)

    expect(blueprint.sections[0]?.id).toBe('hero')
    expect(blueprint.navigationDesign?.transformation.compact).toContain('menu trigger')
    expect(JSON.parse(readFileSync(path.join(workspace, '.taste', 'page.json'), 'utf8'))).toEqual(
      blueprint,
    )
  })

  it('rejects duplicate section ids', () => {
    expect(() =>
      parsePageBlueprint({
        ...validBlueprint,
        sections: [validBlueprint.sections[0], validBlueprint.sections[0]],
      }),
    ).toThrow('section ids must be unique')
  })

  it('rejects routes that are not local paths', () => {
    expect(() =>
      parsePageBlueprint({
        ...validBlueprint,
        page: { ...validBlueprint.page, route: 'landing' },
      }),
    ).toThrow('page.route must start with /')
  })

  it('rejects section dependencies that do not exist', () => {
    expect(() =>
      parsePageBlueprint({
        ...validBlueprint,
        sections: [{ ...validBlueprint.sections[0], dependencies: ['missing-proof'] }],
      }),
    ).toThrow('depends on unknown section missing-proof')
  })

  it('keeps legacy page artifacts readable', () => {
    const {
      architecture: _architecture,
      navigationDesign: _navigationDesign,
      ...legacy
    } = validBlueprint
    const legacySection = { ...legacy.sections[0] }
    delete (legacySection as Partial<typeof legacySection>).userQuestion
    delete (legacySection as Partial<typeof legacySection>).stage
    delete (legacySection as Partial<typeof legacySection>).dependencies
    delete (legacySection as Partial<typeof legacySection>).evidence
    delete (legacySection as Partial<typeof legacySection>).transformation
    expect(parsePageBlueprint({ ...legacy, sections: [legacySection] }).architecture.novelty).toBe(
      'medium',
    )
  })
})
