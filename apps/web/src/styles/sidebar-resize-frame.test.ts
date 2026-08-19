import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('sidebar resize frame', () => {
  it('continues the thick resize guide through the rounded stage corner', () => {
    const corner = rule('.rail__resize::before')

    expect(corner).toContain('border-top: 2px solid var(--line-strong);')
    expect(corner).toContain('border-left: 2px solid var(--line-strong);')
    expect(corner).toContain('border-top-left-radius: 10px;')
  })

  it('shows the corner and straight guide for hover, focus, and active resizing', () => {
    const visibleRule = rule(`.rail__resize:is(:hover, :focus-visible)::before,
.rail__resize:is(:hover, :focus-visible)::after,
.shell[data-resizing] .rail__resize::before,
.shell[data-resizing] .rail__resize::after`)

    expect(visibleRule).toContain('opacity: 1;')
  })
})
