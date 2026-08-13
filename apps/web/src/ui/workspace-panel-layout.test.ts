import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./workspace-panel.css', import.meta.url), 'utf8')

describe('workspace panel layout', () => {
  it('aligns the chrome and keeps the launcher in a two-column grid', () => {
    const panel = css.match(/\.workspace-panel \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const chrome =
      css.match(/\.workspace-panel__chrome \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''
    const launcher =
      css.match(/\.workspace-selector__list \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''

    expect(panel).not.toContain('border-top')
    expect(chrome).toContain('height: 42px')
    expect(launcher).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
  })
})
