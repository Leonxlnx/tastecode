import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const lightThemeStart = tokensCss.indexOf(":root[data-theme='light']")
const darkTokens = tokensCss.slice(0, lightThemeStart)
const lightTokens = tokensCss.slice(lightThemeStart)

describe('composer placeholder contrast', () => {
  it('stays readable against the prompt in both themes', () => {
    expect(
      contrast(token(darkTokens, 'composer-placeholder'), token(darkTokens, 'bg-prompt')),
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrast(token(lightTokens, 'composer-placeholder'), token(lightTokens, 'bg-prompt')),
    ).toBeGreaterThanOrEqual(4.5)
  })
})

function token(source: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(source)?.[1]
  if (!value) throw new Error(`missing hexadecimal token --${name}`)
  return value
}

function contrast(left: string, right: string): number {
  const darker = Math.min(luminance(left), luminance(right))
  const lighter = Math.max(luminance(left), luminance(right))
  return (lighter + 0.05) / (darker + 0.05)
}

function luminance(hex: string): number {
  const channel = (start: number) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}
