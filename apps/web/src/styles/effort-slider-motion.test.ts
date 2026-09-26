import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8')

/** Every declaration block whose selector list ends in `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return Array.from(
    css.matchAll(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'gm')),
    (match) => match.groups?.['body'] ?? '',
  ).join('\n')
}

describe('effort slider motion', () => {
  it('moves the fill and knob with transform instead of resizing the dither canvas', () => {
    const fill = rule('.model-selector__slider-fill')
    expect(fill).not.toMatch(/\bwidth:/)
    expect(fill).not.toContain('transition:')
    expect(fill).not.toContain('animation:')

    for (const selector of ['.model-selector__slider-bar', '.model-selector__slider-knob']) {
      const body = rule(selector)
      expect(body).toContain('var(--model-selector-slider-progress)')
      expect(body).toContain('transition: transform var(--dur-fast) var(--ease-out);')
    }
  })

  it('keeps the dither canvas still on screen while the bar travels', () => {
    expect(rule('.model-selector__slider-bar')).toContain('overflow: hidden;')
    const dither = rule('.model-selector__slider .dither-slider')
    expect(dither).toContain('(1 - var(--model-selector-slider-progress))')
    expect(dither).toContain('transition: transform var(--dur-fast) var(--ease-out);')
  })

  it('never animates layout or stretches the dither cells', () => {
    expect(css).not.toMatch(/transition:[^;]*\b(width|height|left|right|inset)\b/)
    expect(css).not.toMatch(/\bscale(X|Y)?\(/)
  })
})
