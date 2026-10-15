import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

/*
 * The composer floats over the transcript with a transparent dock, so a long
 * chat scrolled up showed text, table rows and card borders in the strip below
 * the composer box and in the gutters beside it.
 */
describe('floating composer dock', () => {
  const dock = rule(appCss, '.stage__conversation:not(.is-new-session) > .composer::before')

  it('paints the pane background behind the box down to the bottom edge', () => {
    expect(dock).toContain("content: '';")
    expect(dock).toContain('position: absolute;')
    expect(dock).toContain('z-index: -1;')
    expect(dock).toContain('background: linear-gradient(to bottom, transparent, var(--bg) 12px);')
    expect(dock).toContain('pointer-events: none;')
  })

  it('leaves the transcript scrollbar visible and clickable', () => {
    const width = tokensCss.match(/::-webkit-scrollbar \{\s*width: (\d+)px;/)?.[1]
    expect(dock).toContain(`inset: 0 ${width}px 0 0;`)
  })
})
