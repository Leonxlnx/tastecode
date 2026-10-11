import { describe, expect, it } from 'vitest'
import type { BrandSystem } from './brand.js'
import { designTokenVariables } from './design-tokens.js'
import { generatePalette, paletteColorRecords, paletteCssVariables } from './palette.js'

const typefaces = [{ family: 'Geist Mono', source: 'Project', roles: ['data'], weights: [400] }]

function brandWith(colorPalette: BrandSystem['colorPalette']): BrandSystem {
  // SAFETY: designTokenVariables reads only colorPalette, typefaces and designTokens.
  return { colorPalette, typefaces } as BrandSystem
}

describe('design token variables', () => {
  it('turns a generated palette back into the palette module custom properties', () => {
    const palette = generatePalette({
      themes: {
        light: { accentSeed: '#C1492E', neutralSeed: '#665A50', surfaceContrast: 'quiet' },
        dark: { accentSeed: '#E07A5F', neutralSeed: '#3D3530', surfaceContrast: 'defined' },
      },
    })
    if (palette.status !== 'ready') throw new Error('expected a ready palette')
    const variables = designTokenVariables(brandWith(paletteColorRecords(palette.value)))
    expect(variables.root).toEqual({
      ...paletteCssVariables(palette.value.themes.light!.roles),
      '--font-primary': '"Geist Mono", monospace',
    })
    expect(variables.dark).toEqual(paletteCssVariables(palette.value.themes.dark!.roles))
    expect(variables.root).toHaveProperty('--color-surface-alt')
    expect(variables.root).toHaveProperty('--color-on-accent')
  })

  it('puts a dark-only palette on the root', () => {
    const palette = generatePalette({
      themes: { dark: { accentSeed: '#E07A5F', surfaceContrast: 'quiet' } },
    })
    if (palette.status !== 'ready') throw new Error('expected a ready palette')
    const variables = designTokenVariables(brandWith(paletteColorRecords(palette.value)))
    expect(variables.dark).toBeUndefined()
    expect(variables.root['--color-canvas']).toBe(palette.value.themes.dark!.roles.canvas)
  })

  it('keeps legacy free-form colors addressable by name', () => {
    expect(
      designTokenVariables(
        brandWith([
          { name: 'Warm Paper', value: '#F2EDE4', usage: 'Canvas' },
          { name: 'Espresso', value: '#211B17', usage: 'Text' },
        ]),
      ).root,
    ).toMatchObject({ '--color-warm-paper': '#F2EDE4', '--color-espresso': '#211B17' })
  })
})
