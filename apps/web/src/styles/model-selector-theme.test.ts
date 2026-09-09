import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modelSelectorCss = [
  readFileSync(new URL('./model-selector.css', import.meta.url), 'utf8'),
  readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8'),
].join('\n')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const modelSelectorSource = readFileSync(
  new URL('../ui/ModelSelector.tsx', import.meta.url),
  'utf8',
)

describe('model selector theme CSS', () => {
  it('keeps the sticky model header opaque in light mode', () => {
    expect(tokensCss).toMatch(
      /:root\[data-theme='light'\] \{[^}]*--model-picker-title-bg: var\(--model-picker-bg\);/s,
    )
    expect(modelSelectorCss).toMatch(
      /\.model-selector__group-head \{[^}]*position: sticky;[^}]*background: var\(--model-picker-title-bg\);/s,
    )
  })

  it('pins the rail header at its resting inset while models scroll', () => {
    expect(modelSelectorCss).toMatch(
      /\.model-selector__group-head \{[^}]*top: 0;[^}]*margin-inline: -4px;[^}]*padding: 2px 8px 4px 12px;/s,
    )
  })

  it('uses the shared control motion for provider selection', () => {
    expect(modelSelectorCss).toMatch(
      /\.model-selector__provider \{[^}]*transition:[^}]*background var\(--dur-fast\) var\(--ease-out\),[^}]*box-shadow var\(--dur-fast\) var\(--ease-out\),[^}]*color var\(--dur-fast\) var\(--ease-out\);/s,
    )
    expect(modelSelectorCss).not.toContain('model-provider-pop')
  })

  it('aligns the picker right edge with its trigger', () => {
    const menu = modelSelectorCss.match(/\.model-selector__menu \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]

    expect(modelSelectorSource).toMatch(/<Menu\s+align="right"/)
    expect(menu).not.toContain('translate:')
    expect(menu).not.toContain('transform:')
  })
})
