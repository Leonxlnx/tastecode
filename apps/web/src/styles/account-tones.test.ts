import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ACCOUNT_TONES } from '../provider-accounts-state.js'

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const badge = readFileSync(new URL('./account-badge.css', import.meta.url), 'utf8')
const menu = readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8')
const tones = Array.from({ length: ACCOUNT_TONES }, (_, place) => place + 1)

describe('account tones', () => {
  it('defines every tone for the dark and the light theme, each its own colour', () => {
    for (const tone of tones) {
      expect(tokens.match(new RegExp(`--account-${tone}: #`, 'g'))).toHaveLength(2)
    }
    const colours = [...tokens.matchAll(/--account-\d: (#[0-9a-f]{6});/g)].map((match) => match[1])
    expect(new Set(colours).size).toBe(ACCOUNT_TONES * 2)
  })

  it('maps every tone the app hands out to its token', () => {
    for (const tone of tones) {
      expect(badge).toContain(
        `[data-account-tone='${tone}'] {\n  --account-tone: var(--account-${tone});\n}`,
      )
    }
  })

  it("leaves a rail heading without an account as it was, with a long name's ellipsis", () => {
    expect(menu).toContain('.model-selector__group-head:has(.account-badge) .source-identity {')
    expect(menu).not.toContain('\n.model-selector__group-head .source-identity {')
  })

  it('keeps colour to a tint behind the label, whose text stays readable', () => {
    expect(badge).toContain('color: var(--text);')
    expect(badge).toContain('var(--account-tone, var(--text-3)) 15%')
  })
})
