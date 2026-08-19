import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const workspacePanelCss = readFileSync(
  new URL('../ui/workspace-panel.css', import.meta.url),
  'utf8',
)

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    source.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.body ?? ''
  )
}

describe('top-bar tool spacing', () => {
  it('keeps both panel toggles in fixed window chrome', () => {
    const toggles = rule(css, '.panel-toggles')

    expect(toggles).toContain('position: fixed;')
    expect(toggles).toContain('z-index: 31;')
    expect(toggles).toContain('right: 8px;')
    expect(toggles).toContain('pointer-events: auto;')
    expect(toggles).toContain('-webkit-app-region: no-drag;')
    expect(rule(css, '.panel-toggles.is-workspace-open')).toContain('right: 44px;')
  })

  it('pins the workspace expand button to the panel corner', () => {
    expect(rule(workspacePanelCss, '.workspace-panel__chrome')).toContain('padding: 4px 8px;')
    expect(rule(workspacePanelCss, '.workspace-panel__controls')).toContain('padding-left: 74px;')
    expect(rule(workspacePanelCss, '.workspace-panel__controls')).toContain('margin-right: 0;')
  })
})
