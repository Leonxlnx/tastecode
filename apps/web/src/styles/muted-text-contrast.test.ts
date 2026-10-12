import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const onboardingCss = readFileSync(new URL('./onboarding.css', import.meta.url), 'utf8')
const skeletonCss = readFileSync(new URL('./skeleton.css', import.meta.url), 'utf8')

function block(selector: string): string {
  const start = tokensCss.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return tokensCss.slice(start, tokensCss.indexOf('\n}', start))
}

function hex(body: string, name: string): string {
  const value = body.match(new RegExp(`\\n\\s*${name}: (#[0-9a-f]{6});`))?.[1]
  expect(value, name).toBeDefined()
  return value ?? ''
}

function channels(value: string): number[] {
  return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16))
}

function luminance(rgb: number[]): number {
  const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: number[], b: number[]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

describe('muted text contrast', () => {
  it('keeps dark muted text at 4.5:1 on every surface it sits on', () => {
    const dark = block(':root')
    const text3 = channels(hex(dark, '--text-3'))

    for (const surface of ['--bg', '--bg-rail', '--surface', '--surface-2']) {
      expect(contrast(text3, channels(hex(dark, surface))), surface).toBeGreaterThanOrEqual(4.5)
    }
    expect(hex(dark, '--text-3')).not.toBe(hex(dark, '--text-2'))
  })

  it('draws the dark select chevron and theme preview in the same muted grey', () => {
    const text3 = hex(block(':root'), '--text-3')
    expect(tokensCss).toContain(`stroke='%23${text3.slice(1)}'`)
    expect(onboardingCss).toMatch(
      new RegExp(`\\.preview\\[data-scheme='dark'\\] \\{[^}]*--text-3: ${text3};`, 's'),
    )
  })

  it('keeps light loading placeholders visible on a white page', () => {
    const light = block(":root[data-theme='light']")
    expect(light).toContain('--skeleton: color-mix(in srgb, var(--text) 9%, var(--surface-3));')

    const text = channels(hex(light, '--text'))
    const surface = channels(hex(light, '--surface-3'))
    const bar = surface.map((channel, index) => channel * 0.91 + (text[index] ?? 0) * 0.09)
    expect(contrast(bar, [255, 255, 255])).toBeGreaterThanOrEqual(1.3)
  })

  it('steps the composer model placeholder up from its control in both themes', () => {
    expect(skeletonCss).toMatch(
      /\.tools \.composer-skeleton-model \{[^}]*--skeleton: color-mix\(in srgb, var\(--text\) 9%, var\(--composer-action-bg\)\);/s,
    )
  })
})
