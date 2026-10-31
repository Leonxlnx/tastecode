import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./stage-glide.css', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const glide = readFileSync(new URL('../ui/stage-glide.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

describe('stage glide motion', () => {
  it('clips the pane travel only while a glide runs', () => {
    expect(css).toMatch(/\.shell__body\[data-stage-gliding\] \{\s*overflow: clip;\s*\}/)
    expect(appCss).not.toMatch(/\.shell__body \{[^}]*overflow:/s)
  })

  it('runs on the rail clock and keeps the grid tracks snapping', () => {
    // --dur-slow and --ease-rail, the values the rail's own transition uses.
    expect(glide).toContain('export const STAGE_GLIDE_MS = 260')
    expect(glide).toContain("export const STAGE_GLIDE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'")
    expect(appCss).toMatch(
      /\.rail \{[^}]*transition: transform var\(--dur-slow\) var\(--ease-rail\)/s,
    )
    expect(appCss).not.toMatch(/transition:\s*grid-template-columns/)
    expect(glide).toContain("matchMedia?.('(prefers-reduced-motion: reduce)')")
    expect(app).toContain('<main className="stage" ref={stage}>')
  })
})
