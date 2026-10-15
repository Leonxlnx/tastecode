import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../ui/Settings.tsx', import.meta.url), 'utf8')

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

  it('compacts appearance from its usable pane width', () => {
    expect(settingsCss).toMatch(
      /\.settings__content \{[^}]*container: settings-content \/ inline-size;/s,
    )
    expect(settingsCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.theme-picker \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
    )
    expect(settingsCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.appearance-row__leader \{[^}]*display: none;/s,
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

  it('crossfades the private email blur and morphs its reveal icon', () => {
    expect(settingsCss).toMatch(
      /\.settings__email-clip::before \{[^}]*backdrop-filter: blur\(2\.75px\);[^}]*opacity: 1;[^}]*transition: opacity var\(--dur-reveal\) var\(--ease-out\);/s,
    )
    expect(settingsSource).toContain('<IconMorph active={revealed ? 1 : 0}>')
    expect(settingsSource).toContain('className="settings__email-eye--show"')
    expect(settingsSource).toContain('className="settings__email-eye--hide"')
  })

  it('keeps a single provider action at the far edge on wide and narrow rows', () => {
    expect(settingsCss).toMatch(
      /\.provider-row__primary:empty,\s*\.provider-row__secondary:empty \{[^}]*display: none;/s,
    )
    // Slots space themselves, so the empty action column collapses to nothing.
    expect(settingsCss).toMatch(/\.settings__row\.provider-row \{[^}]*gap: 0;/s)
    expect(settingsCss).toMatch(
      /\.provider-row__secondary \{[^}]*grid-column: 5;[^}]*\}\s*\.provider-row__primary \{[^}]*grid-column: 6;/s,
    )
    expect(settingsCss).toMatch(
      /@container \(max-width: 520px\) \{[\s\S]*?\.provider-row__status \{[^}]*grid-column: 2;[^}]*grid-row: 2;[\s\S]*?\.provider-row__secondary \{[^}]*grid-column: 3;[^}]*\}\s*\.provider-row__primary \{[^}]*grid-column: 4;/s,
    )
    expect(settingsCss).toMatch(/\.provider-row__status \{[^}]*grid-column: 4;[^}]*min-width: 0;/s)
    expect(settingsCss).toMatch(
      /\.provider-row \.settings__action \{[^}]*min-width: 70px;[^}]*min-height: 28px;/s,
    )
  })

  it('draws the provider account wire from the link state', () => {
    expect(settingsCss).toMatch(
      /\.provider-row::after \{[^}]*grid-column: 3;[^}]*radial-gradient\([^}]*repeat-x;/s,
    )
    expect(settingsCss).toMatch(
      /\.provider-row\[data-link='connected'\]::after \{[^}]*linear-gradient\([^}]*animation: provider-wire-draw/s,
    )
    expect(settingsCss).toMatch(
      /\.provider-row\[data-link='none'\]::after \{[^}]*background: none;/s,
    )
    expect(settingsCss).toMatch(
      /\.provider-row\[data-live\]::after \{[^}]*animation: provider-wire-flow/s,
    )
    expect(settingsCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.provider-row::after \{[^}]*animation: none !important;/s,
    )
    // Too narrow for a wire: it steps aside instead of squeezing the account.
    expect(settingsCss).toMatch(
      /@container \(max-width: 520px\) \{[\s\S]*?\.provider-row::after \{[^}]*display: none;/s,
    )
  })
})
