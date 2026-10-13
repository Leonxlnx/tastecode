import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const accountCardCss = readFileSync(new URL('./account-card.css', import.meta.url), 'utf8')
const focusRingCss = readFileSync(new URL('./focus-ring.css', import.meta.url), 'utf8')
const modelSelectorMenuCss = readFileSync(
  new URL('./model-selector-menu.css', import.meta.url),
  'utf8',
)

function collectCss(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectCss(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}

const allCss = collectCss(fileURLToPath(new URL('../', import.meta.url)))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')

describe('focus outline', () => {
  it('does not globally suppress keyboard focus indicators', () => {
    expect(tokensCss).not.toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*(?:none|0)(?:\s*!important)?\s*;/s,
    )
  })

  it('defines one focus ring token for both themes', () => {
    expect(tokensCss).toContain(
      '--focus-ring-color: color-mix(in srgb, var(--text) 60%, transparent);',
    )
    expect(tokensCss).toContain('--focus-ring: 2px solid var(--focus-ring-color);')
    expect(tokensCss).toContain('--focus-ring-offset: 2px;')
    expect(tokensCss).toContain('--focus-ring-inset: -2px;')
  })

  it('replaces the browser default ring everywhere through a weak layer', () => {
    expect(appCss).toContain("@import './focus-ring.css';")
    expect(focusRingCss).toMatch(
      /@layer focus-ring \{\s*:focus-visible \{\s*outline: var\(--focus-ring\);\s*outline-offset: var\(--focus-ring-offset\);/s,
    )
    expect(focusRingCss).toMatch(
      /\.navitem,[\s\S]*?\.sess,[\s\S]*?\.rail__foot \.menutrigger,[\s\S]*?\):focus-visible \{\s*outline-offset: var\(--focus-ring-inset\);/s,
    )
  })

  it('draws rows in menus, the model picker and settings with the same ring', () => {
    expect(appCss).toMatch(
      /\.menu__item:not\(:disabled\):focus-visible \{[^}]*outline: var\(--focus-ring\);[^}]*outline-offset: var\(--focus-ring-inset\);/s,
    )
    expect(modelSelectorMenuCss).toMatch(
      /\.model-selector__model:focus-visible \{[^}]*outline: var\(--focus-ring\);[^}]*outline-offset: var\(--focus-ring-inset\);/s,
    )
    expect(settingsCss).toMatch(
      /\.settings__nav-item:focus-visible \{[^}]*outline: var\(--focus-ring\);[^}]*outline-offset: var\(--focus-ring-inset\);/s,
    )
  })

  it('rings the effort pill with the shared token on keyboard focus', () => {
    expect(modelSelectorMenuCss).toMatch(
      /\.model-selector__slider:focus-visible:not\(\[data-focus-source='pointer'\]\) \{\s*outline: var\(--focus-ring\);\s*outline-offset: var\(--focus-ring-offset\);/s,
    )
  })

  it('rings the account card and its gear with the shared token', () => {
    // The card sits in the rail foot with room around it, so its ring draws
    // outside like any standalone control, in the same colour as every other.
    expect(accountCardCss).toMatch(
      /\.account-card__trigger:focus-visible,\s*\.account-card__settings:focus-visible \{\s*outline: var\(--focus-ring\);\s*outline-offset: var\(--focus-ring-offset\);/s,
    )
  })

  it('keeps the old thin and grey ring variants out of component CSS', () => {
    expect(allCss).not.toMatch(/outline: 1(?:\.5)?px solid var\(--text-[23]\)/)
    expect(allCss).not.toMatch(/outline: 1\.5px solid color-mix\(in srgb, var\(--text\) 34%/)
  })

  it('keeps the provider login terminal inside its neutral frame', () => {
    expect(settingsCss).toMatch(
      /\.install-terminal\s*\{[^}]*box-sizing: border-box;[^}]*overflow: hidden;/s,
    )
    expect(settingsCss).not.toMatch(/\.install-terminal:focus-within\s*\{/)
  })
})
