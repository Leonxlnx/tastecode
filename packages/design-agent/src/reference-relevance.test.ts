import { describe, expect, it } from 'vitest'
import { referenceRelevance, relevanceScore, relevanceWords } from './reference-relevance.js'

describe('dashboard reference relevance', () => {
  it('keeps domain words and drops grammar, surfaces and generic interface parts', () => {
    expect([...relevanceWords('Build a full-screen Finance dashboard app with KPI cards')]).toEqual(
      ['finance'],
    )
    expect([...relevanceWords('Erstelle eine Fitness-App für unsere Kunden')]).toEqual([
      'fitness',
      'kunden',
    ])
    expect([...relevanceWords('AI tools for 3D sculpting')]).toEqual(['ai', '3d', 'sculpting'])
  })

  it('folds plurals on both sides and weighs names above descriptions', () => {
    const relevance = referenceRelevance(
      ['dashboard', 'generated', 'invoice-editor', 'Akaunting'],
      ['Invoice list with payments beside an editor.'],
    )
    expect(relevance).toEqual({
      names: ['invoice', 'editor', 'akaunting'],
      descriptions: ['payment', 'beside'],
    })
    expect(relevanceScore(relevanceWords('Invoices and payments'), relevance)).toBe(2 + 1)
    expect(relevanceScore(relevanceWords('Build an app'), relevance)).toBe(0)
  })
})
