import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('composer Design chip hover', () => {
  it('uses the shared chip hover instead of fading its label', () => {
    // The pastel gradient label read as a disabled control on light surfaces.
    expect(appCss).not.toContain('.composer__design:hover > span')
    expect(appCss).not.toContain('--composer-design-border-hover')
    expect(tokensCss).not.toContain('--composer-design-border-hover')
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.tools \.composer__design:hover:not\(:disabled\),\s*\.tools \.composer__design:hover:not\(:disabled\) svg \{\s*color: var\(--text\);\s*\}/s,
    )
  })

  it('keeps the active look while the active chip is hovered', () => {
    expect(appCss).toMatch(
      /\.tools \.composer__design\.is-active:hover:not\(:disabled\) \{[^}]*background: var\(--composer-design-active-bg\);[^}]*border-color: var\(--composer-design-border-active\);/s,
    )
  })
})
