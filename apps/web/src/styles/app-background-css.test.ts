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

  it('stands the aurora still for reduced motion and steps it otherwise', () => {
    expect(sheet).toMatch(/animation: app-bg-aurora \d+s steps\(\d+\) infinite alternate;/)
    const reduced = sheet.slice(sheet.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.app-bg\[data-effect='aurora'\]::before \{\s*animation: none;/)
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

  it('fades the transcript under the composer without covering the scrollbar', () => {
    const dock = read('./app.css').match(
      /\.stage__conversation:not\(\.is-new-session\) > \.composer::before \{[^}]*inset: 0 (\d+)px 0 0;/,
    )
    expect(dock?.[1]).toBeDefined()
    expect(sheet).toContain(`calc(100% - ${dock?.[1]}px) 100%,`)
    expect(sheet).toContain(`${dock?.[1]}px 100%;`)
  })
})
