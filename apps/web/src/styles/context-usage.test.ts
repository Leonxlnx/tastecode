import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./context-usage.css', import.meta.url), 'utf8')

describe('context usage meter CSS', () => {
  it('keeps the shared keyboard focus ring on the focusable meter', () => {
    // It opens its tooltip on focus; without the ring nothing shows where focus is.
    expect(css).not.toMatch(/\.context-usage \{[^}]*outline:/s)
  })
})
