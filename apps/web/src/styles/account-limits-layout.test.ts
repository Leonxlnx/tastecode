import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./account-limits.css', import.meta.url), 'utf8')

function rule(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`(?:^|\\n)${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`))?.groups?.['body']
}

describe('account limits layout', () => {
  it('sets the limits in one soft scrolling well instead of ruled sections', () => {
    const usage = rule('.account-menu__usage')
    expect(usage).toContain('gap: 14px')
    expect(usage).toContain('font-size: var(--t-xs)')
    expect(usage).toContain('border-radius: var(--r-lg)')
    expect(usage).toContain('background: color-mix(in srgb, var(--text) 4%, var(--menu-bg))')
    // No height of its own: a fixed cap made the well scroll with the window
    // nowhere near full once a provider listed several accounts. The popup's
    // viewport bound and the well's flex shrink are what limit it.
    expect(usage).not.toContain('max-height')
    expect(usage).toContain('flex: 0 1 auto')
    expect(usage).toContain('overflow-y: auto')
    expect(usage).toContain('overscroll-behavior: contain')
    expect(usage).toContain('min-height: 0')
    expect(rule('.account-menu__usage:focus-visible')).toContain('outline: var(--focus-ring)')
    // No hard rules between providers or under the list.
    expect(css).not.toMatch(/border-(?:top|bottom): 1px solid/)
    expect(css).not.toContain('.account-menu__source + .account-menu__source')
    expect(css).not.toContain('.account-menu__usage-head')
    expect(css).not.toContain('.account-menu__usage-reveal')
  })

  it('keeps a failed source calm: a muted status and a text Retry, no alert colour', () => {
    expect(css).not.toContain('.account-menu__usage-error')
    const status = rule('.account-menu__source-status')
    expect(status).toContain('color: var(--text-3)')
    expect(status).toContain('text-overflow: ellipsis')
    const retry = rule('.account-menu__retry')
    expect(retry).toContain('background: none')
    expect(retry).toContain('border: 0')
    expect(retry).toContain('color: var(--text-2)')
    expect(retry).not.toContain('--error')
    expect(status).not.toContain('--error')
    expect(css).toMatch(
      /\.account-menu__retry:focus-visible,\s*\.account-menu__limit-btn:focus-visible \{\s*outline: var\(--focus-ring\);\s*outline-offset: var\(--focus-ring-offset\);/s,
    )
  })

  it('draws each bar as one quiet fill, red only when nearly spent, with the number in text ink', () => {
    expect(rule('.account-menu__source')).toContain('gap: 8px')
    expect(rule('.account-menu__limit')).toContain('gap: 5px')
    const bar = rule('.account-menu__limit-bar')
    expect(bar).toContain('height: 6px')
    expect(bar).toContain('border-radius: var(--r-pill)')
    const fill = rule('.account-menu__limit-bar > span')
    // A red-to-green gradient read as noise; the fill matches the card's meter.
    expect(css).not.toContain('gradient')
    expect(fill).toContain('background: color-mix(in srgb, var(--text) 52%, transparent)')
    expect(rule('.account-menu__account-gauge > span')).toContain(
      'background: color-mix(in srgb, var(--text) 52%, transparent)',
    )
    expect(css).toMatch(
      /\.account-menu__limit\[data-low\] \.account-menu__limit-bar > span:not\(\.account-menu__limit-pace\),\s*\.account-menu__account-gauge\[data-low\] > span \{\s*background: var\(--error\);/,
    )
    expect(fill).toContain('clip-path: inset(0 calc((1 - var(--limit-fill)) * 100%) 0 0')
    expect(rule('.account-menu__limit[data-gauge]')).toContain('--limit-fill: var(--left)')
    expect(rule('.account-menu__limit-value')).toContain('color: var(--text)')
    expect(css).not.toContain('[data-gauge] .account-menu__limit-value')
    expect(css).toMatch(/@property --limit-fill \{[^}]*syntax: '<number>';/s)
    // Neither the colour nor the fill motion is a hard-coded value.
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('fills the gauges once when the popup opens, and not at all with reduced motion', () => {
    const gauge = rule('.account-menu__limit[data-gauge]')
    expect(gauge).toContain('animation: account-limit-fill')
    expect(gauge).toContain('animation-delay: calc(80ms + var(--order) * 70ms)')
    expect(css).toMatch(/@keyframes account-limit-fill \{\s*from \{\s*--limit-fill: 0;/)
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.account-menu__limit\[data-gauge\] \{\s*animation: none;\s*transition: none;/,
    )
    // The even-pace mark is a neutral hairline, never a second bar or an alert.
    const pace = rule('.account-menu__limit-bar > .account-menu__limit-pace')
    expect(pace).toContain('width: 1px')
    expect(pace).toContain('pointer-events: none')
    expect(pace).not.toContain('--error')
    expect(pace).toContain('clip-path: none')
  })
})
