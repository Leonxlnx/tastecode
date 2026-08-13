import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('model selector theme CSS', () => {
  it('keeps the sticky model header opaque in light mode', () => {
    expect(tokensCss).toMatch(
      /:root\[data-theme='light'\] \{[^}]*--model-picker-title-bg: var\(--model-picker-bg\);/s,
    )
    expect(appCss).toMatch(
      /\.model-selector__group-head \{[^}]*position: sticky;[^}]*background: var\(--model-picker-title-bg\);/s,
    )
  })
})
