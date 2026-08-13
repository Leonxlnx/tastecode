import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('account limits layout', () => {
  it('visibly separates adjacent provider sources', () => {
    const separator = css.match(
      /\.account-menu__source \+ \.account-menu__source \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body']

    expect(separator).toContain('border-top: 1px solid var(--line-strong)')
    expect(separator).toContain('padding-top: 10px')
  })
})
