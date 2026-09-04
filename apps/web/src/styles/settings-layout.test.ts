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

  it('compacts appearance controls from their usable pane width', () => {
    expect(settingsCss).toMatch(
      /\.settings__content \{[^}]*container: settings-content \/ inline-size;/s,
    )
    expect(settingsCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.theme-picker \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
    )
    expect(settingsCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.appearance-code-preview \{[^}]*grid-template-columns: 1fr;[\s\S]*?\.appearance-editor__row \{[^}]*flex-direction: column;[\s\S]*?\.appearance-control \{[^}]*width: 100%;/s,
    )
    expect(settingsCss).toMatch(
      /\.appearance-control__select \{[^}]*width: min\(190px, 100%\);[^}]*max-width: none;/s,
    )
  })

  it('bounds state and action controls to the narrow row width', () => {
    expect(settingsCss).toMatch(
      /\.settings__row-control:has\(> \.state-label\) \{[^}]*max-width: 100%;/s,
    )
  })

  it('keeps provider model bulk actions compact', () => {
    expect(settingsCss).toMatch(
      /\.model-visibility__bulk-actions \{[^}]*display: inline-flex;[^}]*justify-self: end;/s,
    )
    expect(settingsCss).toMatch(
      /\.model-visibility__bulk-actions button \{[^}]*min-width: 42px;[^}]*min-height: 28px;/s,
    )
  })

  it('crossfades the softer private email blur and swaps its reveal icons', () => {
    expect(settingsCss).toMatch(
      /\.settings__email-clip::before \{[^}]*backdrop-filter: blur\(2\.75px\);[^}]*opacity: 1;[^}]*transition: opacity var\(--dur-reveal\) var\(--ease-out\);/s,
    )
    expect(settingsCss).toMatch(
      /\.settings__email\[data-revealed='true'\] \.settings__email-eye--show \{[^}]*opacity: 0;[^}]*transform: scale\(0\.9\);/s,
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
