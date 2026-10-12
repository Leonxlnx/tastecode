import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('sidebar account spacing CSS', () => {
  it('pads the profile pill on the rail column with no rule above it', () => {
    expect(appCss).toMatch(/\.rail__foot \{[^}]*padding: 4px 10px 8px 8px;/s)
    expect(appCss).not.toMatch(/\.rail__foot \{[^}]*border-top/s)
    expect(appCss).toMatch(/\.rail__foot \.menutrigger \{[^}]*padding: 0;/s)
    expect(appCss).toMatch(/\.account \{[^}]*min-height: 40px;[^}]*padding: 5px 8px;/s)
  })
})
