import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('sidebar motion CSS', () => {
  it('moves one fixed-width rail in both directions without clipping its contents', () => {
    expect(appCss).toMatch(/\.shell__body \{[^}]*var\(--dur-slow\) var\(--ease-rail\)/s)
    expect(appCss).toMatch(
      /\.rail \{[^}]*position: absolute;[^}]*width: var\(--rail-w\);[^}]*transform: translateX\(0\);[^}]*var\(--dur-slow\) var\(--ease-rail\)/s,
    )
    expect(appCss).toMatch(
      /\.rail-slot\.is-collapsed \.rail \{[^}]*transform: translateX\(-100%\)/s,
    )
  })
})
