import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')

describe('GitHub avatar CSP', () => {
  it('allows the avatar CDN for images without granting it API access', () => {
    const policy = /content="(default-src[^\"]+)"/.exec(html)?.[1] ?? ''
    const directives = new Map(
      policy.split(';').map((directive) => {
        const [name = '', ...sources] = directive.trim().split(/\s+/)
        return [name, sources]
      }),
    )

    expect(directives.get('img-src')).toContain('https://avatars.githubusercontent.com')
    expect(directives.get('connect-src')).not.toContain('https://avatars.githubusercontent.com')
  })
})
