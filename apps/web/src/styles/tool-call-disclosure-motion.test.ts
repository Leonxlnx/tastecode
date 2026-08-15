import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body']
}

describe('tool-call disclosure motion', () => {
  it('leaves transcript scroll anchoring to the virtualizer', () => {
    expect(rule('.thread')).toContain('overflow-anchor: none')
  })

  it.each(['activity', 'aux'])('reveals %s details without animating row height', (kind) => {
    const reveal = rule(`.${kind}__reveal`)
    const openReveal = rule(`.${kind}__reveal[data-open='true']`)
    const openClip = rule(`.${kind}__reveal[data-open='true'] > .${kind}__reveal-clip`)

    expect(reveal).toContain('display: none')
    expect(reveal).not.toContain('grid-template-rows')
    expect(reveal).not.toContain('transition:')
    expect(openReveal).toContain('display: block')
    expect(openClip).toContain('animation: disclosure-reveal-in var(--dur-fast) var(--ease-out)')
  })

  it('keeps completed work close to its summary and neighboring items', () => {
    expect(rule('.activity__body')).toContain('gap: 10px')
    expect(rule('.activity__body')).toContain('margin: 4px 0')
    expect(rule('.activity__detail')).toContain('margin: 5px 0 0 21px')
    expect(rule('.reply > .activity')).toContain('margin-bottom: 8px')
  })
})
