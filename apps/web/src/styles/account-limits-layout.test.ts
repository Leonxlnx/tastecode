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
    expect(usage).toContain('max-height: min(360px, calc(100vh - 150px))')
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

  it('draws quiet bars that only turn red when an allowance runs low', () => {
    expect(rule('.account-menu__source')).toContain('gap: 8px')
    expect(rule('.account-menu__limit')).toContain('gap: 5px')
    const bar = rule('.account-menu__limit-bar')
    expect(bar).toContain('height: 4px')
    expect(bar).toContain('border-radius: var(--r-pill)')
    expect(rule('.account-menu__limit-bar > span')).toContain(
      'background: color-mix(in srgb, var(--text) 52%, transparent)',
    )
    expect(rule('.account-menu__limit-bar > span[data-low]')).toContain('background: var(--error)')
  })
})
