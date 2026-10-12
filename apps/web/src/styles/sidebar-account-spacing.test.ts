import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const accountCardCss = readFileSync(new URL('./account-card.css', import.meta.url), 'utf8')

describe('sidebar account spacing CSS', () => {
  it('insets the account card from the rail and keeps room for its gear', () => {
    expect(appCss).toMatch(/\.rail__foot \{[^}]*padding: 4px 8px 8px;/s)
    expect(accountCardCss).toMatch(
      /\.account-card__trigger\.menutrigger \{[^}]*padding: 7px 44px 7px 7px;/s,
    )
    expect(accountCardCss).toMatch(/\.account-card__settings \{[^}]*right: 9px;/s)
  })
})
