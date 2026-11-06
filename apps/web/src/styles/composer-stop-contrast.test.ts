import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

describe('composer Stop button', () => {
  it('draws its glyph in its own colour, readable on the Stop circle in both themes', () => {
    expect(appCss).toMatch(
      /\.orb--stop \{\s*background: var\(--composer-stop\);\s*color: var\(--composer-on-stop\);/s,
    )
    const stops = [...tokensCss.matchAll(/--composer-stop: (#[0-9a-f]{6});/g)].map((m) => m[1]!)
    const glyphs = [...tokensCss.matchAll(/--composer-on-stop: (#[0-9a-f]{6});/g)].map((m) => m[1]!)
    expect(stops).toHaveLength(2)
    expect(glyphs).toHaveLength(2)
    // A non-text control needs 3:1 (WCAG 1.4.11); the dark theme's glyph was near 1.3:1.
    for (const [index, stop] of stops.entries())
      expect(contrast(stop, glyphs[index]!)).toBeGreaterThanOrEqual(3)
  })
})
