import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./markdown.css', import.meta.url), 'utf8')

describe('chat reply line breaks', () => {
  it('shows single line breaks only in chat replies', () => {
    const prose = css.match(
      /^:is\(\.reply, \.activity__message\) > \.md :is\(p, li, blockquote\) \{(?<body>[\s\S]*?)\n\}/m,
    )?.groups?.['body']
    const inlineCode = css.match(
      /^:is\(\.reply, \.activity__message\) > \.md :not\(pre\) > code \{(?<body>[\s\S]*?)\n\}/m,
    )?.groups?.['body']

    expect(prose).toContain('white-space: pre-line')
    expect(inlineCode).toContain('white-space: normal')
    expect(css.match(/white-space: pre-line/g)).toHaveLength(1)
  })
})
