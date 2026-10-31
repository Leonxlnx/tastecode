import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const popup = readFileSync(new URL('./account-limits.css', import.meta.url), 'utf8')
const usage = readFileSync(new URL('./usage-page.css', import.meta.url), 'utf8')

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = css.match(new RegExp(`(?:^|\\n)${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`))?.groups?.[
    'body'
  ]
  if (body === undefined) throw new Error(`no rule for ${selector}`)
  return body
}

const TRACK = 'background: color-mix(in srgb, var(--text) 9%, transparent)'
const FILL = 'background: color-mix(in srgb, var(--text) 52%, transparent)'

describe('plan-limit bars', () => {
  it('draws the Usage page meters as the popup draws its bars', () => {
    const popupBar = rule(popup, '.account-menu__limit-bar')
    const usageMeter = rule(usage, '.settings .usage-limit__meter')
    expect(popupBar).toContain(TRACK)
    expect(usageMeter).toContain(TRACK)
    expect(popupBar).toContain('border-radius: var(--r-pill)')
    expect(usageMeter).toContain('border-radius: var(--r-pill)')
    expect(rule(popup, '.account-menu__limit-bar > span')).toContain(FILL)
    expect(rule(usage, '.settings .usage-limit__fill')).toContain(FILL)
    // No provider colour and no gradient on a limit: only the charts keep the brand.
    expect(usageMeter).not.toContain('--usage-ink')
    expect(rule(usage, '.settings .usage-limit__fill')).not.toContain('--usage-ink')
    expect(`${popup}\n${usage}`).not.toContain('gradient')
  })

  it('turns only the fill of a nearly spent window the error colour', () => {
    expect(rule(usage, '.settings .usage-limit:is(.is-low, .is-reached) .usage-limit__fill')).toBe(
      '\n  background: var(--error);',
    )
    // The words of a low window stay in their usual ink, as in the popup.
    expect(usage).not.toMatch(/\.usage-limit\.is-(?:low|reached) :is\(/)
    expect(usage).not.toMatch(/is-reached \.usage-limit__meter/)
  })
})
