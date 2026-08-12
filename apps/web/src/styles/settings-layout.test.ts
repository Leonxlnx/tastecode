import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('settings viewport CSS', () => {
  it('keeps both panes scrollable inside short windows', () => {
    expect(appCss).toMatch(/\.settings__sidebar \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
    expect(appCss).toMatch(/\.settings__main \{[^}]*min-height: 0;[^}]*overflow-y: auto;/s)
  })

  it('keeps narrow categories on the horizontal axis', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 700px\) \{[\s\S]*?\.settings__nav \{[^}]*overflow-x: auto;/s,
    )
  })

  it('bounds state and action controls to the narrow row width', () => {
    expect(appCss).toMatch(
      /\.settings__row-control:has\(> \.state-label\) \{[^}]*max-width: 100%;/s,
    )
  })
})
