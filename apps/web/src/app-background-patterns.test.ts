import { describe, expect, it } from 'vitest'
import {
  bayerMatrix,
  ditherRows,
  effectPattern,
  effectPatternStyle,
} from './app-background-patterns.js'

function svgOf(url: string): string {
  const match = /^url\("data:image\/svg\+xml,(.+)"\)$/.exec(url)
  expect(match).not.toBeNull()
  return decodeURIComponent(match?.[1] ?? '')
}

describe('effect patterns', () => {
  it('thresholds with the 8x8 Bayer matrix', () => {
    const matrix = bayerMatrix()
    expect(matrix).toHaveLength(8)
    expect(matrix.every((row) => row.length === 8)).toBe(true)
    expect(new Set(matrix.flat()).size).toBe(64)
    expect(Math.max(...matrix.flat())).toBe(63)
    expect(matrix[0]).toEqual([0, 32, 8, 40, 2, 34, 10, 42])
  })

  it('dithers from dense at the top edge to nothing at the bottom', () => {
    const rows = ditherRows()
    const lit = (from: number, to: number) =>
      rows.slice(from, to).reduce((sum, row) => sum + row.filter(Boolean).length, 0)
    const band = Math.floor(rows.length / 4)
    expect(lit(0, band)).toBeGreaterThan(lit(band, band * 2))
    expect(lit(band, band * 2)).toBeGreaterThan(lit(band * 2, band * 3))
    expect(lit(0, 8)).toBeGreaterThan(20)
    expect(lit(rows.length - 8, rows.length)).toBe(0)
  })

  it('builds small static SVG tiles that run across the window', () => {
    for (const effect of ['dither', 'halftone'] as const) {
      const pattern = effectPattern(effect)
      expect(pattern).toBeDefined()
      expect(pattern?.size).toBe('16px 448px')
      const svg = svgOf(pattern?.image ?? '')
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
      // Static and self-contained: nothing that animates, scripts or loads.
      expect(svg).not.toMatch(/<animate|<script|href|url\(/)
      expect(pattern?.image.length).toBeLessThan(16_000)
    }
  })

  it('shrinks the halftone dots down the tile', () => {
    const svg = svgOf(effectPattern('halftone')?.image ?? '')
    const radii = [...svg.matchAll(/r="([\d.]+)"/g)].map((match) => Number(match[1]))
    expect(radii.length).toBeGreaterThan(40)
    expect(radii[0]).toBeGreaterThan(3)
    expect(radii.at(-1)).toBeLessThan(0.6)
  })

  it('builds each tile once', () => {
    expect(effectPattern('dither')).toBe(effectPattern('dither'))
  })

  it('hands every effect its tile through CSS variables', () => {
    for (const effect of ['dither', 'halftone'] as const) {
      expect(effectPatternStyle(effect)).toEqual({
        '--app-bg-pattern': effectPattern(effect).image,
        '--app-bg-pattern-size': '16px 448px',
      })
    }
  })
})
