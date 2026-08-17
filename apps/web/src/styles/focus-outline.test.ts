import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('focus outline', () => {
  it('does not draw outlines when keyboard input changes focus visibility', () => {
    expect(tokensCss).toMatch(/:focus-visible\s*\{[^}]*outline: none !important;/s)
  })
})
