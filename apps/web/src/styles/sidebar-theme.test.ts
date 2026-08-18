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

  it('keeps the collapsed flyout opaque and cheap to animate', () => {
    expect(appCss).toMatch(
      /:root\[data-glass='on'\] \.rail-slot\.is-collapsed \.rail \{[^}]*background: var\(--bg-rail\);[^}]*backdrop-filter: none;[^}]*-webkit-backdrop-filter: none;/s,
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

  it('hides provider text when chat row actions are visible', () => {
    expect(appCss).toMatch(
      /\.sessrow:hover \.sess__source :is\(\.source-identity__label, \.source-identity__qualifier\),\s*\.sessrow:focus-within \.sess__source :is\(\.source-identity__label, \.source-identity__qualifier\) \{[^}]*opacity: 0;/s,
    )
  })

  it('keeps project chats wide without a nesting rail', () => {
    expect(appCss).not.toContain('.proj__chevron')
    expect(appCss).toMatch(/\.proj__toggle \{[^}]*padding: 4px 8px;/s)
    expect(appCss).toMatch(/\.proj__sessions-toggle \{[^}]*padding: 0 8px;/s)
    expect(appCss).toMatch(/\.proj__sessions \{[^}]*margin: 1px 0 6px;[^}]*padding: 0;/s)
    expect(appCss).not.toMatch(/\.proj__sessions \{[^}]*border-left/s)
  })

  it('gives project actions room away from the scrollbar', () => {
    expect(appCss).toMatch(
      /\.proj__head > \.icon-btn \{[^}]*width: 26px;[^}]*height: 26px;[^}]*margin-right: 4px;/s,
    )
  })

  it('reserves a left slot for the working chat spinner', () => {
    expect(appCss).toMatch(/\.sess:has\(\.sess__spinner\) \{[^}]*padding-left: 28px;/s)
  })

  it('uses the light foreground color for unread chat dots', () => {
    expect(appCss).toMatch(
      /\.sess__unread-dot \{[^}]*width: 6px;[^}]*height: 6px;[^}]*background: var\(--light\);/s,
    )
  })

  it('gives project rows a consistent readable rhythm', () => {
    expect(appCss).toMatch(/\.proj \{[^}]*margin-bottom: 0;/s)
    expect(appCss).toMatch(
      /\.proj__drawer\[data-open='false'\] > \.proj__sessions \{[^}]*margin-block: 0;/s,
    )
    expect(appCss).toMatch(/\.proj__head \{[^}]*min-height: 36px;[^}]*padding-right: 6px;/s)
    expect(appCss).toMatch(/\.proj__toggle \{[^}]*min-height: 32px;/s)
    expect(appCss).toMatch(
      /\.proj\[data-drop-position\]::before \{[^}]*right: 6px;[^}]*left: 26px;[^}]*height: 2px;[^}]*background: var\(--light\);/s,
    )
    expect(appCss).toMatch(/\.proj\[data-drop-position='before'\]::before \{[^}]*top: -1px;/s)
    expect(appCss).toMatch(/\.proj\[data-drop-position='after'\]::before \{[^}]*bottom: -1px;/s)
  })
})
