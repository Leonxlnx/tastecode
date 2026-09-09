import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('Codex theme CSS', () => {
  it('uses the requested exact base colors', () => {
    const codexTokens = tokensCss.match(/:root\[data-theme='codex'\] \{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.['body']

    expect(codexTokens).toContain('--bg: #2d2d2b;')
    expect(codexTokens).toContain('--bg-rail: #353533;')
    expect(codexTokens).toContain('--text: #dededc;')
    expect(codexTokens).toContain('--text-2: #a8a8a5;')
    expect(codexTokens).toContain('--text-3: #7c7c78;')
    expect(codexTokens).toContain('--bg-shelf: #40403d;')
    expect(codexTokens).toContain('--line: #4a4a47;')
    expect(codexTokens).toContain('--composer-placeholder: #a0a09c;')
    expect(codexTokens).toContain('--titlebar-symbol: #dededc;')
  })

  it('keeps the exact sidebar color when glass is enabled', () => {
    expect(tokensCss).toMatch(
      /:root\[data-theme='codex'\] \{[^}]*--bg-rail-tint: #353533;[^}]*--rail-glass-fade: 0%;/s,
    )
    expect(appCss).toMatch(/:root\[data-theme='codex'\] \.rail \{[^}]*--rail-text: #dededc;/s)
  })

  it('shows all three Codex colors in the Appearance preview', () => {
    expect(settingsCss).toMatch(/\.theme-preview--codex \{[^}]*#353533[^}]*#2d2d2b[^}]*#dededc/s)
  })
})
