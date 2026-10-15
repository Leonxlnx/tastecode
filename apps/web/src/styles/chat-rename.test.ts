import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.body ?? ''
}

describe('chat rename fields', () => {
  it('draws every rename as a visible focused field', () => {
    const field = rule('.rename')

    expect(field).toContain('background: var(--surface);')
    expect(field).toContain('border: 1px solid var(--text-3);')
    expect(field).toContain(
      'box-shadow: 0 0 0 3px color-mix(in srgb, var(--text) 8%, transparent);',
    )
    expect(field).toContain('caret-color: AccentColor;')
    // No rule may hide the field again for chats or the stage header.
    expect(css).not.toMatch(/\.rename--chat[^{]*\{[^}]*border: 0;/)
    expect(rule('.stagehead__rename')).not.toContain('border: 0;')
    expect(rule('.stagehead__rename')).not.toContain('background: transparent;')
  })

  it('uses the operating system accent with a softer selected foreground', () => {
    const selection = rule('.rename::selection')

    expect(selection).toContain('background: AccentColor;')
    expect(selection).toContain('color: color-mix(in srgb, AccentColorText 88%, AccentColor);')
  })

  it('keeps each field text where its title was', () => {
    const sidebar = rule('.sessrow > .rename--session')
    expect(sidebar).toContain('height: 24px;')
    // indent + 14px margin + 1px border + 6px padding = indent + mark + gap (21px).
    expect(sidebar).toContain('margin: 0 4px 0 calc(var(--sess-indent) + 14px);')
    expect(sidebar).toContain('padding: 0 6px;')
    expect(sidebar).toContain('font-size: var(--rail-font-size);')

    const header = rule('.stagehead__rename')
    // -8px margin + 1px border + 7px padding.
    expect(header).toContain('margin-left: -8px;')
    expect(header).toContain('padding: 0 7px;')
    expect(header).toContain('field-sizing: content;')
  })
})
