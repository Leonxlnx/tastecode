import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('account limits layout', () => {
  it('gives the limits section a full spacing rhythm', () => {
    const usage = css.match(
      /\.account-menu__usage \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body']
    const separator = css.match(
      /\.account-menu__source \+ \.account-menu__source \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body']

    expect(usage).toContain('gap: 0')
    expect(usage).toContain('padding: 14px 12px 16px')
    expect(usage).toContain('overscroll-behavior: contain')
    expect(separator).toContain('border-top: 1px solid var(--line-strong)')
    expect(separator).toContain('margin-top: 14px')
    expect(separator).toContain('padding-top: 14px')
    expect(css).toMatch(/\.account-menu__source \{[^}]*gap: 10px;/s)
    expect(css).toMatch(/\.account-menu__limit \{[^}]*gap: 6px;/s)
    expect(css).toMatch(/\.account-menu__limit-bar \{[^}]*height: 5px;/s)
  })
})
