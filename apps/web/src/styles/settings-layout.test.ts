import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const systemCss = readFileSync(new URL('./settings-system.css', import.meta.url), 'utf8')
const tuningCss = readFileSync(new URL('./provider-tuning.css', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../ui/Settings.tsx', import.meta.url), 'utf8')

describe('settings viewport CSS', () => {
  it('keeps both panes scrollable inside short windows', () => {
    expect(settingsCss).toMatch(/\.settings__sidebar \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
    expect(settingsCss).toMatch(/\.settings__main \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
  })

  it('keeps the content column in place whether or not the tab scrolls', () => {
    expect(settingsCss).toMatch(/\.settings__main \{[^}]*scrollbar-gutter: stable;/s)
  })

  it('insets every card row, header and note by the same 14px', () => {
    expect(settingsCss).toMatch(/\.settings__row \{[^}]*padding: 10px 14px;/s)
    expect(settingsCss).toMatch(
      /\.settings \.settings__row:has\(> \.settings__row-control > :is\(\.switch, \.settings__switch-skeleton\)\) \{[^}]*padding: 12px 14px;/s,
    )
    expect(settingsCss).toMatch(/\.settings__group-note \{[^}]*padding: 10px 14px;/s)
    expect(settingsCss).toMatch(/\.background-model-settings > header \{[^}]*padding: 10px 14px;/s)
    expect(settingsCss).toMatch(/\.model-visibility__source \{[^}]*padding: 6px 14px;/s)
  })

  it('lays every v1 row out as name, leader and value on one 40px rhythm', () => {
    expect(systemCss).toMatch(
      /\.settings \.set-row \{[^}]*grid-template-columns: minmax\(0, max-content\) minmax\(32px, 1fr\) max-content;[^}]*align-items: center;[^}]*min-height: 40px;[^}]*padding-block: 10px;/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-row:has\(> \.set-row__value > :is\(button, \.app-select, \.settings__switch-skeleton\)\) \{[^}]*padding-block: 6px;/s,
    )
    // One leader for the whole system, coloured through one property.
    expect(systemCss.match(/radial-gradient\(/g)).toHaveLength(1)
    expect(systemCss).toMatch(
      /\.settings \.set-leader \{[^}]*radial-gradient\(circle, var\(--set-leader\) 0\.75px, transparent 1\.15px\)/s,
    )
    expect(systemCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.settings \.set-leader \{[^}]*display: none;/s,
    )
  })

  it('spaces v1 pages by the header and section steps', () => {
    expect(systemCss).toMatch(/\.settings \.set-page__head \{[^}]*margin: 0 0 28px;/s)
    expect(systemCss).toMatch(
      /\.settings \.set-section \+ \.set-section,\s*\.settings \.set-row \+ \.set-section \{[^}]*margin-top: 36px;/s,
    )
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

  it('keeps provider model bulk actions compact, on the segmented track', () => {
    expect(settingsCss).toMatch(/\.model-visibility__bulk-actions \{[^}]*justify-self: end;/s)
    expect(settingsCss).toMatch(/\.model-visibility__bulk-actions button \{[^}]*min-width: 42px;/s)
    expect(systemCss).toMatch(
      /:is\(\.set-segmented, \.settings \.model-visibility__bulk-actions\) \{[^}]*display: inline-flex;[^}]*height: 28px;[^}]*padding: 2px;/s,
    )
  })

  it('draws one segmented control: a 28px track, the chosen option raised', () => {
    expect(systemCss).toMatch(
      /:is\(\.set-segmented, \.settings \.model-visibility__bulk-actions\) \{[^}]*height: 28px;[^}]*padding: 2px;[^}]*background: var\(--bg\);[^}]*border: 1px solid var\(--chrome-border\);[^}]*border-radius: var\(--r-md\);/s,
    )
    expect(systemCss).toMatch(
      /:is\(\.set-segmented__option, \.settings \.model-visibility__bulk-actions button\) \{[^}]*padding: 0 10px;[^}]*border-radius: var\(--r-sm\);[^}]*color: var\(--text-3\);[^}]*font-size: var\(--t-sm\);/s,
    )
    expect(systemCss).toMatch(
      /\.set-segmented \.set-segmented__option\[aria-checked='true'\] \{[^}]*background: var\(--menu-hover\);[^}]*color: var\(--text\);/s,
    )
    expect(tuningCss).not.toMatch(/tune-segmented/)
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
    expect(settingsCss).toMatch(/\.provider-row \.set-button \{[^}]*min-width: 70px;/s)
    // Only a quiet action bleeds to the edge; a boxed one keeps its border on it.
    expect(settingsCss).toMatch(
      /\.provider-row__secondary:has\(> \.set-button--quiet\):has\(\+ \.provider-row__primary:empty\) \{[^}]*margin-right: -10px;/s,
    )
  })

  it('draws every settings button from one 28px set', () => {
    expect(systemCss).toMatch(
      /\.settings :is\(\.set-button, \.settings__action\) \{[^}]*height: 28px;[^}]*padding: 0 10px;[^}]*border: 1px solid var\(--line-strong\);[^}]*border-radius: var\(--r-md\);[^}]*font-size: var\(--t-sm\);[^}]*font-weight: 500;/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-button--primary \{[^}]*background: var\(--text\);[^}]*color: var\(--bg\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings :is\(\.set-button--danger, \.settings__action\.is-danger\):hover:not\(:disabled\) \{[^}]*color: var\(--error\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings :is\(\.set-button--quiet, \.settings__action\.is-secondary\) \{[^}]*border-color: transparent;[^}]*color: var\(--text-3\);/s,
    )
    expect(systemCss).toMatch(/\.settings \.set-button--icon \{[^}]*width: 28px;[^}]*padding: 0;/s)
    // The old per-feature button looks are gone.
    expect(settingsCss).not.toMatch(/(^|\n)\.settings__action \{/)
    expect(settingsCss).not.toMatch(/\.provider-row \.settings__action/)
  })

  it('draws every form field from one 28px text field', () => {
    expect(systemCss).toMatch(
      /\.settings :is\(\.set-input, \.mcp-editor input, \.mcp-editor textarea\) \{[^}]*height: 28px;[^}]*padding: 0 8px;[^}]*border: 1px solid var\(--chrome-border\);[^}]*border-radius: var\(--r-md\);[^}]*font-size: var\(--t-sm\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings :is\(textarea\.set-input, \.mcp-editor textarea\) \{[^}]*min-height: 72px;/s,
    )
    expect(systemCss).toMatch(
      /\.settings :is\(\.set-input, \.mcp-editor input, \.mcp-editor textarea\):focus \{[^}]*border-color: var\(--text-3\);[^}]*box-shadow: 0 0 0 2px color-mix\(in srgb, var\(--text\) 8%, transparent\);/s,
    )
    // The API form's second, 34px copy of the field rules is gone with the first.
    expect(settingsCss).not.toMatch(/\.provider-form input/)
    expect(settingsCss).not.toMatch(/\.mcp-editor input/)
    expect(settingsCss).not.toMatch(/\.avatar-lab__field input/)
  })

  it('has two select looks: boxed for headers and forms, inline for leader rows', () => {
    expect(systemCss).toMatch(
      /\.settings \.app-select__trigger \{[^}]*height: 28px;[^}]*padding: 0 8px;[^}]*font-size: var\(--t-sm\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.menutrigger\.set-select \{[^}]*height: 28px;[^}]*padding: 0 8px;[^}]*background: var\(--bg\);[^}]*border: 1px solid var\(--chrome-border\);[^}]*border-radius: var\(--r-md\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings :is\(\.set-select--inline > \.app-select__trigger, \.menutrigger\.set-select--inline\) \{[^}]*--control-pressed: transparent;[^}]*padding: 4px 0;[^}]*background: none;[^}]*border: 0;[^}]*font-size: inherit;/s,
    )
    // The appearance select and the provider defaults trigger no longer draw their own.
    expect(settingsCss).not.toMatch(/appearance-select/)
    expect(tuningCss).not.toMatch(/\.menutrigger\.provider-tune__trigger \{/)
    expect(settingsCss).not.toMatch(/\.provider-form__select \{[^}]*height:/s)
    expect(settingsSource).not.toContain('appearance-select')
    expect(settingsSource.match(/className="set-select--inline"/g)).toHaveLength(2)
  })

  it('sizes every settings switch 30x18 with a 12px thumb, in one place', () => {
    expect(systemCss).toMatch(
      /:is\(\.settings, \.tune-panel\) \.switch \{[^}]*width: 30px;[^}]*height: 18px;/s,
    )
    expect(systemCss).toMatch(
      /:is\(\.settings, \.tune-panel\) \.switch__thumb \{[^}]*width: 12px;[^}]*height: 12px;/s,
    )
    expect(systemCss).toMatch(
      /:is\(\.settings, \.tune-panel\) \.switch\.is-on \.switch__thumb \{[^}]*translateX\(12px\)/s,
    )
    // No tab or panel sizes its own switch any more.
    for (const css of [settingsCss, systemCss, tuningCss]) {
      expect(css.match(/\.switch \{[^}]*width:/g) ?? []).toHaveLength(css === systemCss ? 1 : 0)
    }
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
