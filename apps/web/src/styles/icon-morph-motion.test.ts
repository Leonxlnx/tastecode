import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./icon-morph.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../ui/IconMorph.tsx', import.meta.url), 'utf8')

describe('icon morph motion', () => {
  it('interpolates SVG geometry without rotating or scaling either glyph', () => {
    expect(css).toContain('opacity var(--dur-fast) var(--ease-in-out)')
    expect(css).toContain('.icon-morph__overlay')
    expect(css).toContain('.icon-morph[data-morphing]')
    expect(source).toContain('geometry.getPointAtLength')
    expect(source).toContain('interpolateMorphPoints')
    expect(source).toContain("getPropertyValue('--dur-slow')")
    expect(css).not.toContain('transition: all')
    expect(css).not.toMatch(/\b(?:width|height|margin|padding|top|left)\b[^;]*transition/)
    expect(css).not.toContain('transform:')
  })

  it('removes spatial motion but keeps opacity feedback for reduced motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?transition: opacity var\(--dur-press\) var\(--ease-out\) !important;[\s\S]*?\.icon-morph__overlay \{[\s\S]*?display: none;/s,
    )
  })
})
