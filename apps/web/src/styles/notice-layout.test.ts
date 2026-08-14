import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('global notices', () => {
  it('keeps errors in a compact bottom-right toast without an accent rail', () => {
    const notice = css.match(/\.notice \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''

    expect(notice).toContain('bottom: 18px')
    expect(notice).toContain('right: 18px')
    expect(notice).toContain('max-width: min(420px, calc(100vw - 36px))')
    expect(notice).not.toContain('left:')
    expect(notice).not.toContain('transform:')
    expect(notice).not.toContain('border-left:')
    expect(notice).not.toContain('box-shadow: inset')
  })
})
