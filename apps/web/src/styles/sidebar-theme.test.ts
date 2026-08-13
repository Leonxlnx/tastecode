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

  it('reserves touch-row actions without obscuring compact source identity', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 700px\) \{[\s\S]*?\.sessrow \.sess \{[^}]*padding-right: 56px/s,
    )
    expect(appCss).toMatch(
      /@media \(max-width: 700px\) \{[\s\S]*?\.sess__source \{[^}]*max-width: 68px/s,
    )
  })

  it('keeps project hierarchy calm and visibly nested', () => {
    expect(appCss).not.toContain('.proj__chevron')
    expect(appCss).toMatch(/\.proj__toggle \{[^}]*padding: 5px 12px;/s)
    expect(appCss).toMatch(/\.proj__sessions \{[^}]*margin: 1px 0 6px 20px;[^}]*border-left/s)
    expect(appCss).toMatch(/\.pinned-sessions \{[^}]*border-left: 0;/s)
  })

  it('gives project rows a consistent readable rhythm', () => {
    expect(appCss).toMatch(/\.proj \{[^}]*margin-bottom: 0;/s)
    expect(appCss).toMatch(
      /\.proj__drawer\[data-open='false'\] > \.proj__sessions \{[^}]*margin-block: 0;/s,
    )
    expect(appCss).toMatch(/\.proj__head \{[^}]*min-height: 36px;/s)
    expect(appCss).toMatch(/\.proj__toggle \{[^}]*min-height: 36px;/s)
  })
})
