import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const skeletonCss = readFileSync(new URL('./skeleton.css', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('compact permission chip while the mode loads', () => {
  it('draws the mode icon wherever the composer hides the permission label', () => {
    // Where app.css hides the label...
    expect(appCss).toMatch(
      /@container chat-stage \(max-width: 620px\) \{[\s\S]*?\.composer__permission \.tool > span:not\(\.icon-morph\)/,
    )
    expect(appCss).toMatch(
      /@media \(max-width: 520px\) \{[\s\S]*?\.tools \.composer__permission \.tool > span:not\(\.icon-morph\)/,
    )
    // ...skeleton.css swaps the chip-coloured icon skeleton for the dimmed glyph.
    expect(skeletonCss).toMatch(/\.composer-skeleton-permission__glyph \{\s*display: none;/)
    for (const query of ['@container chat-stage (max-width: 620px)', '@media (max-width: 520px)']) {
      const start = skeletonCss.indexOf(`${query} {\n  .tools .composer-skeleton-permission__icon`)
      expect(start).toBeGreaterThan(-1)
      const block = skeletonCss.slice(start, skeletonCss.indexOf('\n}\n', start))
      expect(block).toMatch(/\.composer-skeleton-permission__icon > \.skeleton \{\s*display: none;/)
      expect(block).toMatch(/\.composer-skeleton-permission__glyph \{\s*display: block;/)
    }
  })
})
