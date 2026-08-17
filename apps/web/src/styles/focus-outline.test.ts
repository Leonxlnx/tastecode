import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('focus outline', () => {
  it('does not globally suppress keyboard focus indicators', () => {
    expect(tokensCss).not.toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*(?:none|0)(?:\s*!important)?\s*;/s,
    )
  })
})
