import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../ui/Sidebar.tsx', import.meta.url), 'utf8')
const accountLimitsCss = readFileSync(new URL('./account-limits.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('sidebar theme CSS', () => {
  it('uses the quieter rail width for new and legacy profiles', () => {
    expect(appSource).toContain('const DEFAULT_RAIL_WIDTH = 256')
    expect(appSource).toContain('if (stored === 248 || stored === 276) return DEFAULT_RAIL_WIDTH')
  })

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

  it('uses the reference foreground for primary dark sidebar text', () => {
    expect(appCss).toMatch(/\.rail \{[^}]*--rail-text: #dcdcda;/s)
    expect(appCss).toMatch(/:root\[data-theme='light'\] \.rail \{[^}]*--rail-text: var\(--text\);/s)
    expect(appCss).toMatch(/\.navitem \{[^}]*color: var\(--rail-text\);/s)
    expect(appCss).toMatch(/\.proj__toggle \{[^}]*color: var\(--rail-text\);/s)
    expect(appCss).toMatch(/\.sess \{[^}]*color: var\(--rail-text\);/s)
  })

  it('uses compact regular-weight sidebar type', () => {
    expect(appCss).toMatch(
      /\.rail \{[^}]*--rail-font-size: 13px;[^}]*--rail-font-weight: 380;[^}]*--rail-letter-spacing: -0\.01em;/s,
    )
    expect(appCss).toMatch(
      /\.navitem \{[^}]*font-size: var\(--rail-font-size\);[^}]*font-weight: var\(--rail-font-weight\);[^}]*letter-spacing: var\(--rail-letter-spacing\);/s,
    )
  })

  it('separates smaller top actions with a clear rhythm', () => {
    expect(appCss).toMatch(/\.rail__actions \{[^}]*padding: 8px 10px 9px;[^}]*gap: 3px;/s)
    expect(appCss).toMatch(
      /\.rail__actions \.navitem \{[^}]*height: 26px;[^}]*min-height: 26px;[^}]*padding: 0 7px;/s,
    )
    expect(appCss).toMatch(/\.rail__search \{[^}]*width: 26px;[^}]*height: 26px;/s)
  })

  it('uses medium-weight chat titles and softens only their dark-theme color', () => {
    expect(appCss).toMatch(/\.sess__title \{[^}]*font-size: 12\.5px;[^}]*font-weight: 500;/s)
    expect(appCss).toMatch(
      /:root\[data-theme='dark'\] \.sess__title \{[^}]*color: color-mix\(in srgb, var\(--rail-text\) 78%, transparent\);/s,
    )
    expect(appCss).not.toMatch(/:root\[data-theme='dark'\] \.sess__title \{[^}]*font-weight:/s)
    expect(appCss).not.toMatch(/:root\[data-theme='(?:light|codex)'\] \.sess__title/)
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
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.sessrow:hover \.sess__source :is\(\.source-identity__label, \.source-identity__qualifier\) \{[^}]*opacity: 0;/s,
    )
    expect(appCss).toMatch(
      /\.sessrow:focus-within \.sess__source :is\(\.source-identity__label, \.source-identity__qualifier\) \{[^}]*opacity: 0;/s,
    )
  })

  it('aligns project and chat labels on one text grid without a nesting rail', () => {
    expect(appCss).not.toContain('.proj__chevron')
    expect(appCss).toMatch(/\.proj__toggle \{[^}]*gap: 8px;[^}]*padding: 2px 7px;/s)
    expect(appCss).toMatch(/\.proj__sessions-toggle \{[^}]*padding: 0 28px;/s)
    expect(appCss).toMatch(
      /\.proj__sessions \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*row-gap: 2px;[^}]*margin: 2px 0 9px;[^}]*padding: 0;/s,
    )
    expect(appCss).toMatch(/\.sess \{[^}]*padding: 0 12px 0 28px;/s)
    expect(appCss).toMatch(/\.sessrow\.is-pinned \.sess \{[^}]*padding-left: 7px;/s)
    expect(appCss).not.toMatch(/\.proj__sessions \{[^}]*border-left/s)
  })

  it('gives project actions room away from the scrollbar', () => {
    expect(appCss).toMatch(
      /\.proj__head > \.icon-btn \{[^}]*width: 22px;[^}]*height: 22px;[^}]*margin-right: 3px;/s,
    )
  })

  it('keeps the provider visible before the working chat spinner', () => {
    expect(appCss).not.toContain('.sess:has(.sess__spinner)')
    expect(appCss).toMatch(
      /\.sess__spinner \{[^}]*width: 14px;[^}]*flex: none;[^}]*color: var\(--running\);[^}]*animation: spin 800ms linear infinite;/s,
    )
  })

  it('keeps the account popup compact and pins its actions below scrolling limits', () => {
    expect(appCss).toMatch(/\.menu--settings \{[^}]*width: min\(224px, calc\(100vw - 16px\)\);/s)
    expect(appCss).toMatch(
      /\.menu--settings \{[^}]*max-height: min\(500px, calc\(100vh - 24px\)\);[^}]*display: flex;[^}]*flex-direction: column;[^}]*overflow: hidden;/s,
    )
    expect(appCss).toMatch(/\.menu--compact \{[^}]*gap: 0;[^}]*padding: 3px;/s)
    expect(accountLimitsCss).toMatch(
      /\.account-menu__usage-details \{[^}]*min-height: 0;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;[^}]*scrollbar-gutter: stable;/s,
    )
    expect(appCss).toMatch(
      /\.account-menu__actions \{[^}]*flex: none;[^}]*gap: 0;[^}]*padding-top: 0;/s,
    )
    expect(appCss).toMatch(/\.menu--settings \.menu__item \{[^}]*padding: 4px 6px;/s)
  })

  it('uses the same quiet type as the other account menu rows', () => {
    expect(accountLimitsCss).toMatch(
      /\.account-menu__usage-head \{[^}]*font-weight: 460;[^}]*letter-spacing: -0\.006em;/s,
    )
  })

  it('keeps the account trigger compact and shows its disclosure state on the right', () => {
    expect(appCss).toMatch(/\.rail__foot \{[^}]*padding: 4px 9px 10px;/s)
    expect(appCss).toMatch(/\.rail__foot \.menutrigger \{[^}]*width: 100%;/s)
    expect(appCss).toMatch(/\.account \{[^}]*gap: 8px;[^}]*width: 100%;/s)
    expect(appCss).toMatch(/\.account__avatar \{[^}]*width: 18px;[^}]*height: 18px;/s)
    expect(appCss).toMatch(
      /\.account__chevron \{[^}]*margin-left: auto;[^}]*transition: transform var\(--dur-fast\) var\(--ease-out\);/s,
    )
    expect(appCss).toMatch(
      /\.rail__foot \.menutrigger\[aria-expanded='true'\] \.account__chevron \{[^}]*transform: rotate\(180deg\);/s,
    )
    expect(sidebarSource).toContain('IconChevronUp as ChevronUp')
  })

  it('uses the light foreground color for unread chat dots', () => {
    expect(appCss).toMatch(
      /\.sess__unread-dot \{[^}]*width: 6px;[^}]*height: 6px;[^}]*background: var\(--light\);/s,
    )
  })

  it('gives project rows a consistent readable rhythm', () => {
    const sessRule = appCss.match(/^\.sess \{(?<body>[\s\S]*?)\n\}/m)?.groups?.['body'] ?? ''
    expect(appCss).toMatch(/\.rail__body \{[^}]*padding: 8px 4px 18px 10px;/s)
    expect(appCss).toMatch(/\.proj \{[^}]*margin-bottom: 7px;/s)
    expect(appCss).toMatch(
      /\.proj__drawer\[data-open='false'\] > \.proj__sessions \{[^}]*margin-block: 0;/s,
    )
    expect(appCss).toMatch(
      /\.proj__head \{[^}]*height: 26px;[^}]*min-height: 26px;[^}]*padding-right: 6px;/s,
    )
    expect(appCss).toMatch(
      /\.proj__toggle \{[^}]*font-size: var\(--rail-font-size\);[^}]*font-weight: var\(--rail-font-weight\);[^}]*height: 26px;[^}]*min-height: 26px;/s,
    )
    expect(appCss).toMatch(/^\s*\.sessrow \{[^}]*height: 25px;[^}]*border-radius: var\(--r-md\);/ms)
    expect(sessRule).toContain('height: 25px;')
    expect(sessRule).toContain('padding: 0 12px 0 28px;')
    expect(sessRule).toContain('font-size: var(--rail-font-size);')
    expect(sessRule).toContain('font-weight: var(--rail-font-weight);')
    expect(sessRule).toContain('border-radius: var(--r-md);')
    expect(sidebarSource).toContain('const VIRTUAL_SESSION_ROW_HEIGHT = 27')
    expect(appCss).toMatch(
      /\.proj\[data-drop-position\]::before \{[^}]*right: 6px;[^}]*left: 26px;[^}]*height: 2px;[^}]*background: var\(--light\);/s,
    )
    expect(appCss).toMatch(/\.proj\[data-drop-position='before'\]::before \{[^}]*top: -1px;/s)
    expect(appCss).toMatch(/\.proj\[data-drop-position='after'\]::before \{[^}]*bottom: -1px;/s)
  })

  it('uses the reference pill shape without changing the virtual row geometry', () => {
    expect(appCss).not.toMatch(
      /\.proj__sessions:not\(\.proj__sessions--virtual\) > \.sessrow\.is-active \{[^}]*height:/s,
    )
    expect(appCss).toMatch(
      /\.sessrow\.is-active \{[^}]*--sess-bg: color-mix\(in srgb, var\(--surface-2\) 75%, var\(--bg-rail-tint\)\);[^}]*box-shadow: none;/s,
    )
  })
})
