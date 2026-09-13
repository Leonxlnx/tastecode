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
  it('keeps the new-chat shelf compact and flat', () => {
    const shelf = rule(css, '.composer__shelf')
    const control = rule(css, '.shelf-control')
    const content = rule(css, '.shelf-control__content')

    expect(shelf).toContain('gap: 4px;')
    expect(shelf).toContain('min-height: 32px;')
    expect(shelf).toContain('padding: 1px 10px;')
    expect(shelf).toContain('background: var(--bg-shelf);')
    expect(shelf).not.toContain('linear-gradient')
    expect(control).toContain('padding: 3px 5px;')
    expect(control).toContain('font-size: var(--t-sm);')
    expect(control).toContain('border-radius: var(--r-md);')
    expect(content).toContain('gap: 6px;')
    expect(rule(css, '.composer__shelf .shelf-control:hover:not(:disabled)')).toContain(
      'box-shadow: none;',
    )
  })

  it('keeps both panel toggles in fixed window chrome', () => {
    const toggles = rule(css, '.panel-toggles')

    expect(toggles).toContain('position: fixed;')
    expect(toggles).toContain('z-index: 31;')
    expect(toggles).toContain('right: 8px;')
    expect(toggles).toContain('pointer-events: auto;')
    expect(toggles).toContain('-webkit-app-region: no-drag;')
    expect(rule(css, '.panel-toggles.is-workspace-open')).toContain('right: 44px;')
  })

  it('keeps the top-bar options menu dense without visible scrollbar chrome', () => {
    const menu = rule(css, '.menu.stagehead__options-menu')

    expect(menu).toContain('width: min(216px, calc(100vw - 16px));')
    expect(menu).toContain('max-height: min(480px, calc(100vh - 58px));')
    expect(menu).toContain('scrollbar-width: none;')
    expect(rule(css, '.menu.stagehead__options-menu::-webkit-scrollbar')).toContain(
      'display: none;',
    )
  })

  it('pins the workspace close button to the upper-right corner', () => {
    const close = rule(workspacePanelCss, '.workspace-panel__close')
    expect(close).toContain('position: absolute;')
    expect(close).toContain('top: 8px;')
    expect(close).toContain('right: 8px;')
  })
})
