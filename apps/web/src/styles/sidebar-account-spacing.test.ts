import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('sidebar account spacing CSS', () => {
  it('uses compact outer and inner padding around the account trigger', () => {
    expect(appCss).toMatch(/\.rail__foot \{[^}]*padding: 6px;/s)
    expect(appCss).toMatch(/\.rail__foot \{[^}]*border-top: 1px solid var\(--line-strong\);/s)
    expect(appCss).toMatch(/\.rail__foot \.menutrigger \{[^}]*padding: 3px 6px;/s)
  })
})
