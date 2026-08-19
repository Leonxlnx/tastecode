import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('sheet motion', () => {
  it('restores a centered sheet entry without reviving step-in', () => {
    expect(rule('.sheet__panel')).toContain('animation: sheet-in 220ms var(--ease-out) both;')
    expect(css).toContain('@keyframes sheet-in')
    expect(css).toMatch(/@keyframes sheet-in \{[\s\S]*?translateY\(2px\) scale\(0\.97\);/s)
    expect(css).not.toContain('animation: step-in')
  })

  it('swaps sheet motion to fade-in under reduced motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sheet__scrim,[\s\S]*?\.sheet__panel \{[\s\S]*?animation: fade-in var\(--dur-fast\) var\(--ease-out\) both !important;/s,
    )
  })
})
