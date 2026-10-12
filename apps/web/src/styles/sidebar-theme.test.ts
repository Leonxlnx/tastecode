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
      /\.rail \{[^}]*--rail-font-size: 13px;[^}]*--rail-font-weight: 400;[^}]*--rail-letter-spacing: -0\.01em;/s,
    )
    expect(appCss).toMatch(
      /\.navitem \{[^}]*font-size: var\(--rail-font-size\);[^}]*font-weight: var\(--rail-font-weight\);[^}]*letter-spacing: var\(--rail-letter-spacing\);/s,
    )
  })

  it("gives the top actions the rail's 28px rhythm and column", () => {
    expect(appCss).toMatch(/\.rail__actions \{[^}]*padding: 8px 10px 6px 8px;[^}]*gap: 2px;/s)
    expect(appCss).toMatch(
      /\.rail__actions \.navitem \{[^}]*height: 28px;[^}]*min-height: 28px;[^}]*padding: 0 7px;/s,
    )
    expect(appCss).toMatch(/\.rail__search \{[^}]*width: 28px;[^}]*height: 28px;/s)
  })

  it('keeps chat titles lighter than their project until hovered, open or unread', () => {
    const titleRule =
      appCss.match(/^\.sess__title \{(?<body>[\s\S]*?)\n\}/m)?.groups?.['body'] ?? ''
    expect(titleRule).toContain('color: var(--text-2);')
    expect(titleRule).not.toContain('font-size')
    expect(titleRule).not.toContain('font-weight')
    expect(appCss).toMatch(
      /\.sessrow:is\(:hover, \.is-active\) \.sess__title \{[^}]*color: var\(--rail-text\);/s,
    )
    expect(appCss).toMatch(
      /\.sess__unread-dot \+ \.sess__title \{[^}]*color: var\(--rail-text\);[^}]*font-weight: 500;/s,
    )
    expect(appCss).not.toMatch(/:root\[data-theme='[a-z]+'\] \.sess__title/)
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

  it('reserves touch-row actions beside the title', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 700px\) \{[\s\S]*?\.sessrow \.sess \{[^}]*padding-right: 56px/s,
    )
  })

  it("shows a chat's provider as a 14px mark rather than its name", () => {
    expect(appCss).toMatch(
      /\.sess__source \{[^}]*width: 14px;[^}]*height: 14px;[^}]*color: var\(--text-3\);/s,
    )
    expect(appCss).not.toContain('source-identity__label')
  })

  it('aligns project and chat labels on one text grid without a nesting rail', () => {
    expect(appCss).not.toContain('.proj__chevron')
    expect(appCss).toMatch(/\.proj__toggle \{[^}]*gap: 8px;[^}]*padding: 0 8px;/s)
    expect(appCss).toMatch(/\.proj__sessions-toggle \{[^}]*padding: 0 30px;/s)
    expect(appCss).toMatch(
      /\.proj__sessions \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*row-gap: 2px;[^}]*margin: 2px 0 8px;[^}]*padding: 0;/s,
    )
    expect(appCss).toMatch(/\.sess \{[^}]*padding: 0 8px 0 30px;/s)
    // Pinned rows keep the same indent; the pin sits in the gutter instead.
    expect(appCss).not.toContain('.sessrow.is-pinned .sess')
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

  it('fits the account popup to the profile row and pins its actions below scrolling limits', () => {
    expect(accountLimitsCss).toMatch(
      /\.menu\.menu--settings \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*width: min\(var\(--menu-trigger-w, 224px\), calc\(100vw - 16px\)\);[^}]*max-height: min\(500px, calc\(100vh - 24px\)\);[^}]*padding: 4px;[^}]*border-radius: var\(--r-lg\);[^}]*overflow: hidden;/s,
    )
    expect(accountLimitsCss).toMatch(
      /\.menu\.menu--settings :is\(\.menu__item, \.account-menu__usage-head\) \{[^}]*min-height: 30px;[^}]*padding: 5px 8px;/s,
    )
    expect(accountLimitsCss).toMatch(
      /\.account-menu__usage-details \{[^}]*min-height: 0;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;[^}]*scrollbar-gutter: stable;/s,
    )
    expect(accountLimitsCss).toMatch(
      /\.account-menu__actions \{[^}]*display: grid;[^}]*flex: none;/s,
    )
    expect(appCss).not.toContain('.menu--settings')
  })

  it('uses the same quiet type as the other account menu rows', () => {
    expect(accountLimitsCss).toMatch(
      /\.account-menu__usage-head \{[^}]*font-weight: 460;[^}]*letter-spacing: -0\.006em;/s,
    )
  })

  it('lays the account trigger out as a soft 40px row with a fixed selector', () => {
    expect(appCss).toMatch(/\.rail__foot \{[^}]*padding: 4px 10px 8px 8px;/s)
    expect(appCss).toMatch(
      /\.rail__foot \.menutrigger \{[^}]*width: 100%;[^}]*border-radius: var\(--r-xl\);/s,
    )
    expect(appCss).toMatch(
      /\.account \{[^}]*grid-template-columns: 24px minmax\(0, 1fr\) auto;[^}]*min-height: 40px;[^}]*border-radius: var\(--r-xl\);/s,
    )
    expect(appCss).toMatch(/\.account__avatar \{[^}]*width: 24px;[^}]*height: 24px;/s)
    expect(appCss).toMatch(
      /\.rail__foot \.menutrigger:focus-visible \{[^}]*outline: 2px solid color-mix\(in srgb, var\(--text\) 40%, transparent\);/s,
    )
    expect(appCss).not.toMatch(/\.account__chevron \{[^}]*transform/s)
    expect(appCss).not.toContain('rotate(180deg)')
    expect(sidebarSource).toContain('IconSelector as Selector')
  })

  it('uses the light foreground color for unread chat dots', () => {
    expect(appCss).toMatch(
      /\.sess__unread-dot \{[^}]*width: 6px;[^}]*height: 6px;[^}]*background: var\(--light\);/s,
    )
  })

  it('gives project rows a consistent readable rhythm', () => {
    const sessRule = appCss.match(/^\.sess \{(?<body>[\s\S]*?)\n\}/m)?.groups?.['body'] ?? ''
    expect(appCss).toMatch(/\.rail__body \{[^}]*padding: 4px 0 16px 8px;/s)
    expect(appCss).toMatch(/\.proj \{[^}]*margin-bottom: 2px;/s)
    expect(appCss).toMatch(
      /\.proj__drawer\[data-open='false'\] > \.proj__sessions \{[^}]*margin-block: 0;/s,
    )
    expect(appCss).toMatch(
      /\.proj__head \{[^}]*height: 28px;[^}]*min-height: 28px;[^}]*padding-right: 6px;/s,
    )
    expect(appCss).toMatch(
      /\.proj__toggle \{[^}]*font-size: var\(--rail-font-size\);[^}]*font-weight: var\(--rail-font-weight\);[^}]*height: 28px;[^}]*min-height: 28px;/s,
    )
    expect(appCss).toMatch(/^\s*\.sessrow \{[^}]*height: 28px;[^}]*border-radius: var\(--r-md\);/ms)
    expect(sessRule).toContain('height: 28px;')
    expect(sessRule).toContain('padding: 0 8px 0 30px;')
    expect(sessRule).toContain('font-size: var(--rail-font-size);')
    expect(sessRule).toContain('font-weight: var(--rail-font-weight);')
    expect(sessRule).toContain('border-radius: var(--r-md);')
    expect(sidebarSource).toContain('const VIRTUAL_SESSION_ROW_HEIGHT = 30')
    expect(appCss).toMatch(
      /\.proj\[data-drop-position\]::before \{[^}]*right: 6px;[^}]*left: 30px;[^}]*height: 2px;[^}]*background: var\(--light\);/s,
    )
    expect(appCss).toMatch(/\.proj\[data-drop-position='before'\]::before \{[^}]*top: -1px;/s)
    expect(appCss).toMatch(/\.proj\[data-drop-position='after'\]::before \{[^}]*bottom: -1px;/s)
  })

  it("uses the settings nav's two soft surfaces without changing the virtual row geometry", () => {
    expect(appCss).not.toMatch(
      /\.proj__sessions:not\(\.proj__sessions--virtual\) > \.sessrow\.is-active \{[^}]*height:/s,
    )
    expect(appCss).toMatch(/\.sessrow:hover \{[^}]*--sess-bg: var\(--control-hover\);/s)
    expect(appCss).toMatch(/\.sessrow\.is-active \{[^}]*--sess-bg: var\(--menu-hover\);/s)
  })
})
