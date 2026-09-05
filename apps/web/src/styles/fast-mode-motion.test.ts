import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const css = readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('fast mode motion', () => {
  it('removes bolt keyframes and keeps restrained state feedback', () => {
    expect(appCss).not.toMatch(
      /:where\(svg\.tabler-icon, svg\[width\]\[height\], svg\[aria-hidden='true'\]\) \{[^}]*transition:/s,
    )
    expect(appCss).not.toMatch(
      /:hover[^{}]*:where\([^)]*svg[^)]*\)[^{]*\{[^}]*\b(?:transform|rotate)\s*:/s,
    )
    expect(appCss).not.toMatch(
      /:where\([^)]*svg[^)]*\):hover[^{]*\{[^}]*\b(?:transform|rotate)\s*:/s,
    )
    expect(appCss).not.toContain('rotate(3deg)')
    expect(css).not.toContain('fast-bolt-on')
    expect(css).not.toContain('fast-bolt-off')
    expect(css).not.toContain('filter: brightness')
    expect(rule('.model-selector__fast-icon')).not.toContain('transition:')
    expect(css).not.toContain('.model-selector__fast .model-selector__fast-icon')
    expect(rule('.model-selector__fast-icon svg')).toContain(
      'transition: fill var(--dur-fast) var(--ease-out);',
    )
    expect(rule('.model-selector__fast-icon svg')).not.toContain('transform')

    const fast = rule('.model-selector__fast')
    expect(fast).toContain('color var(--dur-fast) var(--ease-out)')
    expect(fast).toContain('background var(--dur-fast) var(--ease-out)')
    expect(fast).toContain('border-color var(--dur-fast) var(--ease-out)')
    expect(fast).toContain('box-shadow var(--dur-fast) var(--ease-out)')
    expect(fast).not.toContain('transform')

    expect(rule('.model-selector__fast:active')).toBe('')
  })
})
