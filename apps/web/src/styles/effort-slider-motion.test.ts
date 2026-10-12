import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
)

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('effort meter motion', () => {
  it('reveals the fill with clip-path instead of resizing it', () => {
    const fill = rule('.model-selector__meter-fill')

    expect(fill).toContain('clip-path: inset(')
    expect(fill).toContain('var(--effort-filled)')
    expect(fill).toMatch(/transition: clip-path var\(--dur-press\)/)
    expect(fill).not.toMatch(/\bwidth\b/)
  })

  it('never animates layout anywhere in the effort meter', () => {
    const meter = css.match(
      /\/\* -{10} effort meter -{10}[\s\S]*?\.model-selector__catalog \{/,
    )?.[0]
    expect(meter).toBeTruthy()
    expect(meter).not.toMatch(/transition:[^;]*\b(width|left|right|height|inset)\b/)
    expect(meter).not.toContain('dither')
  })

  it('keeps only colour and opacity settling under reduced motion', () => {
    const reduced = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{\n {2}\/\* The fill jumps[\s\S]*?\n\}/,
    )?.[0]
    expect(reduced).toBeTruthy()
    expect(reduced).not.toContain('clip-path')
    expect(reduced).not.toContain('transform')
  })
})
