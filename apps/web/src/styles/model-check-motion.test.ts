import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('model check motion', () => {
  it('renders the selected model check at rest', () => {
    expect(css).not.toContain('model-check-pop')
    expect(css).not.toMatch(/transform:\s*scale\(0\)/)

    const icon = rule('.model-selector__model > svg')
    expect(icon).toContain('flex: none')
    expect(icon).toContain('color: var(--text-2)')
  })
})
