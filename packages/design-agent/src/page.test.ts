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
  sections: [
    {
      id: 'hero',
      purpose: 'State the offer and lead into the primary purchase path.',
      copy: {
        eyebrow: 'Roasted weekly',
        heading: 'Coffee worth waking up for.',
        body: ['Seasonal beans, roasted in small batches and shipped fresh.'],
        callsToAction: [{ label: 'Shop the roast', target: '#shop' }],
      },
      layout: 'Split copy and product image with the product leading on wide screens.',
      componentNeeds: ['Primary button'],
      assetNeeds: ['hero-product'],
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
})
