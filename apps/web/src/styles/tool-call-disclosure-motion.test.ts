import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')

function rule(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body']
}

describe('tool-call disclosure motion', () => {
  it('leaves transcript scroll anchoring to the virtualizer', () => {
    expect(rule('.thread')).toContain('overflow-anchor: none')
  })

  it.each(['activity', 'aux'])(
    'reveals and hides %s details without animating row height',
    (kind) => {
      const reveal = rule(`.${kind}__reveal`)
      const openingReveal = rule(`.${kind}__reveal[data-open='opening']`)
      const openReveal = rule(`.${kind}__reveal[data-open='true']`)
      const closingReveal = rule(`.${kind}__reveal[data-open='closing']`)

      expect(reveal).toContain('display: none')
      expect(reveal).toContain('clip-path: inset(0 0 100%)')
      expect(reveal).toContain('transition: clip-path 180ms cubic-bezier(0.32, 0.72, 0, 1)')
      expect(reveal).not.toContain('grid-template-rows')
      expect(openingReveal).toContain('display: block')
      expect(openingReveal).toContain('clip-path: inset(0)')
      expect(openingReveal).toContain('@starting-style')
      expect(openReveal).toContain('display: block')
      expect(openReveal).toContain('clip-path: inset(0)')
      expect(closingReveal).toContain('position: absolute')
      expect(closingReveal).toContain('transition-duration: 120ms')
    },
  )

  it.each([
    ['opening', '180ms'],
    ['closing', '120ms'],
  ])('slides measured rows and the runway together while %s', (phase, duration) => {
    const scope = `.thread:has(:is(.activity__reveal, .aux__reveal)[data-open='${phase}'])`
    const curve = 'cubic-bezier(0.32, 0.72, 0, 1)'
    const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    expect(
      css.match(
        new RegExp(
          `^${escaped}\\n  :is\\(\\.thread__row, \\.thread__rail\\) \\{(?<body>[\\s\\S]*?)\\n\\}`,
          'm',
        ),
      )?.groups?.['body'],
    ).toContain(`transition: transform ${duration} ${curve}`)
    // The runway is the scroll height. It must follow the rows over the same
    // curve or the scroll end pins (or clamps) in one jump when the last turn
    // is toggled, and anything after the transcript teleports.
    expect(rule(`${scope} .thread__runway`)).toContain(`transition: height ${duration} ${curve}`)
    expect(css).not.toContain('@keyframes disclosure-reveal-out')
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.(?:activity|aux)__reveal,[\s\S]*?transition: none/,
    )
    expect(css).toMatch(
      new RegExp(
        `@media \\(prefers-reduced-motion: reduce\\)[\\s\\S]*?${escaped}\\n    :is\\(\\.thread__row, \\.thread__rail, \\.thread__runway\\)[\\s\\S]*?transition: none`,
      ),
    )
  })

  it('anchors a nested reveal under its own summary', () => {
    expect(rule('.activity__body > :is(.activity, .aux)')).toContain('position: relative')
  })

  it('keeps completed work close to its summary and neighboring items', () => {
    expect(rule('.activity__body')).toContain('gap: 2px')
    expect(rule('.activity__body')).toContain('margin: 4px 0')
    expect(rule('.activity__detail')).toContain('margin: 5px 0 0 21px')
    expect(rule('.reply > .activity')).toContain('margin-bottom: 8px')
  })
})
