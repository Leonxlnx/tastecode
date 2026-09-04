import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = [
  readFileSync(new URL('./app.css', import.meta.url), 'utf8'),
  readFileSync(new URL('./command-palette.css', import.meta.url), 'utf8'),
  readFileSync(new URL('./session-search.css', import.meta.url), 'utf8'),
  readFileSync(new URL('./thread.css', import.meta.url), 'utf8'),
].join('\n')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('keyboard search motion', () => {
  it('keeps keyboard-first surfaces instant', () => {
    expect(rule('.command-palette__scrim')).not.toContain('animation:')
    expect(rule('.command-palette__panel')).not.toContain('animation:')
    expect(rule('.command-palette__item')).not.toContain('transition:')
    expect(rule('.command-palette__item')).not.toContain('animation:')
    expect(rule('.find')).not.toContain('animation:')
  })

  it('keeps only pointer press motion on chat-search rows', () => {
    const result = rule('.session-search__result')

    expect(result).toContain('transition: transform var(--dur-press) var(--ease-out);')
    expect(result).not.toContain('background var(--dur-fast)')
    expect(result).not.toContain('border-color var(--dur-fast)')
    expect(result).not.toContain('box-shadow var(--dur-fast)')
  })

  it('preserves pointer-only generic menu entry motion', () => {
    expect(css).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.menu\.is-positioned\[data-input-modality='pointer'\] \{[\s\S]*?animation: menu-in var\(--dur-fast\) var\(--ease-out\);/s,
    )
  })
})
