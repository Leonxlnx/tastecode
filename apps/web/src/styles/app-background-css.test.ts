import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

const sheet = read('./app-background.css')

describe('window background stylesheet', () => {
  it('loads only with the lazy layer, never at startup', () => {
    expect(read('../ui/AppBackgroundLayer.tsx')).toContain("import '../styles/app-background.css'")
    expect(read('../ui/AppBackground.tsx')).toContain("import('./AppBackgroundLayer.js')")
    expect(read('../ui/AppBackground.tsx')).not.toMatch(/from ['"]\.\/AppBackgroundLayer\.js['"]/)
    for (const eager of ['../main.tsx', '../App.tsx', './app.css', './tokens.css']) {
      expect(read(eager)).not.toContain('app-background.css')
    }
  })

  it('moves nothing in CSS: the effects move on their own canvas', () => {
    expect(sheet).not.toMatch(/animation|@keyframes|will-change/)
    expect(sheet).not.toMatch(/aurora|glow/)
  })

  it('fades the moving canvas like the tile and drops the tile while it draws', () => {
    for (const effect of ['dither', 'halftone']) {
      const rule = sheet.match(
        new RegExp(`\\.app-bg\\[data-effect='${effect}'\\] > \\.app-bg__motion \\{([^}]*)\\}`),
      )
      expect(rule?.[1]).toContain(`opacity: calc(var(--app-bg-${effect}) * var(--app-bg-fade));`)
    }
    expect(sheet).toMatch(/\.app-bg__motion \{[^}]*color: var\(--text\);/)
    expect(sheet).toContain('.app-bg[data-motion]::before {\n  content: none;\n}')
  })

  it('no longer paints the dropped Dot grid and Grain', () => {
    expect(sheet).not.toMatch(/'dots'|'grain'|--app-bg-dots|--app-bg-grain|--app-bg-noise/)
  })

  it('paints each effect in the text colour and fades it with Dim', () => {
    for (const effect of ['dither', 'halftone']) {
      const rule = sheet.match(
        new RegExp(`\\.app-bg\\[data-effect='${effect}'\\]::before \\{([^}]*)\\}`),
      )
      expect(rule?.[1]).toContain('mask:')
      expect(rule?.[1]).toContain(`opacity: calc(var(--app-bg-${effect}) * var(--app-bg-fade));`)
    }
    expect(sheet).toContain(
      ".app-bg[data-mode='effect']::before {\n  background-color: var(--text);",
    )
    expect(sheet).toContain('--app-bg-fade: max(0, calc(2 - var(--app-bg-dim, 1)));')
  })

  it('never blurs live content behind a pane', () => {
    for (const match of sheet.matchAll(/backdrop-filter:\s*([^;]+);/g)) {
      expect(match[1]).toBe('none')
    }
    expect(sheet).not.toMatch(/(^|[^-])filter:\s*blur/m)
  })

  it('keeps the narrow-window drawer as solid as it is without a background', () => {
    // app.css makes the open rail solid below 700px, where it is a drawer
    // over the chat. The pane rule here outranks that one, so the drawer
    // needs its own override: the same selector, inside the same query, later.
    const pane =
      ':root[data-app-bg][data-theme][data-shell][data-glass] .rail-slot:not(.is-collapsed) .rail {'
    expect(read('./app.css')).toMatch(
      /@media \(max-width: 700px\) \{\s*:root\[data-glass='on'\] \.rail-slot \.rail \{[^}]*background: var\(--bg-rail\);/,
    )
    const translucent = sheet.indexOf(`${pane}\n  background: var(--app-bg-rail-pane);`)
    const drawerRule = `@media (max-width: 700px) {\n  ${pane}\n    background: var(--bg-rail);\n  }\n}`
    const drawer = sheet.indexOf(drawerRule)
    expect(translucent).toBeGreaterThan(-1)
    expect(drawer).toBeGreaterThan(translucent)
    // Nothing after it paints the rail again.
    expect(sheet.slice(drawer + drawerRule.length)).not.toMatch(/\.rail\b/)
  })

  it('turns the title bar into the sidebar pane, except where a Mac already paints it', () => {
    expect(sheet).toContain(
      ':root[data-app-bg][data-theme][data-shell][data-glass] .shell:not(.is-macos) > .titlebar {\n  background: var(--app-bg-rail-pane);\n}',
    )
  })

  it('fades the transcript under the composer without covering the scrollbar', () => {
    const dock = read('./app.css').match(
      /\.stage__conversation:not\(\.is-new-session\) > \.composer::before \{[^}]*inset: 0 (\d+)px 0 0;/,
    )
    expect(dock?.[1]).toBeDefined()
    expect(sheet).toContain(`calc(100% - ${dock?.[1]}px) 100%,`)
    expect(sheet).toContain(`${dock?.[1]}px 100%;`)
  })
})
