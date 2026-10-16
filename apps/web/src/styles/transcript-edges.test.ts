import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

// Every transcript row starts its first glyph on the reply text edge.
describe('transcript row edges', () => {
  it('starts an activity summary on the text edge with or without its icon', () => {
    const summary = rule('.activity__summary')
    // -3.5px + 2px padding + 1.5px inside the 18px icon box = the text edge.
    expect(summary).toContain('margin-left: -3.5px;')
    expect(summary).toContain('padding: 0 2px 4px;')
    expect(rule('.activity__glyph')).toContain('width: 18px;')
    // Without the icon box: -2px + 2px padding = the text edge.
    expect(rule('.activity__summary--bare')).toContain('margin-left: -2px;')
  })

  it('opens every tool output under its row label', () => {
    const px = (body: string, property: string) =>
      Number.parseFloat(body.match(new RegExp(`${property}: (-?[\\d.]+)px`))?.[1] ?? 'NaN')
    const row = rule('.aux__row')
    // padding: 0 <inline> <bottom>
    const padding = Number.parseFloat(row.match(/padding: 0 ([\d.]+)px/)?.[1] ?? 'NaN')
    const labelX =
      px(row, 'margin-left') + padding + px(rule('.aux__glyph'), 'width') + px(row, 'gap')
    expect(rule('.thread__col')).toContain(`--tool-label-x: ${labelX}px;`)
    expect(labelX).toBe(22.5)

    expect(rule('.aux__out')).toContain('margin: 8px 0 2px var(--tool-label-x);')
    expect(rule('.activity__body .aux__out')).toContain('margin: 3px 0 6px var(--tool-label-x);')
    expect(rule('.aux--reasoning .reasoning-summary')).toContain(
      'margin: 8px 0 2px var(--tool-label-x);',
    )
    expect(rule('.viewed-image-preview')).toContain('margin: 7px 0 2px var(--tool-label-x);')
    expect(rule('.viewed-image-preview')).toContain(
      'width: min(320px, calc(100% - var(--tool-label-x)));',
    )
    // A live output used its own 32px and jumped left when its tool finished.
    expect(css).not.toMatch(/\.aux--live \.aux__out \{/)
  })

  it('runs a reasoning summary to the column edge like a reply', () => {
    expect(rule('.reasoning-summary')).not.toContain('max-width')
  })
})
