import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const triggerCss = readFileSync(new URL('./model-selector.css', import.meta.url), 'utf8')
const menuCss = readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8')

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

const sliderSection =
  menuCss.match(/\/\* -{10} effort slider -{10}[\s\S]*?(?=\n\.model-selector__catalog \{)/)?.[0] ??
  ''

/*
 * A long nowrap model name (OpenCode and ACP list rows like "MiniMax Token
 * Plan (minimax.io) · MiniMax-M3.1-Flash-Preview") used to widen the picker
 * past its 300px panel: the panel is a grid (.menu) and a grid item's
 * automatic minimum is its min-content width. The search field, the list and
 * the effort pill were laid out ~375px wide and clipped, and the search field
 * taking focus on open scrolled the hidden-overflow panel ~34px sideways.
 */
describe('model picker horizontal overflow', () => {
  it('lets the picker body shrink to the panel instead of to its longest row', () => {
    expect(rule(menuCss, '.model-selector')).toContain('min-width: 0;')
    expect(rule(menuCss, '.model-selector__controls')).toContain(
      'grid-template-columns: minmax(0, 1fr);',
    )
  })

  it('clips the panel without making it a scroll container', () => {
    const panel = rule(triggerCss, '.model-selector__menu')
    expect(panel).toContain('overflow: clip;')
    expect(panel).not.toMatch(/overflow(-x)?: (hidden|auto|scroll);/)
  })

  it('never lets the model list scroll sideways', () => {
    const list = rule(menuCss, '.model-selector__models')
    expect(list).toContain('overflow-x: hidden;')
    expect(list).toContain('overflow-y: auto;')
  })

  it('ellipsizes a long provider name in either layout instead of cutting it', () => {
    const title = rule(menuCss, '.model-selector__group-title')
    expect(title).toContain('display: flex;')
    expect(title).toContain('min-width: 0;')
  })

  it('clips the effort pill without a scroll range for its lit dots', () => {
    for (const selector of ['.model-selector__slider-clip', '.model-selector__slider-fill']) {
      expect(rule(menuCss, selector), selector).toContain('overflow: clip;')
    }
    expect(sliderSection).not.toBe('')
    expect(sliderSection).not.toMatch(/overflow(-x)?: (hidden|auto|scroll);/)
  })
})
