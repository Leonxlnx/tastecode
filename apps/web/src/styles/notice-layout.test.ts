import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('global notices', () => {
  it('keeps errors in a compact bottom-right toast without an accent rail', () => {
    const notice = css.match(/\.notice \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''

    expect(notice).toContain('bottom: var(--notice-bottom, 18px)')
    expect(notice).toContain('right: var(--notice-right, 18px)')
    expect(notice).toContain('max-width: min(420px, calc(100vw - 36px))')
    expect(notice).toContain('transform: translateY(0) scale(1)')
    expect(notice).not.toContain('left:')
    expect(notice).not.toContain('border-left:')
    expect(notice).not.toContain('box-shadow: inset')
  })

  it('keeps the narrow-window corner overridable by a docked composer', () => {
    const narrow = css.match(
      /@media \(max-width: 700px\) \{\n {2}\.notice \{(?<body>[\s\S]*?)\n {2}\}/,
    )?.groups?.body
    expect(narrow).toContain('right: var(--notice-right, 12px)')
    expect(narrow).toContain('bottom: var(--notice-bottom, 12px)')
  })
})
