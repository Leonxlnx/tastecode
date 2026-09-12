import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceDirectory = fileURLToPath(new URL('../', import.meta.url))
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const commandPaletteCss = readFileSync(new URL('./command-palette.css', import.meta.url), 'utf8')
const sessionSearchCss = readFileSync(new URL('./session-search.css', import.meta.url), 'utf8')
const rollbackCss = readFileSync(new URL('./rollback.css', import.meta.url), 'utf8')
const inboxCss = readFileSync(new URL('./inbox-sidebar.css', import.meta.url), 'utf8')
const resourcePickerCss = readFileSync(
  new URL('./composer-resource-picker.css', import.meta.url),
  'utf8',
)
const modelSelectorCss = readFileSync(new URL('./model-selector.css', import.meta.url), 'utf8')
const modelSelectorMenuCss = readFileSync(
  new URL('./model-selector-menu.css', import.meta.url),
  'utf8',
)
const designBeamCss = readFileSync(new URL('./design-beam.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const designInputCss = readFileSync(
  new URL('../design-agent/user-input.css', import.meta.url),
  'utf8',
)
const pullRequestsCss = readFileSync(
  new URL('../ui/pull-requests/pull-requests.css', import.meta.url),
  'utf8',
)
const workspaceCss = readFileSync(new URL('../ui/workspace-panel.css', import.meta.url), 'utf8')

function collectFiles(directory: string, extension: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectFiles(path, extension)
    return entry.name.endsWith(extension) ? [path] : []
  })
}

const componentCss = collectFiles(sourceDirectory, '.css')
  .filter((path) => !path.endsWith('/styles/tokens.css'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
const componentSources = collectFiles(sourceDirectory, '.tsx')
  .filter((path) => !path.includes('.test.') && !path.includes('.bench.'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')

describe('radius system', () => {
  it('uses compact corners while keeping 32px composer controls', () => {
    expect(tokensCss).toContain('--r-xs: 2px;')
    expect(tokensCss).toContain('--r-sm: 3px;')
    expect(tokensCss).toContain('--r-md: 5px;')
    expect(tokensCss).toContain('--r-lg: 8px;')
    expect(tokensCss).toContain('--r-xl: 10px;')
    expect(tokensCss).toContain('--r-card: 12px;')
    expect(tokensCss).toContain('--r-panel: 16px;')
    expect(tokensCss).toContain('--r-dialog: 20px;')
    expect(tokensCss).toContain('--r-2xl: 20px;')
    expect(tokensCss).toContain('--r-popup-item: var(--r-md);')
    expect(tokensCss).toContain('--r-popup: var(--r-lg);')

    expect(appCss).toMatch(/\.rail__search \{[^}]*height: 26px;[^}]*border-radius: var\(--r-md\)/s)
    expect(appCss).toMatch(/\.navitem \{[^}]*border-radius: var\(--r-md\);[^}]*min-height: 26px;/s)
    expect(sessionSearchCss).toMatch(
      /\.session-search__filters \.app-select__trigger \{[^}]*border-radius: var\(--r-md\)/s,
    )
    expect(sessionSearchCss).toMatch(
      /\.session-search__panel \{[^}]*width: min\(520px, 100%\);[^}]*border-radius: var\(--r-lg\)/s,
    )
    expect(inboxCss).toMatch(/\.inbox-card \{[^}]*border-radius: var\(--r-lg\)/s)
    expect(commandPaletteCss).toMatch(
      /\.command-palette__panel \{[^}]*border-radius: var\(--r-lg\)/s,
    )
    expect(appCss).toMatch(/\.composer__box \{[^}]*border-radius: var\(--r-card\)/s)
    expect(appCss).toMatch(
      /\.tools \.composer__add \{[^}]*height: 32px;[^}]*border-radius: var\(--r-md\)/s,
    )
    expect(appCss).toMatch(/\.icon-btn\.titlebar__toggle \{[^}]*border-radius: var\(--r-md\);/s)
    expect(appCss).toMatch(/\.stage \{[^}]*border-top-left-radius: var\(--r-lg\)/s)
    expect(appCss).toMatch(/\.rail__resize::before \{[^}]*border-top-left-radius: var\(--r-lg\)/s)
    expect(designBeamCss).toMatch(
      /\.composer__design-beam \{[^}]*--design-beam-radius: var\(--r-card\);[^}]*--design-beam-inner-radius: calc\(var\(--r-card\) - 1px\);/s,
    )
  })

  it('keeps floating surfaces and their interactive rows on one nested radius system', () => {
    expect(tokensCss).toContain('--menu-bg: var(--surface);')
    expect(tokensCss).toContain('--menu-hover: var(--surface-3);')
    expect(appCss).toMatch(/\.menu \{[^}]*padding: 3px;[^}]*border-radius: var\(--r-popup\);/s)
    expect(appCss).toMatch(
      /\.menu--compact \{[^}]*padding: 3px;[^}]*border-radius: var\(--r-lg\);/s,
    )
    expect(appCss).toMatch(
      /\.app-select__listbox \{[^}]*--r-popup: var\(--r-lg\);[^}]*border-radius: var\(--r-popup\);/s,
    )
    expect(appCss).toMatch(/\.app-select__option \{[^}]*border-radius: var\(--r-popup-item\);/s)
    expect(appCss).toMatch(
      /\.menu__item \{[^}]*border: 1px solid transparent;[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(commandPaletteCss).toMatch(
      /\.command-palette__item \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(commandPaletteCss).toMatch(/\.command-palette__results \{[^}]*padding: 3px;/s)
    expect(sessionSearchCss).toMatch(
      /\.session-search__result \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(sessionSearchCss).toMatch(/\.session-search__results \{[^}]*padding: 3px;/s)
    expect(rollbackCss).toMatch(
      /\.rollback__checkpoint \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(rollbackCss).toMatch(/\.rollback__list \{[^}]*padding: 3px;/s)
    expect(modelSelectorCss).toMatch(
      /\.model-selector__menu \{[^}]*--r-popup-item: var\(--r-md\);[^}]*--r-popup: var\(--r-lg\);[^}]*border-radius: var\(--r-popup\);/s,
    )
    expect(modelSelectorMenuCss).toMatch(
      /\.model-selector__model \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(designInputCss).toMatch(
      /\.brief-input__option \{[^}]*min-height: 32px;[^}]*border-radius: var\(--r-md\);/s,
    )
    expect(resourcePickerCss).toMatch(
      /\.composer-resource-picker \{[^}]*border-radius: var\(--r-popup\);/s,
    )
    expect(resourcePickerCss).toMatch(
      /\.composer-resource-picker__option \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(pullRequestsCss).toMatch(
      /\.pr-metadata-menu \{[^}]*--r-popup: var\(--r-lg\);[^}]*border-radius: var\(--r-popup\);/s,
    )
    expect(pullRequestsCss).toMatch(
      /\.pr-picker-option \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(workspaceCss).toMatch(
      /\.workspace-panel__add-menu \{[^}]*border-radius: var\(--r-popup\);/s,
    )
    expect(workspaceCss).toMatch(
      /\.workspace-panel__add-menu button \{[^}]*border-radius: var\(--r-popup-item\);/s,
    )
    expect(appCss).toMatch(
      /\.menu--compact \.menu__item \{[^}]*padding: 4px 7px;[^}]*border-radius: var\(--r-md\);/s,
    )
    expect(appCss).toMatch(
      /\.menu__item:not\(:disabled\):focus-visible \{[^}]*border-color: var\(--text-2\);/s,
    )
    expect(appCss).toMatch(
      /\.menu--project-picker \.menu__label > span \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s,
    )
  })

  it('reserves state borders so selection does not change row geometry', () => {
    expect(settingsCss).toMatch(
      /\.settings__nav-item \{[^}]*border: 1px solid transparent;[^}]*border-radius: var\(--r-md\);/s,
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

  it('keeps every component shorthand and corner longhand tokenized', () => {
    expect(componentCss).not.toMatch(
      /border(?:-(?:top|bottom)-(?:left|right))?-radius:\s*(?:\d+(?:\.\d+)?px|50%)/,
    )
    expect(componentSources).not.toMatch(
      /(?:borderRadius|border(?:Top|Bottom)(?:Left|Right)Radius)\s*[:=]\s*[{"']?(?:\d|50%)/,
    )
  })

  it('does not pass gradient surface tokens into color-mix', () => {
    expect(appCss).not.toMatch(
      /color-mix\([^;\n]*var\(--(?:bg-rail|chrome-raised|chrome-raised-hover|menu-bg|menu-hover)\)/,
    )
  })
})
