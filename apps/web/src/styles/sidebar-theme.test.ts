import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('sidebar theme CSS', () => {
  it('uses the exact light rail color even when glass is on', () => {
    expect(tokensCss).toContain('--bg-rail-tint: #fcfcfc;')
    expect(tokensCss).toContain('--rail-glass-fade: 20%;')
    expect(appCss).toMatch(
      /:root\[data-glass='on'\] \.rail \{[^}]*var\(--bg-rail-tint\)[^}]*var\(--rail-glass-fade/s,
    )
    expect(appCss).not.toMatch(
      /:root\[data-glass='on'\] \.rail \{[^}]*color-mix\([^}]*var\(--bg-rail\)/s,
    )
    expect(appCss).toMatch(
      /:root\[data-theme='light'\]\[data-glass='on'\] \.rail \{[^}]*var\(--bg-rail-tint\)[^}]*var\(--rail-glass-fade/s,
    )
  })

  it('paints behind the rounded stage corner in light mode', () => {
    expect(appCss).toMatch(
      /:root\[data-theme='light'\]\[data-glass='on'\]\[data-shell='desktop'\] \.shell__body \{\s*background: var\(--bg-rail-tint\);\s*\}/s,
    )
  })
})
