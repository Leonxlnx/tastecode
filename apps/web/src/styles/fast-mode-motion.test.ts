import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('fast mode motion', () => {
  it('removes bolt keyframes and keeps restrained state feedback', () => {
    expect(css).not.toContain('fast-bolt-on')
    expect(css).not.toContain('fast-bolt-off')
    expect(css).not.toContain('filter: brightness')
    expect(rule('.model-selector__fast-icon')).not.toContain('transition:')
    expect(css).not.toContain('.model-selector__fast .model-selector__fast-icon')

    const fast = rule('.model-selector__fast')
    expect(fast).toContain('color var(--dur-fast) var(--ease-out)')
    expect(fast).toContain('background var(--dur-fast) var(--ease-out)')
    expect(fast).toContain('border-color var(--dur-fast) var(--ease-out)')
    expect(fast).toContain('box-shadow var(--dur-fast) var(--ease-out)')
    expect(fast).toContain('transform var(--dur-press) var(--ease-out)')

    expect(rule('.model-selector__fast:active')).toContain('transform: scale(0.97)')
  })
})
