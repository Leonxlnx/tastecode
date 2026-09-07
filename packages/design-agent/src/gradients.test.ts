import { describe, expect, it } from 'vitest'
import { generateGradientSet, gradientSetForBrand } from './gradients.js'

describe('gradient recipes', () => {
  it('creates deterministic card, section, and page recipes from brand colors', () => {
    const input = {
      background: '#081018',
      surface: '#101C28',
      accent: '#38BDF8',
      secondary: '#A78BFA',
      seed: 42,
    }
    const result = generateGradientSet(input)
    expect(result).toEqual(generateGradientSet(input))
    expect(result.recipes.map(({ purpose }) => purpose)).toEqual(['card', 'section', 'page'])
    expect(result.recipes[0]?.background).toContain('rgba(56, 189, 248 / 0.42)')
    expect(result.recipes[0]?.contentSurface).toBe('#101C28')
  })

  it('derives recipes from semantic brand palette records', () => {
    const result = gradientSetForBrand({
      version: 1,
      foundation: {
        strategy: 'create',
        existingAssets: [],
        assetActions: [],
        lockedDecisions: [],
        assumptions: [],
      },
      creativeDirection: {
        summary: 'Quiet precision.',
        traits: [],
        productiveTension: 'Technical and warm.',
        signatureDevice: { description: 'Soft light field', status: 'candidate', invariants: [] },
        restraint: 'One field per view.',
        avoid: [],
      },
      colorPalette: [
        { name: 'Canvas', value: '#F7F5EF', usage: 'Page canvas' },
        { name: 'Surface', value: '#FFFFFF', usage: 'Card surface' },
        { name: 'Signal', value: '#E05235', usage: 'Primary accent' },
      ],
      typefaces: [],
      interfaceDirection: 'Calm.',
      imageDirection: { summary: 'Material.', subjects: [], treatment: 'Warm.', avoid: [] },
      motionDirection: { summary: 'Tactile.', principles: [], avoid: [] },
      voice: { summary: 'Direct.', avoid: [] },
    })
    expect(result?.recipes[0]?.background).toContain('rgba(224, 82, 53 / 0.42)')
  })

  it('rejects invalid colors at the tool boundary', () => {
    expect(() =>
      generateGradientSet({
        background: 'red',
        surface: '#FFF',
        accent: '#000',
        secondary: '#111',
        seed: 1,
      }),
    ).toThrow('gradient background must be an opaque sRGB hex color')
  })
})
