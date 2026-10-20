import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const systemCss = readFileSync(new URL('./settings-system.css', import.meta.url), 'utf8')
const tuningCss = readFileSync(new URL('./provider-tuning.css', import.meta.url), 'utf8')
const generalCss = readFileSync(new URL('./general-settings.css', import.meta.url), 'utf8')
const keybindsCss = readFileSync(new URL('./keybinds.css', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../ui/Settings.tsx', import.meta.url), 'utf8')
const accountEmailSource = readFileSync(new URL('../ui/AccountEmail.tsx', import.meta.url), 'utf8')

/** Every component source under ui/, tests excluded, as [path, text]. */
function uiSources(): Array<[string, string]> {
  const root = new URL('../ui/', import.meta.url)
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
    .map((file) => [file, readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8')])
}

describe('settings viewport CSS', () => {
  it('keeps both panes scrollable inside short windows', () => {
    expect(settingsCss).toMatch(/\.settings__sidebar \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
    expect(settingsCss).toMatch(/\.settings__main \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
  })

  it('keeps the content column in place whether or not the tab scrolls', () => {
    expect(settingsCss).toMatch(/\.settings__main \{[^}]*scrollbar-gutter: stable;/s)
  })

  it('has no card rows or groups left, only the v1 rows', () => {
    expect(settingsCss).not.toMatch(/settings__(row|group)/)
    for (const [file, source] of uiSources()) {
      expect(/settings__(row|group)\b/.test(source), file).toBe(false)
    }
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
    // A narrow pane moves page actions under the description instead of squeezing it.
    expect(systemCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.settings \.set-page__head \{[^}]*flex-wrap: wrap;/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-section \+ \.set-section,\s*\.settings \.set-row \+ \.set-section \{[^}]*margin-top: 36px;/s,
    )
  })

  it('sets General in the row type, its settings the section step apart', () => {
    expect(generalCss).toMatch(/\.general \{[^}]*gap: 36px;/s)
    expect(generalCss).toMatch(
      /\.general-setting__name \{[^}]*color: var\(--text-2\);[^}]*font-size: var\(--t-md\);[^}]*font-weight: 500;[^}]*line-height: 1\.35;/s,
    )
    expect(generalCss).toMatch(
      /\.general-setting__note \{[^}]*color: var\(--text-3\);[^}]*font-size: var\(--t-sm\);[^}]*line-height: 1\.45;/s,
    )
    expect(generalCss).toMatch(
      /\.general-option__label \{[^}]*font-size: var\(--t-sm\);[^}]*font-weight: 500;/s,
    )
    // Letter-spacing belongs to the title and entity roles only.
    expect(generalCss).not.toMatch(/letter-spacing/)
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
    expect(systemCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.settings \.set-leader \{[^}]*display: none;/s,
    )
  })

  it('lays Appearance out on the shared rows and sections', () => {
    // Its private row, leader and section copies are gone.
    expect(settingsCss).not.toMatch(/appearance-row|appearance-section|--appearance-leader/)
    expect(settingsSource).not.toContain('AppearanceRow')
    expect(settingsSource).not.toContain('appearance-section')
    // The previews start at the column edge, under the section heading.
    expect(settingsCss).not.toMatch(/\.theme-picker \{[^}]*justify-content/s)
    expect(settingsCss).toMatch(/\.theme-picker \{[^}]*margin: 12px 0 0;/s)
    expect(settingsCss).toMatch(
      /\.theme-option__label \{[^}]*font-size: var\(--t-sm\);[^}]*font-weight: 500;/s,
    )
    // Reset colors is the section's quiet action, flush with the column edge.
    expect(systemCss).toMatch(/\.settings \.set-section__action \{[^}]*margin-block: -6px;/s)
    expect(systemCss).toMatch(
      /\.settings :is\(\.set-page__actions, \.set-section__action\) > \.set-button--quiet:last-child \{[^}]*margin-right: -10px;/s,
    )
  })

  it('lays Keybinds out on the shared rows, leader and text field', () => {
    // The leader is the shared one; its old private copy and property are gone.
    expect(keybindsCss).not.toMatch(/radial-gradient\(|--keybind-wire/)
    expect(keybindsCss).not.toMatch(
      /keybind-row__leader|keybind-group|keybind-settings__(header|intro|restore|empty)/,
    )
    // Recording still runs the shared leader towards the keys, unless refused.
    expect(keybindsCss).toMatch(
      /\.keybind-row\[data-recording\]:not\(\[data-tone='error'\]\) \.set-leader \{[^}]*linear-gradient\(90deg, var\(--set-leader\) 50%, transparent 50%\)[^}]*animation: keybind-wire-flow/s,
    )
    expect(keybindsCss).toMatch(
      /\.keybind-row\[data-landed\] \.set-leader \{[^}]*keybind-wire-draw/s,
    )
    // The shortcut keeps the last column when a narrow row drops its leader
    // column, so an open row's detail still spans the whole row.
    expect(keybindsCss).toMatch(/\.keybind-recorder \{[^}]*grid-column: -2 \/ -1;/s)
    // The search is the settings field with room for its glyph.
    expect(keybindsCss).toMatch(
      /\.settings \.keybind-settings__search \.set-input \{[^}]*padding-left: 28px;/s,
    )
    // A row with nothing bound still lights under the pointer.
    expect(systemCss.indexOf(".set-row[data-tone='muted']")).toBeLessThan(
      systemCss.indexOf('.set-row:is(:hover, :focus-within) {'),
    )
    expect(systemCss.indexOf('.set-row:is(:hover, :focus-within) {')).toBeLessThan(
      systemCss.indexOf(".set-row[data-tone='active']"),
    )
  })

  it('keeps provider model bulk actions compact, on the segmented track', () => {
    expect(settingsCss).toMatch(/\.model-visibility__bulk-actions button \{[^}]*min-width: 42px;/s)
    expect(systemCss).toMatch(
      /:is\(\.set-segmented, \.settings \.model-visibility__bulk-actions\) \{[^}]*display: inline-flex;[^}]*height: 28px;[^}]*padding: 2px;/s,
    )
  })

  it('lays Models out as open sections on the shared rows, without cards', () => {
    // Every source is a settings section; the cards, their headers and the
    // 52px switch rows are gone.
    expect(settingsCss).not.toMatch(
      /\.model-settings \{|\.model-visibility \{|model-visibility__(source|models|search|empty)|model-settings__empty/,
    )
    expect(settingsSource).not.toContain('function SettingsPanel')
    expect(settingsCss).toMatch(/\.settings \.model-settings__sources \{[^}]*margin-top: 36px;/s)
    // The source heading keeps the heading's line height, so no descender is clipped.
    expect(settingsCss).toMatch(
      /\.settings \.set-section__title \.source-identity \{[^}]*line-height: inherit;/s,
    )
    expect(settingsCss).toMatch(
      /\.settings \.model-settings \.set-section__head \{[^}]*align-items: center;/s,
    )
    // A model left out of the picker is a muted row whose name steps down.
    expect(settingsCss).toMatch(
      /\.settings \.model-visibility__model\[data-tone='muted'\]:not\(:hover, :focus-within\) \.set-row__name \{[^}]*color: var\(--text-3\);/s,
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
    expect(accountEmailSource).toContain('<IconMorph active={revealed ? 1 : 0}>')
    expect(accountEmailSource).toContain('className="settings__email-eye--show"')
    expect(accountEmailSource).toContain('className="settings__email-eye--hide"')
  })

  it('keeps a single provider action at the far edge on wide and narrow rows', () => {
    expect(settingsCss).toMatch(
      /\.provider-row__primary:empty,\s*\.provider-row__secondary:empty \{[^}]*display: none;/s,
    )
    // Slots space themselves, so the empty action column collapses to nothing.
    expect(settingsCss).toMatch(/\.settings \.provider-row \{[^}]*gap: 0;/s)
    expect(settingsCss).toMatch(
      /\.provider-row__secondary \{[^}]*grid-column: 5;[^}]*\}\s*\.provider-row__primary \{[^}]*grid-column: 6;/s,
    )
    // The roster goes narrow where every settings leader steps aside.
    expect(settingsCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.provider-row__status \{[^}]*grid-column: 2;[^}]*grid-row: 2;[\s\S]*?\.provider-row__secondary \{[^}]*grid-column: 3;[^}]*\}\s*\.provider-row__primary \{[^}]*grid-column: 4;/s,
    )
    expect(settingsCss).not.toMatch(/@container \(max-width/)
    expect(settingsCss).not.toMatch(/settings__group--providers/)
    expect(settingsCss).toMatch(/\.provider-row__status \{[^}]*grid-column: 4;[^}]*min-width: 0;/s)
    expect(settingsCss).toMatch(/\.provider-row \.set-button \{[^}]*min-width: 70px;/s)
    // Only a quiet action bleeds to the edge; a boxed one keeps its border on it.
    expect(settingsCss).toMatch(
      /\.provider-row__secondary:has\(> \.set-button--quiet\):has\(\+ \.provider-row__primary:empty\) \{[^}]*margin-right: -10px;/s,
    )
  })

  it('runs a read-only entity row to the column edge', () => {
    // An empty controls box would keep its 14px margin beside the status.
    expect(systemCss).toMatch(/\.settings \.set-entity__actions:empty \{[^}]*display: none;/s)
  })

  it('wraps page actions inside a narrow column', () => {
    expect(systemCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.settings \.set-page__actions \{[^}]*flex: 0 1 auto;[^}]*flex-wrap: wrap;[^}]*min-width: 0;/s,
    )
  })

  it('draws every settings button from one 28px set', () => {
    expect(systemCss).toMatch(
      /\.settings \.set-button \{[^}]*height: 28px;[^}]*padding: 0 10px;[^}]*border: 1px solid var\(--line-strong\);[^}]*border-radius: var\(--r-md\);[^}]*font-size: var\(--t-sm\);[^}]*font-weight: 500;/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-button--primary \{[^}]*background: var\(--text\);[^}]*color: var\(--bg\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-button--danger:hover:not\(:disabled\) \{[^}]*color: var\(--error\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-button--quiet \{[^}]*border-color: transparent;[^}]*color: var\(--text-3\);/s,
    )
    expect(systemCss).toMatch(/\.settings \.set-button--icon \{[^}]*width: 28px;[^}]*padding: 0;/s)
    // The old per-feature button looks and their alias are gone.
    const alias = /(?<![\w-])settings__action\b/
    expect(settingsCss).not.toMatch(alias)
    expect(systemCss).not.toMatch(alias)
    for (const [file, source] of uiSources()) expect(alias.test(source), file).toBe(false)
  })

  it('draws every form field from one 28px text field', () => {
    expect(systemCss).toMatch(
      /\.settings \.set-input \{[^}]*height: 28px;[^}]*padding: 0 8px;[^}]*border: 1px solid var\(--chrome-border\);[^}]*border-radius: var\(--r-md\);[^}]*font-size: var\(--t-sm\);/s,
    )
    expect(systemCss).toMatch(/\.settings textarea\.set-input \{[^}]*min-height: 72px;/s)
    expect(systemCss).toMatch(
      /\.settings \.set-input:focus \{[^}]*border-color: var\(--text-3\);[^}]*box-shadow: 0 0 0 2px color-mix\(in srgb, var\(--text\) 8%, transparent\);/s,
    )
    // The API form's second, 34px copy of the field rules is gone with the first.
    expect(settingsCss).not.toMatch(/\.provider-form input/)
    expect(settingsCss).not.toMatch(/\.mcp-editor input/)
    expect(systemCss).not.toMatch(/\.mcp-editor (input|textarea)/)
    expect(settingsCss).not.toMatch(/\.avatar-lab__field input/)
  })

  it('draws every settings form as one card of labelled fields', () => {
    expect(systemCss).toMatch(
      /\.settings \.set-form \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*padding: 16px;[^}]*background: var\(--bg-rail\);[^}]*border: 1px solid var\(--line\);[^}]*border-radius: var\(--r-lg\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings :is\(\.set-form label, \.set-form__field\) \{[^}]*display: grid;[^}]*color: var\(--text-2\);[^}]*font-size: var\(--t-sm\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-form__actions \{[^}]*display: flex;[^}]*justify-content: flex-end;/s,
    )
    // One column where the leaders step aside.
    expect(systemCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{\s*\.settings \.set-form \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
    )
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
    // Appearance's font and translucency, Background work's model, effort and speed.
    expect(settingsSource.match(/className="set-select--inline"/g)).toHaveLength(5)
    expect(settingsCss).not.toMatch(/background-model-settings|settings__select/)
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

  it('draws the provider account wire from the link state on the shared leader', () => {
    // Waiting for an account is the settings leader itself, in column 3.
    expect(settingsCss).toMatch(
      /\.settings \.provider-row > \.set-leader \{[^}]*grid-column: 3;[^}]*translate: none;/s,
    )
    expect(settingsCss).not.toMatch(/provider-row::after|--provider-wire/)
    // The solid wire between two terminals is the one provider-only mark.
    expect(settingsCss).toMatch(
      /\.settings \.provider-row\[data-link='connected'\] > \.set-leader \{[^}]*var\(--set-leader\)[^}]*linear-gradient\([^}]*animation: provider-wire-draw/s,
    )
    expect(settingsCss).toMatch(
      /\.settings \.provider-row\[data-link='none'\] > \.set-leader \{[^}]*background: none;/s,
    )
    expect(settingsCss).toMatch(
      /\.settings \.provider-row\[data-live\] > \.set-leader \{[^}]*animation: provider-wire-flow/s,
    )
    expect(settingsCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.settings \.provider-row > \.set-leader \{[^}]*animation: none !important;/s,
    )
    // A failure stays red under the pointer.
    expect(settingsCss.indexOf(".provider-row[data-link='connected']:is(:hover")).toBeLessThan(
      settingsCss.indexOf('.provider-row[data-link][data-fault]'),
    )
  })

  it('sets providers in the entity and sub-row roles', () => {
    expect(systemCss).toMatch(
      /\.settings \.set-entity__name \{[^}]*color: var\(--text-2\);[^}]*font-size: var\(--t-lg\);[^}]*font-weight: 550;[^}]*letter-spacing: -0\.012em;/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-entity__status \{[^}]*color: var\(--text-3\);[^}]*font-size: var\(--t-sm\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-subrow \{[^}]*grid-template-columns: minmax\(0, max-content\) minmax\(24px, 1fr\) minmax\(0, max-content\);[^}]*min-height: 32px;[^}]*font-size: var\(--t-sm\);/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-subrow__name \{[^}]*color: var\(--text-3\);[^}]*font-weight: 400;/s,
    )
    // The provider defaults draw only their trunk and branches.
    expect(tuningCss).not.toMatch(/provider-tune__(label|leader|value)|grid-template-columns/)
    expect(tuningCss).toMatch(/\.provider-tune__row \{[^}]*padding-left: 26px;/s)
    expect(settingsCss).not.toMatch(/\.provider-row \.settings__row-title/)
  })

  it('lists skills on the shared entity rows, without cards', () => {
    expect(systemCss).toMatch(
      /\.settings \.set-entity \{[^}]*grid-template-columns: minmax\(0, 1fr\) max-content;[^}]*padding-block: 10px;/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-entity__head \{[^}]*grid-template-columns: minmax\(0, max-content\) minmax\(32px, 1fr\) minmax\(0, max-content\);[^}]*min-height: 28px;/s,
    )
    expect(systemCss).toMatch(
      /\.settings \.set-entity__detail \{[^}]*color: var\(--text-3\);[^}]*font-size: var\(--t-sm\);/s,
    )
    // The entity rows step aside from their leader where every row does.
    expect(systemCss).toMatch(
      /@container settings-content \(max-width: 560px\) \{[\s\S]*?\.settings \.set-entity__head \{[^}]*grid-template-columns: minmax\(0, max-content\) minmax\(0, 1fr\);/s,
    )
    expect(settingsCss).not.toMatch(/skills-settings|skill-row/)
  })

  it('lists MCP servers on the same rows, with the editor on the shared form', () => {
    // No header, empty card, message box, inherited header or editor grid of its own.
    expect(settingsCss).not.toMatch(
      /mcp-settings__(header|actions|empty|message|scope-note)|mcp-inherited|\.mcp-row(__heading|__actions|__transport|__failure)? \{|\.mcp-editor \{/,
    )
    // Only the tool list under a server is its own.
    expect(settingsCss).toMatch(/\.settings \.mcp-row__details \{[^}]*font-size: var\(--t-sm\);/s)
  })

  it('keeps the shared provider form without an API connections section', () => {
    expect(settingsCss).not.toMatch(/\.provider-roster \+ \.set-section/)
    // The form is the shared one; its old grid, written twice, and the inset heading are gone.
    expect(settingsCss).not.toMatch(
      /\.provider-form \{|provider-form__(field|wide|actions|error)|settings__group-title--inside|provider-settings__(status|actions)/,
    )
    expect(settingsCss.match(/\.provider-form__select \{/g)).toHaveLength(1)
    expect(settingsSource).not.toContain('settings__group-title')
  })

  it('draws the provider updates line from quiet buttons at the note size', () => {
    expect(settingsCss).toMatch(
      /\.settings \.provider-updates-check \{[^}]*margin: 24px 0 0;[^}]*font-size: var\(--t-sm\);/s,
    )
    expect(settingsCss).not.toMatch(/\.provider-updates-check[^{]*\{[^}]*var\(--t-xs\)/s)
  })
})
