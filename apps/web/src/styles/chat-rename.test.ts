import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.body ?? ''
}

describe('chat rename fields', () => {
  it('keeps rename editing in the rendered title surface', () => {
    const shared = rule('.rename--chat,\n.stagehead__rename')

    expect(shared).toContain('background: transparent;')
    expect(shared).toContain('border: 0;')
    expect(shared).toContain('box-shadow: none;')
    expect(shared).toContain('color: color-mix(in srgb, var(--text-2) 82%, transparent);')
    expect(shared).toContain('caret-color: AccentColor;')
  })

  it('uses the operating system accent with a softer selected foreground', () => {
    const selection = rule('.rename--chat::selection,\n.stagehead__rename::selection')

    expect(selection).toContain('background: AccentColor;')
    expect(selection).toContain('color: color-mix(in srgb, AccentColorText 88%, AccentColor);')
  })

  it('keeps a sidebar rename in the original chat row geometry', () => {
    const sidebar = rule('.sessrow > .rename--session')

    expect(sidebar).toContain('height: 25px;')
    expect(sidebar).toContain('padding: 0 12px 0 28px;')
    expect(sidebar).toContain('color: color-mix(in srgb, var(--text-2) 82%, transparent);')
    expect(sidebar).toContain('font-size: var(--rail-font-size);')
  })
})
