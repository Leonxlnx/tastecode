import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const appCss = read('./app.css')
const panelCss = read('../ui/workspace-panel.css')

describe('shell row', () => {
  it('never reaches past the window, even while the closed workspace panel rests offset', () => {
    const shellBody = appCss.match(/^\.shell__body \{(?<body>[\s\S]*?)\n\}/m)?.groups?.body ?? ''
    expect(shellBody).toContain('overflow-x: clip;')
    // The resting offset the clip exists for: a packaged build measured the page 25px wider
    // than the window once the panel had been opened and closed.
    expect(panelCss).toContain('transform: translate3d(24px, 0, 0);')
  })
})
