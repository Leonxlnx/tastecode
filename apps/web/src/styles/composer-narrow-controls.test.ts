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
  it('keeps the add button, the option chips and the provider mark at their size', () => {
    expect(
      rule(
        appCss,
        '.tools > .composer__add,\n.tools > .composer__dictation-options:not([data-hidden]),\n.model-selector__trigger-model > svg',
      ),
    ).toContain('flex-shrink: 0;')
  })

  it('draws icon-only chips as squares the size of Add, one gap apart', () => {
    // The chips were 34px wide beside the 32px Add button, and their own
    // wrapper kept an 8px gap while the row around them used 4px.
    const compact = (
      appCss.match(/@container chat-stage \(max-width: 620px\) \{[\s\S]*?\n\}/)?.[0] ?? ''
    ).replaceAll('\n  ', '\n')
    expect(rule(compact, '.tools,\n.composer__dictation-options-content')).toContain('gap: 6px;')
    expect(
      rule(compact, '.tools .composer__permission,\n.tools .composer__design-button-beam'),
    ).toContain('width: var(--composer-control, 32px);')
    expect(rule(appCss, '.tools .composer__add')).toContain('width: 32px;')
    expect(appCss).toMatch(/\.tools \{\s*--composer-control: 34px;/)
  })

  it('keeps the model trigger inside its shrinking wrapper', () => {
    expect(rule(triggerCss, '.menutrigger--model-selector')).toContain(
      'max-width: min(290px, 42vw, 100%);',
    )
  })

  it('truncates the model name with an ellipsis', () => {
    const truncating = rule(
      triggerCss,
      '.model-selector__trigger-model,\n.model-selector__trigger-name,\n.model-selector__trigger-short,\n.model-selector__trigger-effort',
    )
    expect(truncating).toContain('overflow: hidden;')
    expect(truncating).toContain('text-overflow: ellipsis;')
  })

  it('shrinks the effort before the model name, and never below its first letter', () => {
    expect(rule(triggerCss, '.model-selector__trigger-model')).toContain('flex: 0 1 auto;')
    // Its own rule, not the shared truncation rule whose selector list ends with it.
    const effort =
      triggerCss.match(/\*\/\n\.model-selector__trigger-effort \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
        'body'
      ] ?? ''
    expect(effort).toContain('flex: 0 1000 auto;')
    expect(effort).toContain('min-width: 3ch;')
  })

  // A ~300px composer showed "G L…"; there the button is the provider icon and "Luna".
  it('shows the short model name and leaves the effort to the menu in a narrow column', () => {
    const narrow =
      /@container chat-stage \(max-width: 620px\) \{(?<body>[\s\S]*?)\n\}\n/.exec(triggerCss)
        ?.groups?.['body'] ?? ''
    expect(narrow).toMatch(
      /\.model-selector__trigger-name,\s*\.model-selector__trigger-effort \{\s*display: none;/,
    )
    expect(narrow).toMatch(/\.model-selector__trigger-short \{\s*display: inline;/)
    expect(rule(triggerCss, '.model-selector__trigger-short')).toContain('display: none;')
  })

  it('shows no effort level dots', () => {
    expect(appCss).not.toContain('model-selector__trigger-level')
    expect(triggerCss).not.toContain('model-selector__trigger-level')
    expect(triggerCss).not.toContain('model-selector__trigger-dot')
  })
})
