import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')

describe('settings viewport CSS', () => {
  it('keeps both panes scrollable inside short windows', () => {
    expect(settingsCss).toMatch(/\.settings__sidebar \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
    expect(settingsCss).toMatch(/\.settings__main \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
  })

  it('keeps narrow categories on the horizontal axis', () => {
    expect(settingsCss).toMatch(
      /@media \(max-width: 700px\) \{[\s\S]*?\.settings__nav \{[^}]*overflow-x: auto;/s,
    )
  })

  it('bounds state and action controls to the narrow row width', () => {
    expect(settingsCss).toMatch(
      /\.settings__row-control:has\(> \.state-label\) \{[^}]*max-width: 100%;/s,
    )
  })

  it('softens the private email blur and swaps its reveal icons', () => {
    expect(settingsCss).toMatch(
      /\.settings__email-value \{[^}]*filter: blur\(2\.75px\);[^}]*opacity: 0\.72;[^}]*filter var\(--dur-reveal\) var\(--ease-out\),[^}]*opacity var\(--dur-reveal\) var\(--ease-out\);/s,
    )
    expect(settingsCss).toMatch(
      /\.settings__email\[data-revealed='true'\] \.settings__email-eye--show \{[^}]*opacity: 0;[^}]*transform: scale\(0\.82\);/s,
    )
    expect(settingsCss).toMatch(
      /\.settings__email\[data-revealed='true'\] \.settings__email-eye--hide \{[^}]*opacity: 1;[^}]*transform: scale\(1\);/s,
    )
  })

  it('keeps a single provider action at the far edge on wide and narrow rows', () => {
    expect(settingsCss).toMatch(
      /\.provider-row__primary:empty,\s*\.provider-row__secondary:empty \{[^}]*display: none;/s,
    )
    expect(settingsCss).toMatch(
      /\.provider-row__primary \{[^}]*grid-column: 6;[^}]*\}[\s\S]*?\.provider-row__secondary:has\(\+ \.provider-row__primary:empty\) \{[^}]*grid-column: 6;/s,
    )
    expect(settingsCss).toMatch(
      /@container \(max-width: 514px\) \{[\s\S]*?grid-template-areas:[^;]*'secondary secondary primary';[^}]*grid-template-columns: 20px minmax\(0, 1fr\) minmax\(88px, max-content\);[\s\S]*?\.provider-row__secondary:has\(\+ \.provider-row__primary:empty\) \{[^}]*grid-area: primary;/s,
    )
    expect(settingsCss).toMatch(
      /\.provider-row \.settings__action \{[^}]*width: auto;[^}]*min-width: 78px;[^}]*min-height: 30px;/s,
    )
  })
})
