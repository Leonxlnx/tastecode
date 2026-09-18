import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('macOS integrated title bar', () => {
  it('starts the app body at the window top', () => {
    expect(rule('.shell.is-macos')).toContain('grid-template-rows: minmax(0, 1fr);')
    expect(rule('.shell.is-macos .shell__body')).toContain('grid-row: 1;')
  })

  it('keeps native controls inside the sidebar without painting a full-width row', () => {
    const titlebar = rule('.shell.is-macos .titlebar')

    expect(titlebar).toContain('position: absolute;')
    expect(titlebar).toContain('width: var(--rail-w);')
    expect(titlebar).toContain('background: transparent;')
    expect(rule('.shell.is-macos .rail')).toContain('padding-top: var(--titlebar-h);')
  })

  it('keeps the collapsed sidebar toggle clickable', () => {
    const collapsedTitlebar = rule(
      '.shell.is-macos.is-narrow .titlebar,\n.shell.is-macos[data-rail-fold-preview] .titlebar',
    )
    const collapsedDragRegion = rule(
      '.shell.is-macos.is-narrow .titlebar__drag-region,\n.shell.is-macos[data-rail-fold-preview] .titlebar__drag-region',
    )
    const collapsedStageDragRegion = rule(
      '.shell.is-macos.is-narrow .stagehead__drag-region,\n.shell.is-macos[data-rail-fold-preview] .stagehead__drag-region',
    )

    expect(collapsedTitlebar).toContain('-webkit-app-region: no-drag;')
    expect(collapsedDragRegion).toContain('-webkit-app-region: no-drag;')
    expect(collapsedStageDragRegion).toContain(
      'left: calc(max(12px, env(titlebar-area-x, 12px)) + 42px);',
    )
  })

  it('keeps the control outside a separate native drag region', () => {
    expect(rule('.titlebar')).not.toContain('-webkit-app-region: no-drag;')

    const toggle = rule('.titlebar__toggle')
    const dragRegion = rule('.titlebar__drag-region')

    expect(toggle).toContain('min-width: 30px;')
    expect(toggle).toContain('min-height: 30px;')
    expect(toggle).toContain('pointer-events: auto;')
    expect(toggle).toContain('-webkit-app-region: no-drag;')
    expect(dragRegion).toContain('flex: 1;')
    expect(dragRegion).toContain('-webkit-app-region: drag;')
  })

  it('does not put the stage drag surface below the sidebar control', () => {
    expect(rule('.stagehead')).not.toContain('-webkit-app-region: no-drag;')
    expect(rule('.shell.is-macos .stagehead')).not.toContain('-webkit-app-region: no-drag;')

    const dragRegion = rule('.shell.is-macos .stagehead__drag-region')
    expect(dragRegion).toContain('position: absolute;')
    expect(dragRegion).toContain('right: 116px;')
    expect(dragRegion).toContain('-webkit-app-region: drag;')
  })

  it('moves stage tools to the integrated top row', () => {
    expect(rule('.shell.is-macos .panel-toggles')).toContain('top: 7px;')
    expect(rule('.shell.is-macos .zoom-hud')).toContain('top: 10px;')
  })
})
