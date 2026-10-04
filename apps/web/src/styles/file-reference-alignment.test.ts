import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./markdown.css', import.meta.url), 'utf8')

describe('inline file references', () => {
  it('centers file icons and monograms on the prose line', () => {
    const icon = css.match(/\.md \.md-file-ref__icon \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? ''

    expect(icon).toContain('vertical-align: middle')
  })
})
