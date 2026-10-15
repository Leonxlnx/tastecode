import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const buttonFeedbackCss = readFileSync(new URL('./button-feedback.css', import.meta.url), 'utf8')

describe('hover fade', () => {
  it('gives every button one short colour fade', () => {
    expect(tokensCss).toContain('--dur-hover: 120ms;')
    expect(buttonFeedbackCss).toMatch(
      /@layer button-feedback \{[\s\S]*?transition:\s*color var\(--dur-hover\) var\(--ease-out\),\s*background-color var\(--dur-hover\) var\(--ease-out\),\s*border-color var\(--dur-hover\) var\(--ease-out\),\s*box-shadow var\(--dur-hover\) var\(--ease-out\) !important;/s,
    )
  })

  it('animates colour only, so the fade stays safe under reduced motion', () => {
    const transitions = Array.from(buttonFeedbackCss.matchAll(/transition:([^;]+);/g)).map(
      (match) => match[1] ?? '',
    )

    expect(transitions.length).toBeGreaterThan(0)
    for (const transition of transitions) {
      expect(transition).not.toMatch(
        /\b(transform|rotate|translate|scale|opacity|filter|width|height|all)\b/,
      )
    }
  })

  it('still paints an open menu trigger at once', () => {
    expect(buttonFeedbackCss).toMatch(
      /\[aria-expanded='true'\] \{\s*background: var\(--control-pressed\) !important;\s*transition: none !important;/s,
    )
  })

  it('lets icons follow the label fade without overriding their own motion', () => {
    expect(buttonFeedbackCss).toMatch(
      /:where\(svg\) \{\s*transition: color var\(--dur-hover\) var\(--ease-out\);\s*\}/s,
    )
    expect(buttonFeedbackCss).not.toMatch(/:where\(svg\) \{[^}]*!important/s)
  })
})
