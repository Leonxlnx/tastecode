import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('settings viewport CSS', () => {
  it('keeps both panes scrollable inside short windows', () => {
    expect(appCss).toMatch(/\.settings__sidebar \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
    expect(appCss).toMatch(/\.settings__main \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
  })

  it('keeps narrow categories on the horizontal axis', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 700px\) \{[\s\S]*?\.settings__nav \{[^}]*overflow-x: auto;/s,
    )
  })

  it('bounds state and action controls to the narrow row width', () => {
    expect(appCss).toMatch(
      /\.settings__row-control:has\(> \.state-label\) \{[^}]*max-width: 100%;/s,
    )
  })

  it('keeps a single provider action at the far edge on wide and narrow rows', () => {
    expect(appCss).toMatch(
      /\.provider-row__primary \{[^}]*grid-column: 6;[^}]*\}[\s\S]*?\.provider-row__secondary:has\(\+ \.provider-row__primary:empty\) \{[^}]*grid-column: 6;/s,
    )
    expect(appCss).toMatch(
      /@container \(max-width: 514px\) \{[\s\S]*?grid-template-areas:[^;]*'secondary secondary primary';[^}]*grid-template-columns: 20px minmax\(0, 1fr\) minmax\(88px, max-content\);[\s\S]*?\.provider-row__secondary:has\(\+ \.provider-row__primary:empty\) \{[^}]*grid-area: primary;/s,
    )
    expect(appCss).toMatch(
      /\.provider-row \.settings__action \{[^}]*width: auto;[^}]*min-width: 78px;[^}]*min-height: 30px;/s,
    )
  })
})
