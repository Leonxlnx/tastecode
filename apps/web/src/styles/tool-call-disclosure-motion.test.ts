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
      const open = 'var(--dur-fast) var(--ease-out)'
      const close = 'var(--dur-press) var(--ease-out)'
      const reveal = rule(`.${kind}__reveal`)
      const openingReveal = rule(`.${kind}__reveal[data-open='opening']`)
      const openingClip = rule(`.${kind}__reveal[data-open='opening'] > .${kind}__reveal-clip`)
      const openReveal = rule(`.${kind}__reveal[data-open='true']`)
      const closingReveal = rule(`.${kind}__reveal[data-open='closing']`)
      const closingClip = rule(`.${kind}__reveal[data-open='closing'] > .${kind}__reveal-clip`)

      expect(reveal).toContain('display: none')
      expect(reveal).not.toContain('grid-template-rows')
      expect(openingReveal).toContain('display: block')
      expect(openingReveal).toContain('overflow: clip')
      expect(openingReveal).toContain(`transition: transform ${open}`)
      expect(openingReveal).toMatch(/@starting-style \{\s*transform: translateY\(-100%\);/)
      expect(openReveal).toContain('display: block')
      expect(closingReveal).toContain('position: absolute')
      expect(closingReveal).toContain('overflow: clip')
      expect(closingReveal).toContain('transform: translateY(-100%)')
      expect(closingReveal).toContain(`transition: transform ${close}`)
      // The details ride the same clock as the box, 4px short of it, so they
      // settle down out of the summary as they fade in instead of being
      // uncovered at full contrast by a hard moving edge.
      expect(openingClip).toContain(`opacity ${open}`)
      expect(openingClip).toContain(`transform ${open}`)
      expect(openingClip).toMatch(
        /@starting-style \{\s*opacity: 0;\s*transform: translateY\(calc\(100% - 4px\)\);/,
      )
      expect(closingClip).toContain('opacity: 0')
      expect(closingClip).toContain('transform: translateY(calc(100% - 4px))')
      expect(closingClip).toContain(`transform ${close}`)
      // The fade finishes before the retracting edge reaches the last line.
      expect(closingClip).toContain('opacity 100ms var(--ease-out)')
    },
  )

  it('runs every disclosure clock on the tokens Thread.tsx mirrors for its slides', () => {
    const thread = readFileSync(new URL('../ui/Thread.tsx', import.meta.url), 'utf8')
    const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
    const token = (name: string) => tokens.match(new RegExp(`${name}: ([^;]+);`))?.[1]

    expect(thread).toContain(`REVEAL_OPEN_MS = ${Number.parseInt(token('--dur-fast') ?? '')}`)
    expect(thread).toContain(`REVEAL_CLOSE_MS = ${Number.parseInt(token('--dur-press') ?? '')}`)
    expect(thread).toContain(`REVEAL_EASING = '${token('--ease-out')}'`)
    expect(css).toMatch(
      /^\.activity__chevron \{\s*flex: none;\s*transition:\s*transform var\(--dur-fast\) var\(--ease-out\)/m,
    )
  })

  it.each(['activity', 'aux'])(
    'keeps the %s wipe on the compositor so it cannot lag behind the sliding rows',
    (kind) => {
      // clip-path animates on the main thread. The rows below slide on the
      // compositor, so a late main thread (the scroll event after a toggle
      // re-renders the transcript) left the closing box a frame behind the
      // slide, and its background covered the first lines of the text below.
      for (const phase of ['opening', 'true', 'closing']) {
        expect(rule(`.${kind}__reveal[data-open='${phase}']`)).not.toContain('clip-path')
      }
      expect(rule(`.${kind}__reveal`)).not.toContain('clip-path')
      expect(rule(`.${kind}__reveal[data-open='closing']`)).not.toContain('background')
      expect(css).toMatch(
        new RegExp(
          `@media \\(prefers-reduced-motion: reduce\\)[\\s\\S]*?\\.${kind}__reveal > \\.${kind}__reveal-clip[\\s\\S]*?transition: none`,
        ),
      )
    },
  )

  it.each([
    ['opening', 'var(--dur-fast)'],
    ['closing', 'var(--dur-press)'],
  ])('slides measured rows on the reveal clock while %s', (phase, duration) => {
    const scope = `.thread:has(:is(.activity__reveal, .aux__reveal)[data-open='${phase}'])`
    const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    expect(
      css.match(
        new RegExp(
          `^${escaped}\\n  :is\\(\\.thread__row, \\.thread__rail\\) \\{(?<body>[\\s\\S]*?)\\n\\}`,
          'm',
        ),
      )?.groups?.['body'],
    ).toContain(`transition: transform ${duration} var(--ease-out)`)
    // The runway commits its height in one step and Thread.tsx slides what
    // moved on the compositor. A height transition relayouted every frame and
    // left the settled scroll height wrong for its whole duration.
    expect(rule(`${scope} .thread__runway`)).toBeUndefined()
    expect(css).not.toContain('@keyframes disclosure-reveal-out')
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.(?:activity|aux)__reveal,[\s\S]*?transition: none/,
    )
    expect(css).toMatch(
      new RegExp(
        `@media \\(prefers-reduced-motion: reduce\\)[\\s\\S]*?${escaped}\\n    :is\\(\\.thread__row, \\.thread__rail\\)[\\s\\S]*?transition: none`,
      ),
    )
  })

  it.each(['activity', 'aux'])('still fades %s details in under reduced motion', (kind) => {
    expect(css).toMatch(
      new RegExp(
        `@media \\(prefers-reduced-motion: reduce\\)[\\s\\S]*?\\.${kind}__reveal\\[data-open='true'\\] > \\.${kind}__reveal-clip[\\s\\S]*?transition: opacity var\\(--dur-fast\\) var\\(--ease-out\\) !important;\\s*@starting-style \\{\\s*opacity: 0;`,
      ),
    )
  })

  it('keeps content after a closing nested reveal visible while it slides up', () => {
    // It starts below the open box's new bottom edge, so neither the clip box
    // nor the open reveal may cut it off.
    const clip = rule('.activity__reveal-clip')
    expect(clip).not.toMatch(/overflow(-y)?: hidden/)
    expect(clip).toContain('overflow-x: clip')
    expect(clip).toContain('display: flow-root')
    expect(rule(".activity__reveal[data-open='true']")).not.toMatch(/overflow(-y)?: (hidden|clip)/)
  })

  it('holds a revealed image preview at its final height while it loads', () => {
    // The reveal is measured once as it opens; a preview that settled to a
    // different height resized it mid-wipe and threw the rows below off.
    expect(rule('.viewed-image-preview')).toContain('--viewed-image-frame-h: 180px')
    expect(rule('.viewed-image-preview__open')).toContain('height: var(--viewed-image-frame-h)')
    expect(
      rule(
        '.viewed-image-preview:not(.viewed-image-preview--message) > .viewed-image-preview__placeholder',
      ),
    ).toContain('height: var(--viewed-image-frame-h)')
  })

  it('anchors a nested reveal under its own summary', () => {
    expect(rule('.activity__body > :is(.activity, .aux)')).toContain('position: relative')
  })

  it('keeps completed work close to its summary and neighboring items', () => {
    expect(rule('.activity__body')).toContain('gap: 2px')
    expect(rule('.activity__body')).toContain('margin: 4px 0')
    expect(rule('.activity__body .aux__out')).toContain('margin: 3px 0 6px 21px')
    expect(rule('.reply > .activity')).toContain('margin-bottom: 8px')
  })
})
