import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('removed Codex theme', () => {
  it('has no theme tokens, sidebar overrides, or preview styling', () => {
    expect(tokensCss).not.toContain("data-theme='codex'")
    expect(appCss).not.toContain("data-theme='codex'")
    expect(settingsCss).not.toContain('.theme-preview--codex')
  })

  it('preserves the original card size for the three remaining theme options', () => {
    expect(settingsCss).toMatch(
      /\.theme-picker \{[^}]*grid-template-columns: repeat\(3, minmax\(0, calc\(\(100% - 48px\) \/ 4\)\)\);[^}]*justify-content: center;/s,
    )
  })
})
