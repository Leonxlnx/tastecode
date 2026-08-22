import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const commandPaletteCss = readFileSync(new URL('./command-palette.css', import.meta.url), 'utf8')
const sessionSearchCss = readFileSync(new URL('./session-search.css', import.meta.url), 'utf8')
const welcomeCss = readFileSync(new URL('./welcome.css', import.meta.url), 'utf8')
const mediaViewerCss = readFileSync(new URL('./media-viewer.css', import.meta.url), 'utf8')
const markdownCss = readFileSync(new URL('./markdown.css', import.meta.url), 'utf8')
const rollbackCss = readFileSync(new URL('./rollback.css', import.meta.url), 'utf8')
const inboxCss = readFileSync(new URL('./inbox-sidebar.css', import.meta.url), 'utf8')
const accountLimitsCss = readFileSync(new URL('./account-limits.css', import.meta.url), 'utf8')
const resourcePickerCss = readFileSync(
  new URL('./composer-resource-picker.css', import.meta.url),
  'utf8',
)
const voiceControlCss = readFileSync(
  new URL('./composer-voice-control.css', import.meta.url),
  'utf8',
)
const modelSelectorCss = readFileSync(new URL('./model-selector.css', import.meta.url), 'utf8')
const modelSelectorMenuCss = readFileSync(
  new URL('./model-selector-menu.css', import.meta.url),
  'utf8',
)
const terminalCss = readFileSync(new URL('./terminal-pane.css', import.meta.url), 'utf8')
const threadCss = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const designInputCss = readFileSync(
  new URL('../design-agent/user-input.css', import.meta.url),
  'utf8',
)
const composerSource = readFileSync(new URL('../ui/Composer.tsx', import.meta.url), 'utf8')

describe('radius system', () => {
  it('keeps the rounded control shape and scales larger containers around it', () => {
    expect(tokensCss).toContain('--r-xs: 2px;')
    expect(tokensCss).toContain('--r-md: 5px;')
    expect(tokensCss).toContain('--r-lg: 8px;')
    expect(tokensCss).toContain('--r-xl: 10px;')
    expect(tokensCss).toContain('--r-card: 12px;')
    expect(tokensCss).toContain('--r-panel: 16px;')
    expect(tokensCss).toContain('--r-dialog: 20px;')
    expect(tokensCss).toContain('--r-2xl: 20px;')
    expect(tokensCss).toContain('--r-popup: var(--r-xl);')
    expect(tokensCss).toContain('--r-popup-item: var(--r-lg);')

    expect(appCss).toMatch(/\.rail__search \{[^}]*border-radius: var\(--r-md\)/s)
    expect(sessionSearchCss).toMatch(
      /\.session-search__filters \.app-select__trigger \{[^}]*border-radius: var\(--r-md\)/s,
    )
    expect(sessionSearchCss).toMatch(
      /\.session-search__panel \{[^}]*width: min\(520px, 100%\);[^}]*border-radius: var\(--r-xl\)/s,
    )
    expect(inboxCss).toMatch(/\.inbox-card \{[^}]*border-radius: var\(--r-card\)/s)
    expect(commandPaletteCss).toMatch(
      /\.command-palette__panel \{[^}]*border-radius: var\(--r-dialog\)/s,
    )
    expect(appCss).toMatch(/\.composer__box \{[^}]*border-radius: var\(--r-2xl\)/s)
  })

  it('keeps floating surfaces and their interactive rows on one nested radius system', () => {
    expect(tokensCss).toContain('--menu-bg: var(--chrome-raised);')
    expect(tokensCss).toContain('--menu-hover: var(--chrome-raised-hover);')
    expect(appCss).toMatch(/\.menu \{[^}]*padding: 4px;[^}]*border-radius: var\(--r-popup\);/s)
    expect(appCss).toMatch(
      /\.menu__item \{[^}]*border: 1px solid transparent;[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(commandPaletteCss).toMatch(
      /\.command-palette__item \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(sessionSearchCss).toMatch(
      /\.session-search__result \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(rollbackCss).toMatch(
      /\.rollback__checkpoint \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(modelSelectorCss).toMatch(
      /\.model-selector__menu \{[^}]*border-radius: var\(--r-popup\);/s,
    )
    expect(modelSelectorMenuCss).toMatch(
      /\.model-selector__model \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(designInputCss).toMatch(
      /\.brief-input__option \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(appCss).not.toMatch(/\.menu--settings \.menu__item \{[^}]*border-radius:/s)
  })

  it('reserves state borders so selection does not change row geometry', () => {
    expect(settingsCss).toMatch(
      /\.settings__nav-item \{[^}]*border: 1px solid transparent;[^}]*border-radius: var\(--r-xl\);/s,
    )
    expect(settingsCss.match(/\.settings__nav-item\.is-active \{([^}]*)\}/s)?.[1]).not.toContain(
      'border-radius',
    )
    expect(commandPaletteCss).toMatch(
      /\.command-palette__item \{[^}]*border: 1px solid transparent;/s,
    )
    expect(sessionSearchCss).toMatch(
      /\.session-search__result \{[^}]*border: 1px solid transparent;/s,
    )
  })

  it('keeps component radii tokenized and lets border beams follow computed corners', () => {
    const componentCss = `${appCss}\n${settingsCss}\n${commandPaletteCss}\n${sessionSearchCss}\n${welcomeCss}\n${mediaViewerCss}\n${markdownCss}\n${rollbackCss}\n${inboxCss}\n${accountLimitsCss}\n${resourcePickerCss}\n${voiceControlCss}\n${modelSelectorCss}\n${modelSelectorMenuCss}\n${terminalCss}\n${threadCss}\n${designInputCss}`
    expect(componentCss).not.toMatch(/border-radius:\s*(?:\d+(?:\.\d+)?px|50%)/)
    expect(composerSource).not.toMatch(/borderRadius=\{/)
  })

  it('does not pass gradient surface tokens into color-mix', () => {
    expect(appCss).not.toMatch(
      /color-mix\([^;\n]*var\(--(?:bg-rail|chrome-raised|chrome-raised-hover|menu-bg|menu-hover)\)/,
    )
  })
})
