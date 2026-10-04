import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const resourcePickerCss = readFileSync(
  new URL('./composer-resource-picker.css', import.meta.url),
  'utf8',
)
const workspaceCss = readFileSync(new URL('../ui/workspace-panel.css', import.meta.url), 'utf8')

describe('responsive chat pane CSS', () => {
  it('compacts by chat width instead of whole-window width', () => {
    expect(css).toMatch(/\.stage \{[^}]*container: chat-stage \/ inline-size;/s)
    expect(css).toMatch(/\.composer \{[^}]*min-width: 0;/s)
    expect(css).toMatch(/\.composer__box \{[^}]*width: 100%;[^}]*min-width: 0;/s)
    expect(css).toMatch(
      /@container chat-stage \(max-width: 620px\) \{[\s\S]*?\.tools \.composer__permission,[\s\S]*?width: 34px;[\s\S]*?\.composer__permission \.tool > span,[\s\S]*?display: none;/s,
    )
    expect(css).toMatch(
      /@container chat-stage \(max-width: 480px\) \{[\s\S]*?\.composer \{[^}]*padding-inline: 10px;/s,
    )
    expect(resourcePickerCss).toMatch(
      /@container chat-stage \(max-width: 480px\) \{[\s\S]*?\.composer-resource-picker__description,[\s\S]*?display: none;/s,
    )
    expect(css).toMatch(/\.tools \.composer__design \{[^}]*width: 100%;/s)
    expect(workspaceCss).toMatch(/\.workspace-panel:not\(\.is-open\) \{[^}]*overflow: hidden;/s)
  })
})
