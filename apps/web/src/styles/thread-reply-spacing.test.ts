import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('thread reply spacing', () => {
  it('overlays response actions without reserving an empty row below every reply', () => {
    const reply = css.match(/\.reply \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const actions = css.match(/\.reply > \.response-actions \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]

    expect(reply).not.toContain('padding-bottom')
    expect(actions).toContain('top: 100%')
    expect(actions).not.toContain('bottom: 0')
  })
})
