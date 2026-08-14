import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('thread reply spacing', () => {
  it('keeps assistant prose compact without shrinking prompts or code', () => {
    const thread = css.match(/\.thread \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const reply = css.match(/\.reply \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const responseMarkdown = css.match(/\.reply > \.md \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const proseLeading = css.match(
      /\.reply > \.md :is\(p, ul, ol, blockquote\) \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body']
    const codeLeading = css.match(/\.reply > \.md pre \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const proseSpacing = css.match(
      /\.reply > \.md p,\n\.reply > \.md ul,\n\.reply > \.md ol \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body']
    const listItem = css.match(/\.reply > \.md li \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const code = css.match(/^\.md pre \{(?<body>[\s\S]*?)\n\}/m)?.groups?.['body']

    expect(thread).toContain('font-size: var(--t-lg)')
    expect(reply).not.toContain('font-size')
    expect(reply).not.toContain('line-height')
    expect(responseMarkdown).toContain('font-size: var(--t-md)')
    expect(responseMarkdown).toContain('line-height: 1.52')
    expect(proseLeading).toContain('line-height: 1.45')
    expect(codeLeading).toContain('line-height: 1.52')
    expect(proseSpacing).toContain('margin-bottom: 6px')
    expect(listItem).toContain('margin-block: 0')
    expect(code).toContain('font-size: var(--t-sm)')
  })

  it('keeps assistant actions visible in flow without hover resizing', () => {
    const reply = css.match(/\.reply \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const actions = css.match(/\.reply > \.response-actions \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]

    expect(reply).not.toContain('padding-bottom')
    expect(actions).toContain('position: static')
    expect(actions).toContain('padding-top: 2px')
    expect(actions).toContain('margin: 0')
    expect(actions).toContain('opacity: 1')
    expect(actions).toContain('pointer-events: auto')
    expect(css).not.toContain('.thread__row:has(> .reply:hover)')
  })

  it('reserves compact prompt action space before hover', () => {
    const actions = css.match(/\.said__actions \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const promptRow = css.match(/\.thread__row:has\(> \.said\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]
    const hoverTail = css.match(/\.said::after \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']

    expect(actions).toContain('top: 100%')
    expect(actions).toContain('padding-top: 1px')
    expect(actions).toContain('margin: 0')
    expect(promptRow).toContain('padding-bottom: 27px')
    expect(hoverTail).toContain('height: 25px')
    expect(css).not.toContain('.thread__row:has(> .said:hover)')
  })

  it('keeps expanded work details close to their summary', () => {
    const summary = css.match(/\.activity__summary \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const body = css.match(/\.activity__body \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']

    expect(summary).toContain('min-height: 30px')
    expect(summary).toContain('padding: 0 2px 4px')
    expect(body).toContain('gap: 10px')
    expect(body).toContain('margin: 4px 0')
  })
})
