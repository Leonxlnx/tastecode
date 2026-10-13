import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

const sliderSection =
  css.match(/\/\* -{10} effort slider -{10}[\s\S]*?(?=\n\.model-selector__catalog \{)/)?.[0] ?? ''

describe('effort slider motion', () => {
  it('glides the fill, its lit dots and the thumb on transform with one shared spring', () => {
    for (const selector of [
      '.model-selector__slider-fill',
      '.model-selector__slider-dots.is-lit',
      '.model-selector__slider-thumb',
    ]) {
      const body = rule(selector)
      expect(body, selector).toMatch(/transform: translateX\(/)
      expect(body, selector).toContain(
        'transition: transform var(--effort-glide) var(--effort-spring);',
      )
    }
    expect(rule('.model-selector__slider')).toMatch(/--effort-glide: (1[89]\d|2[0-4]\d)ms;/)
  })

  it('moves the lit dots exactly against the fill so they stay put', () => {
    expect(rule('.model-selector__slider-fill')).toContain(
      'translateX(calc((var(--effort-p) - 1) * var(--effort-travel)))',
    )
    expect(rule('.model-selector__slider-dots.is-lit')).toContain(
      'translateX(calc((1 - var(--effort-p)) * var(--effort-travel)))',
    )
  })

  it('never animates layout or paints a texture', () => {
    expect(sliderSection).not.toBe('')
    expect(sliderSection).not.toMatch(/transition:[^;]*\b(width|left|right|clip-path)\b/)
    expect(sliderSection).not.toMatch(/canvas|dither/)
  })
})
