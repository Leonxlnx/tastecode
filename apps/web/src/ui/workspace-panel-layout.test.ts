import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./workspace-panel.css', import.meta.url), 'utf8')

describe('workspace panel layout', () => {
  it('aligns the chrome and keeps the launcher in a two-column grid', () => {
    const panel = css.match(/\.workspace-panel \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const layout =
      css.match(/\.workspace-layout\.is-panel-open \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const chrome =
      css.match(/\.workspace-panel__chrome \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const closingControls =
      css.match(
        /\.workspace-panel:not\(\.is-open\) \.workspace-panel__controls \{(?<body>[\s\S]*?)\n\}/,
      )?.groups?.body ?? ''
    const launcher =
      css.match(/\.workspace-selector__list \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''

    expect(panel).toContain('border-top: 1px solid var(--line)')
    expect(panel).toContain('border-left: 1px solid var(--line)')
    expect(layout).toContain(
      'grid-template-columns: minmax(360px, 1fr) min(var(--workspace-panel-w), calc(100% - 360px))',
    )
    expect(chrome).toContain('height: 42px')
    expect(closingControls).toContain('visibility: hidden')
    expect(launcher).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
  })
})
