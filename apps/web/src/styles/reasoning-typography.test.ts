import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body']
}

describe('reasoning typography', () => {
  it('renders thinking as prose while keeping other operational output monospace', () => {
    expect(rule('.aux__out')).toContain('font-family: var(--font-mono)')
    expect(rule('.reasoning-summary')).toContain('font-family: var(--font-ui)')
  })
})
