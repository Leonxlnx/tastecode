import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('sidebar motion CSS', () => {
  it('moves one fixed-width rail in both directions without animating the grid track', () => {
    expect(appCss).toContain('.shell__body {')
    expect(appCss).not.toMatch(/\.shell__body \{[^}]*transition:\s*grid-template-columns/s)
    expect(appCss).toMatch(
      /\.rail \{[^}]*position: absolute;[^}]*width: var\(--rail-w\);[^}]*transform: translateX\(0\);[^}]*var\(--dur-slow\) var\(--ease-rail\)/s,
    )
    expect(appCss).toMatch(
      /\.rail-slot\.is-collapsed \.rail \{[^}]*transform: translateX\(-100%\);[^}]*will-change: transform;/s,
    )
    expect(appCss).toMatch(
      /\.shell\[data-rail-fold-preview\] \.shell__body \{[^}]*grid-template-columns: 0 minmax\(0, 1fr\)/s,
    )
    expect(appCss).toMatch(
      /\.shell\[data-rail-fold-preview\] \.rail \{[^}]*transform: translateX\(-100%\)/s,
    )
  })

  it('keeps the edge reveal on compositor-only properties', () => {
    const revealTransition = appCss.match(
      /\.rail-slot\.is-collapsed\.is-revealed \.rail,\s*\.rail-slot\.is-collapsed\.is-reveal-out \.rail \{([^}]*)\}/s,
    )?.[1]

    expect(revealTransition).toContain('transform var(--dur-reveal) var(--ease-rail)')
    expect(revealTransition).not.toContain('box-shadow')
  })

  it('keeps the hidden narrow rail shadowless until reveal', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 700px\) \{[\s\S]*?\.rail-slot \.rail \{[^}]*width: min\(86vw, 320px\);(?![^}]*box-shadow)/s,
    )
    expect(appCss).toMatch(
      /\.rail-slot\.is-collapsed\.is-revealed \.rail \{[^}]*box-shadow: var\(--shadow-rail\);/s,
    )
  })
})
