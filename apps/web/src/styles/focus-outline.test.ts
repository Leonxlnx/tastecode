import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('focus outline', () => {
  it('does not globally suppress keyboard focus indicators', () => {
    expect(tokensCss).not.toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*(?:none|0)(?:\s*!important)?\s*;/s,
    )
  })

  it('keeps the provider login terminal inside its neutral frame', () => {
    expect(appCss).toMatch(
      /\.install-terminal\s*\{[^}]*box-sizing: border-box;[^}]*overflow: hidden;/s,
    )
    expect(appCss).not.toMatch(/\.install-terminal:focus-within\s*\{/)
  })
})
