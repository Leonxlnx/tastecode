import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

describe('attachment preview CSP', () => {
  it('limits the signed native scheme to image and media elements', () => {
    const policy = /content="(default-src[^"]+)"/.exec(html)?.[1] ?? ''
    const directives = new Map(
      policy.split(';').map((directive) => {
        const [name = '', ...sources] = directive.trim().split(/\s+/)
        return [name, sources]
      }),
    )

    expect(directives.get('img-src')).toContain('tastecode-attachment:')
    expect(directives.get('media-src')).toContain('tastecode-attachment:')
    expect(directives.get('connect-src')).not.toContain('tastecode-attachment:')
  })
})
