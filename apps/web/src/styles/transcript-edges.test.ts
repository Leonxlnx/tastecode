import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

// Every transcript row starts its first glyph on the reply text edge.
describe('transcript row edges', () => {
  it('starts an activity summary on the text edge with or without its icon', () => {
    const summary = rule('.activity__summary')
    // -3.5px + 2px padding + 1.5px inside the 18px icon box = the text edge.
    expect(summary).toContain('margin-left: -3.5px;')
    expect(summary).toContain('padding: 0 2px 4px;')
    expect(rule('.activity__glyph')).toContain('width: 18px;')
    // Without the icon box: -2px + 2px padding = the text edge.
    expect(rule('.activity__summary--bare')).toContain('margin-left: -2px;')
  })
})
