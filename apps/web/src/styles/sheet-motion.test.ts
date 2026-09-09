import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./popup-motion.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('sheet motion', () => {
  it('gives sheets and pull-request dialogs the same short entrance', () => {
    expect(rule('.sheet__panel,\n.pr-dialog')).toContain('transform 200ms var(--ease-out)')
    expect(css).toMatch(
      /@starting-style \{[\s\S]*?\.sheet__panel,[\s\S]*?translateY\(6px\) scale\(0\.97\);/s,
    )
    expect(css).not.toContain('@keyframes')
  })

  it('removes dialog movement under reduced motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sheet__panel,[\s\S]*?\.pr-dialog \{[\s\S]*?transform: none;[\s\S]*?transition: opacity 100ms var\(--ease-out\) !important;/s,
    )
  })
})
