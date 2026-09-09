import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('effort slider motion', () => {
  it('keeps the slider fill width but removes width animation from the fill', () => {
    const fill = rule('.model-selector__slider-fill')

    expect(fill).toContain('width: var(--model-selector-slider-width)')
    expect(fill).not.toContain('transition:')
    expect(fill).not.toContain('animation:')
  })

  it('does not animate width inside the model selector slider styles', () => {
    const sliderSection = css.match(
      /\.model-selector__slider \{[\s\S]*?\.model-selector__slider-stop \{/,
    )?.[0]
    expect(sliderSection).not.toMatch(/transition:[\s\S]*?\bwidth\b/)
  })
})
