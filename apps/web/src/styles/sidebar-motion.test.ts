import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const railMotionCss = readFileSync(new URL('./rail-motion.css', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../ui/Sidebar.tsx', import.meta.url), 'utf8')

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

  it('opens and closes a project drawer in one motion, without a first-frame snap', () => {
    // Height and fade share one clock.
    expect(appCss).toMatch(
      /\.proj__drawer \{[^}]*grid-template-rows var\(--dur-slow\) var\(--ease-out\),\s*opacity var\(--dur-slow\) var\(--ease-out\);/s,
    )
    // The list margins a closed drawer drops move with it, from zero on a list
    // that mounts with the open.
    expect(railMotionCss).toMatch(
      /\.proj__drawer > \.proj__sessions \{\s*transition: margin-block var\(--dur-slow\) var\(--ease-out\);\s*\}/,
    )
    expect(railMotionCss).toMatch(
      /@starting-style \{\s*\.proj__drawer\[data-open='true'\] > \.proj__sessions \{\s*margin-block: 0;/,
    )
    expect(sidebarSource).toContain("import '../styles/rail-motion.css'")
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
