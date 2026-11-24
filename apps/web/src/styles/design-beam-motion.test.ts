import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./design-beam.css', import.meta.url), 'utf8')

/** The body of the first block that opens with `head {`, braces balanced. */
function block(source: string, head: string): string {
  const start = source.indexOf(`${head} {`)
  if (start < 0) return ''
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(source.indexOf('{', start) + 1, index)
  }
  return ''
}

function animation(source: string, state: 'active' | 'fading'): string {
  return (
    block(
      source,
      `:is(.composer__design-beam, .composer__design-button-beam)[data-${state}]`,
    ).match(/animation:([^;]*);/)?.[1] ?? ''
  )
}

describe('Creatify beam motion', () => {
  it('spins the beam on its host, which every layer inherits the angle from', () => {
    expect(animation(css, 'active')).toContain('composer-design-beam-spin')
    expect(animation(css, 'fading')).toContain('composer-design-beam-spin')
  })

  it('stops the spin under reduced motion but keeps the beam and its fades', () => {
    const reduced = block(css, '@media (prefers-reduced-motion: reduce)')

    expect(animation(reduced, 'active')).not.toBe('')
    expect(animation(reduced, 'active')).not.toContain('spin')
    expect(animation(reduced, 'active')).toContain(
      'composer-design-beam-fade-in 0.6s ease forwards',
    )
    expect(animation(reduced, 'fading')).not.toContain('spin')
    expect(animation(reduced, 'fading')).toContain(
      'composer-design-beam-fade-out 0.5s ease forwards',
    )
  })
})
