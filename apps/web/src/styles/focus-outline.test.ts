import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const focusRingCss = readFileSync(new URL('./focus-ring.css', import.meta.url), 'utf8')

describe('focus outline', () => {
  it('does not globally suppress keyboard focus indicators', () => {
    expect(tokensCss).not.toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*(?:none|0)(?:\s*!important)?\s*;/s,
    )
  })

  it('defines one focus ring token for both themes', () => {
    expect(tokensCss).toContain(
      '--focus-ring-color: color-mix(in srgb, var(--text) 60%, transparent);',
    )
    expect(tokensCss).toContain('--focus-ring: 2px solid var(--focus-ring-color);')
    expect(tokensCss).toContain('--focus-ring-offset: 2px;')
    expect(tokensCss).toContain('--focus-ring-inset: -2px;')
  })

  it('replaces the browser default ring everywhere through a weak layer', () => {
    expect(appCss).toContain("@import './focus-ring.css';")
    expect(focusRingCss).toMatch(
      /@layer focus-ring \{\s*:focus-visible \{\s*outline: var\(--focus-ring\);\s*outline-offset: var\(--focus-ring-offset\);/s,
    )
    expect(focusRingCss).toMatch(
      /\.navitem,[\s\S]*?\.sess,[\s\S]*?\.rail__foot \.menutrigger,[\s\S]*?\):focus-visible \{\s*outline-offset: var\(--focus-ring-inset\);/s,
    )
  })

  it('keeps the provider login terminal inside its neutral frame', () => {
    expect(settingsCss).toMatch(
      /\.install-terminal\s*\{[^}]*box-sizing: border-box;[^}]*overflow: hidden;/s,
    )
    expect(settingsCss).not.toMatch(/\.install-terminal:focus-within\s*\{/)
  })
})