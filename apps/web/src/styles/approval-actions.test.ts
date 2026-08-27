import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('approval action CSS', () => {
  it('gives secondary decisions the same solid button treatment', () => {
    const secondary = appCss.match(/\.approval__secondary-action \{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.['body']
    expect(secondary).toContain('width: 140px')
    expect(secondary).toContain('min-height: 34px')
    expect(secondary).toContain('background: var(--composer-action-bg)')
  })
})
