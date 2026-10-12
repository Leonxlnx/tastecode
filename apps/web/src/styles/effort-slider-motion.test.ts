import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

/** Everything from the effort rail's section comment up to the next block. */
function effortSection(): string {
  const start = css.indexOf('/* ---------- effort: a rail with a ring knob')
  const end = css.indexOf('.dither-slider {', start)
  return start >= 0 && end > start ? css.slice(start, end) : ''
}

describe('effort slider motion', () => {
  it('moves the fill by transform instead of resizing it', () => {
    const fill = rule('.model-selector__slider-fill')

    expect(fill).toContain('transform: translateX(')
    expect(fill).not.toMatch(/\bwidth:/)
    expect(fill).not.toContain('animation:')
  })

  it('animates the rail, knob and bubble only through transform and opacity', () => {
    const section = effortSection()
    const transitions = [...section.matchAll(/transition:([^;]*);/g)].map((match) => match[1] ?? '')
    const properties = transitions.flatMap((value) =>
      value
        .split(',')
        .map((item) => item.trim().split(/\s+/)[0])
        .filter((property): property is string => Boolean(property)),
    )

    expect(properties.length).toBeGreaterThan(0)
    for (const property of properties) {
      expect(['transform', 'translate', 'scale', 'opacity']).toContain(property)
    }
  })
})
