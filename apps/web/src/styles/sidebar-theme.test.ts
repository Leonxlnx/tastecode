import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../ui/Sidebar.tsx', import.meta.url), 'utf8')
const menuSource = readFileSync(new URL('../ui/Menu.tsx', import.meta.url), 'utf8')
const accountLimitsCss = readFileSync(new URL('./account-limits.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const accountCardCss = readFileSync(new URL('./account-card.css', import.meta.url), 'utf8')

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

  it('separates smaller top actions with a clear rhythm', () => {
    expect(appCss).toMatch(/\.rail__actions \{[^}]*padding: 8px 10px 9px;[^}]*gap: 3px;/s)
    expect(appCss).toMatch(
      /\.rail__actions \.navitem \{[^}]*height: 26px;[^}]*min-height: 26px;[^}]*padding: 0 7px;/s,
    )
    expect(appCss).toMatch(/\.rail__search \{[^}]*width: 26px;[^}]*height: 26px;/s)
  })

  it('sets chat titles in the rail type, lighter than their project, and softens only dark', () => {
    const titleRule =
      appCss.match(/^\.sess__title \{(?<body>[\s\S]*?)\n\}/m)?.groups?.['body'] ?? ''
    expect(titleRule).not.toContain('font-size')
    expect(titleRule).not.toContain('font-weight')
    expect(appCss).toMatch(/\.proj__name \{[^}]*font-weight: 500;/s)
    expect(appCss).toMatch(/\.sessrow\.is-unread \.sess__title \{[^}]*font-weight: 560;/s)
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

  it('reserves touch-row actions so the time stays beside them', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 700px\) \{[\s\S]*?\.sessrow \.sess \{[^}]*padding-right: 56px/s,
    )
    expect(appCss).not.toContain('.sess__source')
  })

  it('hides the time and status when chat row actions are visible', () => {
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.sessrow:hover \.sess__meta \{[^}]*opacity: 0;/s,
    )
    expect(appCss).toMatch(/\.sessrow:focus-within \.sess__meta \{[^}]*opacity: 0;/s)
    expect(appCss).toMatch(
      /\.sess__time \{[^}]*font-size: var\(--t-xs\);[^}]*font-variant-numeric: tabular-nums;/s,
    )
  })

  it('hangs project chats off a soft guide under the folder mark', () => {
    expect(appCss).not.toContain('.proj__chevron')
    expect(appCss).toMatch(/\.proj__toggle \{[^}]*gap: 8px;[^}]*padding: 2px 7px;/s)
    expect(appCss).toMatch(
      /\.proj__sessions \{[^}]*--sess-indent: 7px;[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*row-gap: 2px;[^}]*margin: 2px 0 8px;[^}]*padding: 0;/s,
    )
    // Pinned chats keep the outer gutter (7px); a project's chats indent past
    // the guide, which sits on the folder mark's centre (7px + 13px / 2).
    expect(appCss).toMatch(/\.proj__drawer > \.proj__sessions \{[^}]*--sess-indent: 22px;/s)
    expect(appCss).toMatch(
      /\.proj::after \{[^}]*position: absolute;[^}]*left: 13px;[^}]*width: 1px;[^}]*background: var\(--rail-guide\);[^}]*pointer-events: none;/s,
    )
    // Pinned chats share the project-chat indent; no override may pull them left.
    expect(appCss).not.toMatch(/\.sessrow\.is-pinned[^{]*\{[^}]*padding-left/s)
    expect(appCss).not.toMatch(/\.proj__sessions \{[^}]*border-left/s)
    // Every text that sits in a chat row starts where the title does:
    // indent + 13px mark + 8px gap.
    expect(appCss).toMatch(/\.sess \{[^}]*gap: 8px;[^}]*padding: 0 8px 0 var\(--sess-indent\);/s)
    expect(appCss).toMatch(/\.sess__provider \{[^}]*width: 13px;[^}]*height: 13px;/s)
    expect(appCss).toMatch(
      /\.proj__sessions-toggle \{[^}]*padding: 0 8px 0 calc\(var\(--sess-indent\) \+ 21px\);/s,
    )
    expect(appCss).toMatch(
      /\.proj__sessions > \.rail__hint \{[^}]*padding-left: calc\(var\(--sess-indent\) \+ 21px\);/s,
    )
    expect(appCss).not.toMatch(/\.sessrow\.is-pinned \.sess \{/s)
  })

  it('gives project actions room away from the scrollbar', () => {
    expect(appCss).toMatch(/\.proj__head > \.icon-btn \{[^}]*width: 28px;[^}]*height: 28px;/s)
  })

  it('keeps the provider visible before the working chat spinner', () => {
    expect(appCss).not.toContain('.sess:has(.sess__spinner)')
    expect(appCss).toMatch(
      /\.sess__spinner \{[^}]*width: 14px;[^}]*flex: none;[^}]*color: var\(--running\);[^}]*animation: spin 800ms linear infinite;/s,
    )
  })

  it('keeps the account popup flush with its trigger', () => {
    // Menu publishes the trigger width and left-aligns the panel to it, but
    // clamps the panel to its viewport gutter. The footer inset has to equal
    // that gutter or the popup starts 2px right of the trigger.
    expect(menuSource).toContain("currentPanel.style.setProperty('--menu-trigger-w'")
    const gutter = menuSource.match(/const VIEWPORT_GUTTER = (\d+)/)?.[1]
    expect(gutter).toBe('8')
    expect(appCss).toMatch(new RegExp(`\\.rail__foot \\{[^}]*padding: 4px ${gutter}px 8px;`, 's'))
    expect(appCss).toMatch(
      /\.menu--settings \{[^}]*min-width: 0;[^}]*width: min\(var\(--menu-trigger-w, 224px\), calc\(100vw - 16px\)\);/s,
    )
  })

  it('keeps the account popup compact and pins its actions below scrolling limits', () => {
    expect(appCss).toMatch(
      /\.menu--settings \{[^}]*max-height: min\(500px, calc\(100vh - 24px\)\);[^}]*display: flex;[^}]*flex-direction: column;[^}]*overflow: hidden;/s,
    )
    expect(appCss).toMatch(/\.menu--compact \{[^}]*gap: 0;[^}]*padding: 3px;/s)
    expect(accountLimitsCss).toMatch(
      /\.account-menu__usage \{[^}]*flex: 0 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/s,
    )
    expect(appCss).toMatch(
      /\.account-menu__actions \{[^}]*flex: none;[^}]*gap: 0;[^}]*padding-top: 0;/s,
    )
    expect(appCss).toMatch(/\.menu--settings \.menu__item \{[^}]*padding: 4px 6px;/s)
  })

  it('names each provider group in the same quiet type as the account menu', () => {
    expect(accountLimitsCss).toMatch(
      /\.account-menu__source h3 \{[^}]*color: var\(--text\);[^}]*font-size: var\(--t-xs\);[^}]*font-weight: 560;/s,
    )
  })

  it('ends the rail in a raised identity card instead of a hard rule', () => {
    expect(appCss).toMatch(/\.rail__foot \{[^}]*padding: 4px 8px 8px;/s)
    expect(appCss).not.toMatch(/\.rail__foot \{[^}]*border-top/s)
    expect(accountCardCss).toMatch(
      /\.account-card \{[^}]*border-radius: var\(--r-card\);[^}]*background: var\(--rail-raised\);[^}]*var\(--shadow-raised\);/s,
    )
    expect(accountCardCss).toMatch(
      /\.account-card__trigger\.menutrigger \{[^}]*width: 100%;[^}]*min-height: 46px;/s,
    )
    expect(accountCardCss).toMatch(/\.account__avatar \{[^}]*width: 32px;[^}]*height: 32px;/s)
    expect(accountCardCss).toMatch(
      /\.account__meter > span \{[^}]*transform-origin: left center;[^}]*transition: transform/s,
    )
    expect(accountCardCss).toMatch(
      /\.account-card__settings \{[^}]*width: 28px;[^}]*height: 28px;[^}]*border-radius: var\(--r-circle\);/s,
    )
    expect(accountCardCss).toMatch(
      /\.menu\.menu--account \{[^}]*width: min\(var\(--menu-trigger-w, 224px\), calc\(100vw - 16px\)\);/s,
    )
    expect(sidebarSource).not.toContain('IconChevronUp')
  })

  it('uses the light foreground color for unread chat dots', () => {
    expect(appCss).toMatch(
      /\.sess__unread-dot \{[^}]*width: 6px;[^}]*height: 6px;[^}]*background: var\(--light\);/s,
    )
  })

  it('keeps unread chat titles on the shared text line', () => {
    // An inline dot before the title pushed unread titles right of every
    // other chat title. The dot trails the title inside the row's meta group.
    expect(appCss).toMatch(/\.sess__meta \{[^}]*display: flex;[^}]*flex: none;/s)
    expect(appCss).toMatch(/\.sess__unread-dot \{[^}]*width: 6px;[^}]*flex: none;/s)
    expect(appCss).not.toMatch(/\.sess__unread-dot \{[^}]*position: absolute/s)
  })

  it('gives project rows a consistent readable rhythm', () => {
    const sessRule = appCss.match(/^\.sess \{(?<body>[\s\S]*?)\n\}/m)?.groups?.['body'] ?? ''
    expect(appCss).toMatch(/\.rail__body \{[^}]*padding: 8px 4px 18px 10px;/s)
    expect(appCss).toMatch(/\.proj \{[^}]*margin-bottom: 4px;/s)
    expect(appCss).toMatch(
      /\.proj__drawer\[data-open='false'\] > \.proj__sessions \{[^}]*margin-block: 0;/s,
    )
    expect(appCss).toMatch(
      /\.proj__head \{[^}]*height: 28px;[^}]*min-height: 28px;[^}]*padding-right: 4px;/s,
    )
    expect(appCss).toMatch(
      /\.proj__toggle \{[^}]*font-size: var\(--rail-font-size\);[^}]*font-weight: var\(--rail-font-weight\);[^}]*height: 28px;[^}]*min-height: 28px;/s,
    )
    expect(appCss).toMatch(/^\s*\.sessrow \{[^}]*height: 28px;[^}]*border-radius: var\(--r-md\);/ms)
    expect(sessRule).toContain('height: 28px;')
    expect(sessRule).toContain('padding: 0 8px 0 var(--sess-indent);')
    expect(sessRule).toContain('font-size: var(--rail-font-size);')
    expect(sessRule).toContain('font-weight: var(--rail-font-weight);')
    expect(sessRule).toContain('border-radius: var(--r-md);')
    expect(sidebarSource).toContain('const VIRTUAL_SESSION_ROW_HEIGHT = 30')
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

  it('marks the active chat with one pill that moves by transform alone', () => {
    expect(appCss).toMatch(
      /\.sessrow__indicator \{[^}]*position: absolute;[^}]*left: var\(--sess-indicator-x\);[^}]*width: 3px;[^}]*height: 14px;[^}]*border-radius: var\(--r-pill\);[^}]*pointer-events: none;/s,
    )
    // The slide is a WAAPI transform (active-indicator.ts), never a layout transition.
    expect(appCss).not.toMatch(/\.sessrow__indicator \{[^}]*transition/s)
    expect(appCss).toMatch(/\.proj__drawer > \.proj__sessions \{[^}]*--sess-indicator-x: 12px;/s)
  })
})
