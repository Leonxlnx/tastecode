import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const threadCss = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')

describe('approval action CSS', () => {
  it('sizes all decisions together and gives secondary decisions the same solid treatment', () => {
    const actions = threadCss.match(/\.approval__actions button \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]
    const secondary = threadCss.match(/\.approval__secondary-action \{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.['body']
    expect(actions).toContain('height: 32px')
    expect(actions).toContain('padding: 0 12px')
    expect(secondary).toContain('background: var(--composer-action-bg)')
  })
})
