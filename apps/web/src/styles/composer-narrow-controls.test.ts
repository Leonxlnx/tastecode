import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const triggerCss = readFileSync(new URL('./model-selector.css', import.meta.url), 'utf8')

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^\\s*${escaped} \\{(?<body>[\\s\\S]*?)\\n\\s*\\}`, 'm'))?.groups?.[
      'body'
    ] ?? ''
  )
}

/*
 * With the Browser panel open the chat column is about 360px wide. Every child
 * of the tools row may shrink (min-width: 0), so the options clip shrank below
 * its chips and cut the Design chip, and the model trigger, held at
 * min(270px, 42vw) by its own max-width, ran 12px under Send.
 */
describe('composer controls in a narrow chat column', () => {
  it('keeps the add button and the permission and Design chips at their size', () => {
    expect(
      rule(
        appCss,
        '.tools > .composer__add,\n.tools > .composer__dictation-options:not([data-hidden])',
      ),
    ).toContain('flex-shrink: 0;')
  })

  it('keeps the model trigger inside its shrinking wrapper', () => {
    expect(rule(triggerCss, '.menutrigger--model-selector')).toContain(
      'max-width: min(270px, 42vw, 100%);',
    )
  })

  it('truncates the model name next to a fixed provider mark', () => {
    expect(rule(triggerCss, '.model-selector__trigger-model > *')).toContain('flex: none;')
    const name = rule(triggerCss, '.model-selector__trigger-model > .model-selector__trigger-name')
    expect(name).toContain('min-width: 0;')
    expect(name).toContain('text-overflow: ellipsis;')
  })

  it('lets the level dots carry the effort alone below 420px', () => {
    const narrow =
      triggerCss.match(/@container chat-stage \(max-width: 420px\) \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(
      rule(narrow, '.model-selector__trigger-level + .model-selector__trigger-effort'),
    ).toContain('display: none;')
  })
})
