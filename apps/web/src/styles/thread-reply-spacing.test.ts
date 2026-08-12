import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('thread reply spacing', () => {
  it('keeps assistant prose compact without shrinking prompts or code', () => {
    const thread = css.match(/\.thread \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const reply = css.match(/\.reply \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const proseSpacing = css.match(
      /\.reply > \.md p,\n\.reply > \.md ul,\n\.reply > \.md ol \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body']
    const listItem = css.match(/\.reply > \.md li \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const code = css.match(/\.md pre \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']

    expect(thread).toContain('font-size: var(--t-lg)')
    expect(reply).toContain('font-size: var(--t-md)')
    expect(reply).toContain('line-height: 1.45')
    expect(proseSpacing).toContain('margin-bottom: 6px')
    expect(listItem).toContain('margin-block: 0')
    expect(code).toContain('font-size: var(--t-sm)')
  })

  it('overlays response actions without reserving an empty row below every reply', () => {
    const reply = css.match(/\.reply \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const actions = css.match(/\.reply > \.response-actions \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]
    const activeRow = css.match(
      /\.thread__row:has\(> \.reply:hover\),\n\.thread__row:has\(> \.reply:focus-within\) \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body']

    expect(reply).not.toContain('padding-bottom')
    expect(actions).toContain('top: 100%')
    expect(actions).toContain('padding-top: 3px')
    expect(actions).toContain('margin: 0')
    expect(actions).not.toContain('bottom: 0')
    expect(activeRow).toContain('padding-bottom: 31px')
  })
})
