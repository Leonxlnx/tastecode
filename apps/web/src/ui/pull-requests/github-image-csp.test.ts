import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')
const policy = /content="(default-src[^"]+)"/.exec(html)?.[1] ?? ''
const directives = new Map(
  policy.split(';').map((directive) => {
    const [name = '', ...sources] = directive.trim().split(/\s+/)
    return [name, sources]
  }),
)

describe('GitHub Markdown image CSP', () => {
  it.each([
    'https://github.com',
    'https://raw.githubusercontent.com',
    'https://media.githubusercontent.com',
    'https://user-images.githubusercontent.com',
    'https://private-user-images.githubusercontent.com',
    'https://camo.githubusercontent.com',
  ])('allows %s only for image loads', (origin) => {
    expect(directives.get('img-src')).toContain(origin)
    for (const [name, sources] of directives) {
      if (name !== 'img-src') expect(sources).not.toContain(origin)
    }
  })

  it('does not grant arbitrary remote image or script access', () => {
    expect(directives.get('img-src')).not.toEqual(expect.arrayContaining(['*']))
    expect(directives.get('img-src')).not.toContain('https:')
    expect(directives.get('default-src')).toEqual(["'self'"])
    expect(directives.get('connect-src')).toEqual(["'self'", '__HARNESS_SERVER_ORIGIN__'])
  })
})
