import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')

function rule(selector: string, source = css): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`^\\s*${escaped} \\{(?<body>[\\s\\S]*?)\\n\\s*\\}`, 'm'))
    ?.groups?.['body']
}

describe('working pulse', () => {
  it('breathes with transform and opacity only, so it stays on the compositor', () => {
    expect(rule('.activity__pulse')).toContain('animation: working-pulse 1.6s')
    const keyframes = css.match(/@keyframes working-pulse \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]
    expect(keyframes).toBeDefined()
    const properties = Array.from(keyframes!.matchAll(/^\s*([a-z-]+):/gm), (match) => match[1])
    expect(new Set(properties)).toEqual(new Set(['opacity', 'transform']))
  })

  it('stands still under reduced motion', () => {
    const reduced = Array.from(
      css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{(?<body>[\s\S]*?)\n\}/g),
      (match) => match.groups?.['body'] ?? '',
    ).join('\n')
    const pulse = rule('.activity__pulse', reduced)
    expect(pulse).toContain('animation: none')
    expect(pulse).toContain('opacity: 0.6')
  })
})
