import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./context-usage.css', import.meta.url), 'utf8')

describe('context usage meter CSS', () => {
  it('keeps the shared keyboard focus ring on the focusable meter', () => {
    // It opens its tooltip on focus; without the ring nothing shows where focus is.
    expect(css).not.toMatch(/\.context-usage \{[^}]*outline:/s)
  })

  it('draws a visible full track behind the arc in both themes', () => {
    // --line-strong is near the composer surface in light mode, so the track vanished.
    expect(css).toMatch(
      /\.context-usage__track \{\s*stroke: color-mix\(in srgb, var\(--text-3\) 30%, transparent\);/s,
    )
  })

  it('keeps the ring and drops the number in a narrow composer', () => {
    expect(css).toMatch(
      /@container chat-stage \(max-width: 480px\) \{[\s\S]*?\.context-usage__value \{\s*display: none;/s,
    )
  })
})
