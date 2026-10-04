import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('composer voice button', () => {
  it('keeps the idle dictation control free of a circular surface', () => {
    expect(css).toMatch(
      /\.icon-btn\.composer-voice-button \{[^}]*background: none;[^}]*border: 0;[^}]*box-shadow: none;/s,
    )
    expect(css).toMatch(
      /\.tools \.icon-btn\.composer-voice-button:is\(:hover, :focus-visible\) \{[^}]*background: none;[^}]*border-color: transparent;[^}]*box-shadow: none;/s,
    )
  })
})
