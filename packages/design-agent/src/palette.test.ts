import { describe, expect, it } from 'vitest'
import { auditPalette, generatePalette, paletteCssVariables } from './palette.js'

const request = {
  themes: {
    light: {
      accentSeed: '#C1492E',
      neutralSeed: '#665A50',
      surfaceContrast: 'quiet' as const,
    },
  },
}

describe('semantic palette generation', () => {
  it('is deterministic and emits only passing semantic pairs', () => {
    const first = generatePalette(request)
    const second = generatePalette(request)
    expect(first).toEqual(second)
    expect(first.status).toBe('ready')
    if (first.status !== 'ready') return
    const light = first.value.themes.light!
    expect(auditPalette(light.roles).pass).toBe(true)
    expect(light.roles.accent).toBe('#C1492E')
    expect(first.value.usageBalance.guidance).toContain('never a pixel quota')
  })

  it('preserves valid locked colors exactly', () => {
    const result = generatePalette({
      ...request,
      locked: { light: { canvas: '#FFF8F0', accent: '#B92F2F' } },
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value.themes.light?.roles.canvas).toBe('#FFF8F0')
    expect(result.value.themes.light?.roles.accent).toBe('#B92F2F')
  })

  it('blocks an inaccessible locked pair instead of changing it', () => {
    const result = generatePalette({
      ...request,
      locked: { light: { canvas: '#777777', text: '#777777' } },
    })
    expect(result).toEqual(
      expect.objectContaining({
        status: 'blocked',
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'locked-contrast-conflict' }),
        ]),
      }),
    )
  })

  it('keeps independent light and dark directions and stable CSS names', () => {
    const result = generatePalette({
      themes: {
        light: request.themes.light,
        dark: {
          accentSeed: '#66D8C2',
          neutralSeed: '#29343D',
          surfaceContrast: 'defined',
        },
      },
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value.themes.light?.roles.accent).toBe('#C1492E')
    expect(result.value.themes.dark?.roles.accent).toBe('#66D8C2')
    expect(paletteCssVariables(result.value.themes.dark!.roles)).toEqual(
      expect.objectContaining({
        '--color-surface-alt': expect.any(String),
        '--color-on-accent': expect.any(String),
      }),
    )
  })

  it('rejects malformed colors and unknown locks at the boundary', () => {
    expect(
      generatePalette({ themes: { light: { ...request.themes.light, accentSeed: 'red' } } }),
    ).toEqual(expect.objectContaining({ status: 'blocked' }))
    expect(generatePalette({ ...request, locked: { light: { glow: '#FFFFFF' } } })).toEqual(
      expect.objectContaining({
        status: 'blocked',
        issues: expect.arrayContaining([expect.objectContaining({ code: 'unknown-role' })]),
      }),
    )
  })
})
