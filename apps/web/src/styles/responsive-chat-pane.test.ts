import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('responsive chat pane CSS', () => {
  it('compacts by chat width instead of whole-window width', () => {
    expect(css).toMatch(/\.stage \{[^}]*container: chat-stage \/ inline-size;/s)
    expect(css).toMatch(/\.composer \{[^}]*min-width: 0;/s)
    expect(css).toMatch(/\.composer__box \{[^}]*width: 100%;[^}]*min-width: 0;/s)
    expect(css).toMatch(
      /@container chat-stage \(max-width: 480px\) \{[\s\S]*?\.composer \{[^}]*padding-inline: 10px;[\s\S]*?\.composer__permission \.tool > span,[\s\S]*?display: none;/s,
    )
  })
})
